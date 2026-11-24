// Compare PRT with transit, car and bike on the SAME trips.
//
// Runs the PRT simulation, then gives each simulated trip a real starting and
// ending census block (within the stations' walking areas, weighted by people
// + jobs) and times that same block-to-block trip by:
//   - PRT: walk (or bike) to the station + simulated wait and ride + walk/bike
//   - transit: Metro Transit's weekday schedule (GTFS), leaving at the rider's
//     request time; also the best case of leaving at the ideal moment
//   - car: the travel survey's median door-to-door car time for that distance
//     (driving is the majority mode, so this is little self-selected)
//   - bike: street distance (1.3 x straight line) at 16 km/h + 1 min
//
// Usage: node scripts/compare-modes.mjs [minutes] [sim options...] date=YYYYMMDD
// Needs data/raw/gtfs (scripts/fetch-gtfs.sh) and the travel survey.

import fs from 'node:fs';
import { Sim } from '../src/sim.js';
import { project } from '../src/geo.js';
import { csvRows } from './csv.mjs';
import { loadTransit, transitTime } from './transit.mjs';

const args = process.argv.slice(2);
const minutes = Number(args.find((a) => !a.includes('=')) ?? 60);
const opts = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => a.split('=')).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]));
const date = String(opts.date || '20261202');
delete opts.date;
const maxTrips = opts.maxTrips || 1500;
delete opts.maxTrips;
opts.demandModel = true;
opts.demandData = JSON.parse(fs.readFileSync(new URL('../data/demand-tbi.json', import.meta.url)));
opts.hourFrom ??= 16;
opts.hourTo ??= opts.hourFrom + 1;
const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const raw = (p) => new URL(`../data/raw/${p}`, import.meta.url);

