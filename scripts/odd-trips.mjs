// "Odd place" trips: origin and destination are random census blocks anywhere in
// Minneapolis (not weighted by activity), departing 7-9 PM on a weekday.
// Transit on the real schedule; PRT estimated from free-flow routes (no congestion
// at that hour) + 1 min wait + boarding/alighting + walks.
import fs from 'node:fs';
import { Sim } from '../src/sim.js';
import { project } from '../src/geo.js';
import { csvRows } from './csv.mjs';
import { loadTransit, transitTime } from './transit.mjs';
const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const sim = new Sim(net, { tripsPerHour: 0, fleetPerStation: 0, comfort: 'suspended' });
const pts = [];
for await (const r of csvRows(new URL('../data/raw/lodes/mn_xwalk.csv.gz', import.meta.url).pathname)) if (r.stplcname.startsWith('Minneapolis city')) pts.push(project([+r.blklondd, +r.blklatdd]));
const T = await loadTransit(new URL('../data/raw/gtfs', import.meta.url).pathname, '20261202', 18 * 3600, 24 * 3600);
let rnd = 77; const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const nearest = (p) => { let b = 0, bd = Infinity; net.stations.forEach((s, i) => { const d = Math.hypot(s.x - p[0], s.y - p[1]); if (d < bd) { bd = d; b = i; } }); return [b, bd]; };
const rows = [];
while (rows.length < 1500) {
  const A = pts[Math.floor(rand() * pts.length)], B = pts[Math.floor(rand() * pts.length)];
  const km = Math.hypot(A[0] - B[0], A[1] - B[1]) / 1000; if (km < 1) continue;
  const [sa, da] = nearest(A), [sb, db] = nearest(B);
  const walk = ((da + db) * 1.25) / 1.3;
  const prt = sa === sb ? ((Math.hypot(A[0] - B[0], A[1] - B[1]) * 1.25) / 1.3) : walk + 60 + 30 + sim.stationTime(sa, sb) + 40;
  const dep = 19 * 3600 + rand() * 7200;
  rows.push({ km, prt: prt / 60, transit: transitTime(T, A, B, dep) / 60 });
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const share = (f) => `${((100 * rows.filter(f).length) / rows.length).toFixed(0)}%`;
console.log(`random places anywhere in the city, weekday 7-9 PM, ${rows.length} trips, median straight-line ${pct(rows.map(r => r.km), .5).toFixed(1)} km`);
for (const k of ['transit', 'prt']) console.log(`  ${k}: median ${pct(rows.map(r => r[k]), .5).toFixed(1)}, 75th ${pct(rows.map(r => r[k]), .75).toFixed(1)}, 90th ${pct(rows.map(r => r[k]), .9).toFixed(1)}, worst ${pct(rows.map(r => r[k]), 1).toFixed(1)} min`);
console.log(`  transit over 45 min: ${share(r => r.transit > 45)}, over 60: ${share(r => r.transit > 60)}, over 75: ${share(r => r.transit > 75)}`);
console.log(`  PRT over 45 min: ${share(r => r.prt > 45)}, over 60: ${share(r => r.prt > 60)}`);
