// Build all-purpose trip demand for Minneapolis from the Met Council's 2023
// Travel Behavior Inventory (TBI) household survey.
//
// The public survey gives each trip's ends as a census block group. A block
// group is a few city blocks, so each end is spread over the blocks inside it,
// weighted by what is there for that trip's purpose: population for home,
// retail jobs for shopping, restaurant jobs for meals, and so on. Each block
// then maps to its nearest station.
//
// Inputs (all under data/raw, not committed):
//   tbi2023/data/linked_trip.csv   TBI 2023 cleansed data, from the
//     Transportation Secure Data Center, National Laboratory of the Rockies
//     (formerly NREL). Free after a one-time registration; see docs/data-sources.md.
//   lodes/mn_xwalk.csv.gz, lodes/mn_wac_S000_JT00_2022.csv.gz   scripts/fetch-lodes.sh
//   pl2020/hennepin_block_pop.csv  scripts/fetch-census-pop.sh
//
// Output: data/demand-tbi.json, kept out of git because it's derived from
// the TSDC data (whose agreement requires its notice on every copy).
// od rows are [origin station, destination station, depart hour, weekday trips].

import fs from 'node:fs';
import { project } from '../src/geo.js';
import { csvRows } from './csv.mjs';

const raw = (p) => new URL(`../data/raw/${p}`, import.meta.url);
const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const MIN_TRIP = 700; // metres between stations; anything shorter is a walk

// ---- blocks ----------------------------------------------------------------
const blocks = new Map(); // block -> {bg, station, pop, jobs...}
const stations = net.stations.map((s) => [s.x, s.y]);
for await (const r of csvRows(raw('lodes/mn_xwalk.csv.gz'))) {
  if (!r.stplcname.startsWith('Minneapolis city')) continue;
  const [x, y] = project([Number(r.blklondd), Number(r.blklatdd)]);
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < stations.length; i++) {
    const d = Math.abs(stations[i][0] - x) + Math.abs(stations[i][1] - y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  blocks.set(r.tabblk2020, { bg: r.bgrp, station: best, pop: 0, C000: 0, CNS07: 0, CNS15: 0, CNS16: 0, CNS17: 0, CNS18: 0, CNS19: 0 });
}
for await (const r of csvRows(raw('pl2020/hennepin_block_pop.csv'))) {
  const b = blocks.get(r.block);
  if (b) b.pop = Number(r.pop);
}
for await (const r of csvRows(raw('lodes/mn_wac_S000_JT00_2022.csv.gz'))) {
  const b = blocks.get(r.w_geocode);
  if (b) for (const k of ['C000', 'CNS07', 'CNS15', 'CNS16', 'CNS17', 'CNS18', 'CNS19']) b[k] = Number(r[k]);
}

// What attracts each kind of trip end. CNS codes are LODES job sectors:
// 07 retail, 15 education, 16 health care, 17 arts & recreation,
// 18 accommodation & food, 19 other services.
const attract = {
  Home: (b) => b.pop,
  Overnight: (b) => b.pop,
  Work: (b) => b.C000,
  'Work related': (b) => b.C000,
  School: (b) => b.CNS15,
  'School related': (b) => b.CNS15,
  Shopping: (b) => b.CNS07,
  Meal: (b) => b.CNS18,
  'Social/Recreation': (b) => b.CNS17 + b.CNS18 + 0.5 * b.pop,
  Errand: (b) => b.CNS07 + b.CNS16 + b.CNS19,
  Escort: (b) => b.pop + b.CNS15,
};
const general = (b) => b.pop + b.C000;
const weightFor = (purpose, b) => (attract[purpose] || general)(b) + 0.01 * general(b) + 1e-3;

// Station shares within each block group, per purpose (memoized).
const bgBlocks = new Map();
for (const b of blocks.values()) {
  if (!bgBlocks.has(b.bg)) bgBlocks.set(b.bg, []);
  bgBlocks.get(b.bg).push(b);
}
const shareCache = new Map();
function shares(bg, purpose) {
  const key = `${bg}|${purpose}`;
  if (shareCache.has(key)) return shareCache.get(key);
  const list = bgBlocks.get(bg);
  let out = null;
  if (list) {
    const m = new Map();
    let tot = 0;
    for (const b of list) {
      const w = weightFor(purpose, b);
      m.set(b.station, (m.get(b.station) || 0) + w);
      tot += w;
    }
    out = [...m].map(([s, w]) => [s, w / tot]);
  }
  shareCache.set(key, out);
  return out;
}

// ---- trips ------------------------------------------------------------------
const hourOf = (h) => {
  const m = /^(\d+)(AM|PM)$/.exec(h || '');
  if (!m) return -1;
  return (Number(m[1]) % 12) + (m[2] === 'PM' ? 12 : 0);
};
const bgOf = (s) => (s || '').replace(/\.0$/, '');
const od = new Map();
// Smoothed model inputs: trips by hour x origin purpose x destination purpose,
// and trip-length (station to station) by destination purpose.
const T = new Map(); // "h|op|dp" -> trips
const distSum = {};
const distW = {};
const byHour = new Array(24).fill(0);
const tot = { records: 0, weighted: 0, noLocation: 0, walk: 0, prt: 0, byPurpose: {}, byMode: {} };
const add = (o, k, w) => (o[k] = (o[k] || 0) + w);

for await (const r of csvRows(raw('tbi2023/data/linked_trip.csv'))) {
  const w = Number(r.linked_trip_weight || 0);
  if (!(w > 0)) continue;
  if (r.trip_o_city !== 'Minneapolis' || r.trip_d_city !== 'Minneapolis') continue;
  const h = hourOf(r.depart_hour);
  tot.records++;
  tot.weighted += w;
  const so = shares(bgOf(r.trip_o_cbg_2020), r.o_purpose_category);
  const sd = shares(bgOf(r.trip_d_cbg_2020), r.d_purpose_category);
  if (!so || !sd || h < 0) {
    tot.noLocation += w;
    continue;
  }
  for (const [o, po] of so)
    for (const [d, pd] of sd) {
      const ww = w * po * pd;
      const a = net.stations[o];
      const b = net.stations[d];
      if (Math.hypot(a.x - b.x, a.y - b.y) < MIN_TRIP) {
        tot.walk += ww;
        continue;
      }
      tot.prt += ww;
      byHour[h] += ww;
      add(tot.byPurpose, r.d_purpose_category, ww);
      add(tot.byMode, r.mode_type_broad, ww);
      const tk = `${h}|${r.o_purpose_category}|${r.d_purpose_category}`;
      T.set(tk, (T.get(tk) || 0) + ww);
      add(distSum, r.d_purpose_category, ww * Math.hypot(a.x - b.x, a.y - b.y));
      add(distW, r.d_purpose_category, ww);
      const k = `${o},${d},${h}`;
      od.set(k, (od.get(k) || 0) + ww);
    }
}

// ---- smoothed model ----------------------------------------------------------
// Station attraction per purpose: sum of block weights at each station.
const purposes = [...new Set([...T.keys()].flatMap((k) => k.split('|').slice(1)))].sort();
const S = net.stations.length;
const attraction = {};
for (const p of purposes) {
  const a = new Array(S).fill(0);
  for (const b of blocks.values()) a[b.station] += weightFor(p, b);
  attraction[p] = a.map((x) => Math.round(x * 100) / 100);
}
const activity = new Array(S).fill(0);
for (const b of blocks.values()) activity[b.station] += b.pop + b.C000;
const dist = (i, j) => Math.hypot(net.stations[i].x - net.stations[j].x, net.stations[i].y - net.stations[j].y);
// Fit exponential distance decay (per km) for each destination purpose so the
// model's mean trip length matches the survey's.
function meanDist(beta, A) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < S; i++) {
    if (!activity[i]) continue;
    let n = 0;
    let d = 0;
    for (let j = 0; j < S; j++) {
      const dij = dist(i, j);
      if (dij < MIN_TRIP) continue;
      const w = A[j] * Math.exp((-beta * dij) / 1000);
      n += w * dij;
      d += w;
    }
    if (d) {
      num += (activity[i] * n) / d;
      den += activity[i];
    }
  }
  return num / den;
}
const beta = {};
const targetKm = {};
for (const p of purposes) {
  const target = distW[p] ? distSum[p] / distW[p] : null;
  if (!target || distW[p] < 5000) continue; // too few trips to fit; falls back to the pooled value
  targetKm[p] = Math.round(target) / 1000;
  let lo = 0;
  let hi = 3;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (meanDist(mid, attraction[p]) > target) lo = mid;
    else hi = mid;
  }
  beta[p] = Math.round(((lo + hi) / 2) * 1000) / 1000;
}
const pooled = Object.values(beta).reduce((a, b) => a + b, 0) / Object.values(beta).length;
for (const p of purposes) if (beta[p] === undefined) beta[p] = Math.round(pooled * 1000) / 1000;
console.log('mean trip km by purpose (survey):', targetKm);
console.log('distance decay per km:', beta);

