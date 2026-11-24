// Car trips as a signal of desired travel: take every surveyed car trip with
// both ends in Minneapolis, place its ends in census blocks inside its block
// groups (weighted by people + jobs), and time the same trip, at the same time
// of day, by transit (real schedule) and by PRT. How many of the trips people
// make by car would still be reasonable without one?
//
// PRT here is estimated from free-flow routes (walk + 1 min wait + boarding and
// getting off + route time), not simulated; at busy hours real waits and rides
// run a few minutes longer.
import fs from 'node:fs';
import { Sim } from '../src/sim.js';
import { project } from '../src/geo.js';
import { csvRows } from './csv.mjs';
import { loadTransit, transitTime } from './transit.mjs';

const raw = (p) => new URL(`../data/raw/${p}`, import.meta.url).pathname;
const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const sim = new Sim(net, { tripsPerHour: 0, fleetPerStation: 0, comfort: 'suspended' });

const blocks = new Map();
for await (const r of csvRows(raw('lodes/mn_xwalk.csv.gz'))) if (r.stplcname.startsWith('Minneapolis city')) blocks.set(r.tabblk2020, { bg: r.bgrp, p: project([+r.blklondd, +r.blklatdd]), w: 0.01 });
for await (const r of csvRows(raw('pl2020/hennepin_block_pop.csv'))) if (blocks.has(r.block)) blocks.get(r.block).w += +r.pop;
for await (const r of csvRows(raw('lodes/mn_wac_S000_JT00_2022.csv.gz'))) if (blocks.has(r.w_geocode)) blocks.get(r.w_geocode).w += +r.C000;
const byBg = new Map();
for (const b of blocks.values()) {
  if (!byBg.has(b.bg)) byBg.set(b.bg, []);
  byBg.get(b.bg).push(b);
}
let rnd = 31;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (bg) => {
  const l = byBg.get(bg);
  if (!l) return null;
  let t = l.reduce((a, b) => a + b.w, 0) * rand();
  for (const b of l) if ((t -= b.w) <= 0) return b.p;
  return l[l.length - 1].p;
};
const nearest = (p) => {
  let b = 0;
  let bd = Infinity;
  net.stations.forEach((s, i) => {
    const d = Math.hypot(s.x - p[0], s.y - p[1]);
    if (d < bd) {
      bd = d;
      b = i;
    }
  });
  return [b, bd];
};
const T = await loadTransit(raw('gtfs'), '20261202', 4 * 3600, 27 * 3600);

const rows = [];
for await (const r of csvRows(raw('tbi2023/data/linked_trip.csv'))) {
  const w = Number(r.linked_trip_weight || 0);
  if (!(w > 0) || r.mode_type_broad !== 'Personal Vehicle' || r.trip_o_city !== 'Minneapolis' || r.trip_d_city !== 'Minneapolis') continue;
  const car = Number(r.duration_minutes);
  // local departure time (depart_time itself is UTC)
  const hm = /^(\d+)(AM|PM)$/.exec(r.depart_hour || '');
  const m = hm ? [null, (Number(hm[1]) % 12) + (hm[2] === 'PM' ? 12 : 0), Number(r.depart_minute || 0)] : null;
  if (!(car > 0) || car > 120 || !m) continue;
  const A = pick((r.trip_o_cbg_2020 || '').replace(/\.0$/, ''));
  const B = pick((r.trip_d_cbg_2020 || '').replace(/\.0$/, ''));
  if (!A || !B) continue;
  const km = Math.hypot(A[0] - B[0], A[1] - B[1]) / 1000;
  if (km < 1) continue;
  const dep = Number(m[1]) * 3600 + Number(m[2]) * 60;
  const transit = transitTime(T, A, B, dep) / 60;
  const [sa, da] = nearest(A);
  const [sb, db] = nearest(B);
  const walkAll = (km * 1000 * 1.25) / 1.3 / 60;
  const prt = sa === sb ? walkAll : (((da + db) * 1.25) / 1.3 + 60 + 30 + sim.stationTime(sa, sb) + 40) / 60;
  const prtBike = sa === sb ? walkAll : (((da + db) * 1.25) / 4.5 + 60 + 40 + 60 + 30 + sim.stationTime(sa, sb) + 40) / 60;
  const h = Number(m[1]);
  // bike all the way: street distance (1.3 x straight) at 16 km/h, e-bike at 23 km/h, +1 min each
  const bike = (km * 1300) / 4.5 / 60 + 1;
  const ebike = (km * 1300) / 6.4 / 60 + 1;
  rows.push({ w, km, car, transit, bike, ebike, prt: Math.min(prt, walkAll), prtBike: Math.min(prtBike, walkAll), purpose: r.d_purpose_category, period: h < 6 ? 'night' : h < 10 ? 'morning' : h < 15 ? 'midday' : h < 19 ? 'afternoon' : 'evening' });
}
const W = (xs) => xs.reduce((a, r) => a + r.w, 0);
const share = (xs, f) => `${((100 * W(xs.filter(f))) / W(xs)).toFixed(0)}%`.padStart(5);
const wmed = (xs, k) => {
  const s = [...xs].sort((a, b) => a[k] - b[k]);
  const tot = W(s);
  let acc = 0;
  for (const r of s) if ((acc += r.w) >= tot / 2) return r[k];
  return null;
};
const ok10 = (k) => (r) => r[k] <= r.car + 10;
const ok15x = (k) => (r) => r[k] <= 1.5 * r.car;
console.log(`car trips inside Minneapolis, over 1 km: ${rows.length} survey records, ${Math.round(W(rows))} weekday trips`);
console.log(`median minutes: car ${wmed(rows, 'car')}, transit ${wmed(rows, 'transit').toFixed(1)}, PRT walking ${wmed(rows, 'prt').toFixed(1)}, PRT with bike ${wmed(rows, 'prtBike').toFixed(1)}, bike ${wmed(rows, 'bike').toFixed(1)}, e-bike ${wmed(rows, 'ebike').toFixed(1)}`);
const MODES = ['transit', 'prt', 'prtBike', 'bike', 'ebike'];
const line = (label, xs) => console.log(`${label.padEnd(20)} ${MODES.map((k) => share(xs, ok10(k))).join(' ')}   ${MODES.map((k) => share(xs, ok15x(k))).join(' ')}   ${String(Math.round(W(xs))).padStart(7)}`);
console.log('\nShare of car trips that would be reasonable another way');
console.log('                     within car + 10 min                 within 1.5 x car                  weekday');
console.log('                     trnst  PRT PRT+b  bike ebike      trnst  PRT PRT+b  bike ebike      trips');
line('all', rows);
for (const p of ['morning', 'midday', 'afternoon', 'evening', 'night']) line(p, rows.filter((r) => r.period === p));
const purposes = [...new Set(rows.map((r) => r.purpose))].map((p) => [p, W(rows.filter((r) => r.purpose === p))]).sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [p] of purposes) line(p, rows.filter((r) => r.purpose === p));
for (const [a, b] of [
  [1, 3],
  [3, 6],
  [6, 20],
])
  line(`${a}-${b} km`, rows.filter((r) => r.km >= a && r.km < b));