// --- blocks and station catchments
const blocks = [];
const bi = new Map();
for await (const r of csvRows(raw('lodes/mn_xwalk.csv.gz'))) {
  if (!r.stplcname.startsWith('Minneapolis city')) continue;
  bi.set(r.tabblk2020, blocks.length);
  blocks.push({ p: project([Number(r.blklondd), Number(r.blklatdd)]), w: 0 });
}
for await (const r of csvRows(raw('pl2020/hennepin_block_pop.csv'))) if (bi.has(r.block)) blocks[bi.get(r.block)].w += Number(r.pop);
for await (const r of csvRows(raw('lodes/mn_wac_S000_JT00_2022.csv.gz'))) if (bi.has(r.w_geocode)) blocks[bi.get(r.w_geocode)].w += Number(r.C000);
const catchment = net.stations.map(() => []);
for (const b of blocks) {
  if (!b.w) continue;
  let best = -1;
  let bd = Infinity;
  net.stations.forEach((s, i) => {
    const d = Math.hypot(s.x - b.p[0], s.y - b.p[1]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  b.station = best;
  b.dist = bd;
  catchment[best].push(b);
}
let rnd = 4242;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const pickBlock = (sid) => {
  const c = catchment[sid];
  if (!c.length) return { p: [net.stations[sid].x, net.stations[sid].y], dist: 0 };
  let tot = c.reduce((a, b) => a + b.w, 0) * rand();
  for (const b of c) if ((tot -= b.w) <= 0) return b;
  return c[c.length - 1];
};

// --- car benchmark: survey median door-to-door minutes by straight-line distance
const carBins = new Map();
for await (const r of csvRows(raw('tbi2023/data/linked_trip.csv'))) {
  const w = Number(r.linked_trip_weight || 0);
  if (!(w > 0) || r.trip_o_city !== 'Minneapolis' || r.trip_d_city !== 'Minneapolis' || r.mode_type_broad !== 'Personal Vehicle') continue;
  const km = (Number(r.distance_miles) * 1.609) / 1.3;
  const m = Number(r.duration_minutes);
  if (!(m > 0) || m > 120 || !(km > 0)) continue;
  const k = Math.min(30, Math.floor(km * 2)); // half-km bins
  if (!carBins.has(k)) carBins.set(k, []);
  carBins.get(k).push([m, w]);
}
const wmed = (xs) => {
  const s = [...xs].sort((a, b) => a[0] - b[0]);
  const tot = s.reduce((a, x) => a + x[1], 0);
  let acc = 0;
  for (const [v, w] of s) if ((acc += w) >= tot / 2) return v;
  return null;
};
const carMed = new Map([...carBins].map(([k, v]) => [k, wmed(v)]));
const carMinutes = (km) => {
  let k = Math.min(30, Math.floor(km * 2));
  while (k > 0 && !carMed.has(k)) k--;
  return carMed.get(k);
};

// --- run PRT
const sim = new Sim(net, opts);
const steps = Math.round((minutes * 60) / sim.p.dt);
for (let i = 0; i < steps; i++) sim.step();
const ACC = { walk: 1.3, bike: 4.5, bikeOverhead: 30, bikeDwell: 20 };
const T = await loadTransit(new URL('../data/raw/gtfs', import.meta.url).pathname, date, opts.hourFrom * 3600 - 1800, opts.hourTo * 3600 + 7200);

const trips = sim.tripLog.filter((t) => t[7] > 600); // skip the first 10 minutes
const sample = trips.length > maxTrips ? trips.filter(() => rand() < maxTrips / trips.length) : trips;
const rows = [];
for (const [, wait, ride, , , o, d, t0] of sample) {
  const A = pickBlock(o);
  const B = pickBlock(d);
  const km = Math.hypot(A.p[0] - B.p[0], A.p[1] - B.p[1]) / 1000;
  const accW = ((A.dist + B.dist) * 1.25) / ACC.walk;
  const accB = ((A.dist + B.dist) * 1.25) / ACC.bike + 2 * (ACC.bikeOverhead + ACC.bikeDwell);
  const dep = opts.hourFrom * 3600 + t0;
  const tr = transitTime(T, A.p, B.p, dep);
  let trBest = tr;
  for (let k = 1; k <= 10; k++) trBest = Math.min(trBest, transitTime(T, A.p, B.p, dep + k * 180) );
  rows.push({ km, prtWalk: (accW + wait + ride) / 60, prtBike: (accB + wait + ride) / 60, transit: tr / 60, transitTimed: trBest / 60, car: carMinutes(km), bike: (km * 1300) / ACC.bike / 60 + 1 });
}
const bands = [
  [0.5, 2],
  [2, 3],
  [3, 5],
  [5, 8],
  [8, 20],
];
const med = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};
const f = (x) => (x == null ? '    –' : x.toFixed(1).padStart(5));
console.log(`${rows.length} trips, 4-5 PM-style demand from ${opts.hourFrom}:00, transit schedule for ${date}`);
console.log('Median door-to-door minutes on the same block-to-block trips:');
console.log('distance    PRT walk  PRT bike  transit  transit*  car    bike   trips   PRT(walk) beats transit');
for (const [a, b] of bands) {
  const r = rows.filter((x) => x.km >= a && x.km < b);
  const beat = r.filter((x) => x.prtWalk < x.transit).length / (r.length || 1);
  console.log(`${`${a}-${b} km`.padEnd(10)} ${f(med(r.map((x) => x.prtWalk)))}    ${f(med(r.map((x) => x.prtBike)))}    ${f(med(r.map((x) => x.transit)))}   ${f(med(r.map((x) => x.transitTimed)))}  ${f(med(r.map((x) => x.car)))}  ${f(med(r.map((x) => x.bike)))}  ${String(r.length).padStart(5)}   ${(100 * beat).toFixed(0)}%`);
}
const all = (k) => med(rows.map((x) => x[k]));
console.log(`${'all'.padEnd(10)} ${f(all('prtWalk'))}    ${f(all('prtBike'))}    ${f(all('transit'))}   ${f(all('transitTimed'))}  ${f(all('car'))}  ${f(all('bike'))}  ${String(rows.length).padStart(5)}   ${((100 * rows.filter((x) => x.prtWalk < x.transit).length) / rows.length).toFixed(0)}%`);
console.log('transit* = leaving at the best moment within the next 30 minutes (timed to the schedule)');
