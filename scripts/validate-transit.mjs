// Validate the transit router against real trips: route every transit trip in
// the travel survey (inside Minneapolis) from its origin to its destination
// block group at its actual departure time, and compare with the duration the
// rider reported.
import { project } from '../src/geo.js';
import { csvRows } from './csv.mjs';
import { loadTransit, transitTime } from './transit.mjs';

const raw = (p) => new URL(`../data/raw/${p}`, import.meta.url).pathname;
// block-group centres from census blocks, weighted by people + jobs
const bg = new Map();
const blockBg = new Map();
for await (const r of csvRows(raw('lodes/mn_xwalk.csv.gz'))) {
  if (r.cty !== '27053' && r.cty !== '27123') continue;
  const p = project([Number(r.blklondd), Number(r.blklatdd)]);
  blockBg.set(r.tabblk2020, [r.bgrp, p]);
}
const w = new Map();
for await (const r of csvRows(raw('pl2020/hennepin_block_pop.csv'))) w.set(r.block, Number(r.pop));
for await (const r of csvRows(raw('lodes/mn_wac_S000_JT00_2022.csv.gz'))) if (blockBg.has(r.w_geocode)) w.set(r.w_geocode, (w.get(r.w_geocode) || 0) + Number(r.C000));
for (const [b, [g, p]] of blockBg) {
  const ww = (w.get(b) || 0) + 0.01;
  const a = bg.get(g) || [0, 0, 0];
  bg.set(g, [a[0] + p[0] * ww, a[1] + p[1] * ww, a[2] + ww]);
}
const centre = (g) => {
  const a = bg.get(g);
  return a ? [a[0] / a[2], a[1] / a[2]] : null;
};
const T = await loadTransit(raw('gtfs'), '20261202', 4 * 3600, 26 * 3600);
const rows = [];
for await (const r of csvRows(raw('tbi2023/data/linked_trip.csv'))) {
  if (r.mode_type_broad !== 'Transit' || r.trip_o_city !== 'Minneapolis' || r.trip_d_city !== 'Minneapolis') continue;
  const o = centre((r.trip_o_cbg_2020 || '').replace(/\.0$/, ''));
  const d = centre((r.trip_d_cbg_2020 || '').replace(/\.0$/, ''));
  const rep = Number(r.duration_minutes);
  // local departure time (depart_time itself is UTC)
  const hm = /^(\d+)(AM|PM)$/.exec(r.depart_hour || '');
  const m = hm ? [null, (Number(hm[1]) % 12) + (hm[2] === 'PM' ? 12 : 0), Number(r.depart_minute || 0)] : null;
  if (!o || !d || !(rep > 0) || !m) continue;
  const dep = Number(m[1]) * 3600 + Number(m[2]) * 60;
  const km = Math.hypot(o[0] - d[0], o[1] - d[1]) / 1000;
  if (km < 0.5) continue;
  const mins = transitTime(T, o, d, dep) / 60;
  rows.push({ km, rep, mins, weekday: ['Tuesday', 'Wednesday', 'Thursday', 'Monday', 'Friday'].includes(r.depart_dow) });
}
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)];
};
console.log(`survey transit trips routed: ${rows.length} (weekday ${rows.filter((r) => r.weekday).length})`);
for (const [a, b] of [
  [0.5, 3],
  [3, 6],
  [6, 20],
  [0.5, 20],
]) {
  const r = rows.filter((x) => x.km >= a && x.km < b);
  const ratio = r.map((x) => x.mins / x.rep);
  console.log(`${a}-${b} km: n=${r.length}, median reported ${med(r.map((x) => x.rep)).toFixed(1)} min, median router ${med(r.map((x) => x.mins)).toFixed(1)} min, router/reported per trip: median ${med(ratio).toFixed(2)} (middle half ${q(ratio, 0.25).toFixed(2)}-${q(ratio, 0.75).toFixed(2)})`);
}