const round = (x) => Math.round(x);
const out = {
  stations: net.stations.length, // the network this table was built for
  source: 'Met Council 2023 Travel Behavior Inventory (cleansed), via the Transportation Secure Data Center, National Laboratory of the Rockies (formerly NREL), for DOE; 2020 Census block population; LEHD LODES 2022 jobs by sector.',
  note: 'Average weekday (Tue-Thu) trips with both ends in Minneapolis. Trips between stations under 700 m apart are left out as walks.',
  totals: {
    surveyRecords: tot.records,
    weekdayTrips: round(tot.weighted),
    unlocated: round(tot.noLocation),
    walkLength: round(tot.walk),
    prtLength: round(tot.prt),
    byPurpose: Object.fromEntries(Object.entries(tot.byPurpose).map(([k, v]) => [k, round(v)]).sort((a, b) => b[1] - a[1])),
    byCurrentMode: Object.fromEntries(Object.entries(tot.byMode).map(([k, v]) => [k, round(v)]).sort((a, b) => b[1] - a[1])),
  },
  byHour: byHour.map(round),
  od: [...od].map(([k, w]) => [...k.split(',').map(Number), Math.round(w * 100) / 100]),
  model: {
    minTripMeters: MIN_TRIP,
    purposes,
    attraction,
    beta,
    // [hour, origin purpose index, destination purpose index, weekday trips]
    trips: [...T].map(([k, w]) => {
      const [h, op, dp] = k.split('|');
      return [Number(h), purposes.indexOf(op), purposes.indexOf(dp), Math.round(w)];
    }).filter((x) => x[3] > 0),
  },
};
fs.writeFileSync(new URL('../data/demand-tbi.json', import.meta.url), JSON.stringify(out));
console.log(JSON.stringify({ ...out.totals, byHour: out.byHour, odRows: out.od.length }, null, 2));
