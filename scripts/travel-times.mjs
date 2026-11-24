// Compare simulated PRT door-to-door times with how people travel now.
// Usage: node scripts/travel-times.mjs [minutes] [key=value ...]   (sim options as in run-sim)
// Benchmarks come from the 2023 Travel Behavior Inventory: weighted weekday
// trips with both ends in Minneapolis, by current mode, duration as reported.
import fs from 'node:fs';
import { Sim } from '../src/sim.js';
import { csvRows } from './csv.mjs';

const args = process.argv.slice(2);
const minutes = Number(args.find((a) => !a.includes('=')) ?? 60);
const opts = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => a.split('=')).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]));
if (opts.demand === 'tbi-model' || opts.demand === 'tbi') {
  opts.demandModel = opts.demand === 'tbi-model';
  opts.demandData = JSON.parse(fs.readFileSync(new URL('../data/demand-tbi.json', import.meta.url)));
}
delete opts.demand;
const net = JSON.parse(fs.readFileSync(new URL(`../data/${opts.net || 'network'}.json`, import.meta.url)));
delete opts.net;

const WALK_SPEED = 1.3; // m/s
const WALK_EACH_END = 0.7 * 402 * 1.0; // average walk to a station, m (about 70% of a quarter mile)
const bands = [
  [1, 2],
  [2, 3],
  [3, 5],
  [5, 8],
  [8, 15],
]; // km, straight line
const bandOf = (km) => bands.findIndex(([a, b]) => km >= a && km < b);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

const sim = new Sim(net, opts);
const warm = 15 * 60; // ignore trips that started in the first 15 minutes
const steps = Math.round((minutes * 60) / sim.p.dt);
for (let i = 0; i < steps; i++) sim.step();
const prt = bands.map(() => ({ door: [], ride: [], wait: [] }));
for (const [m, wait, ride] of sim.tripLog) {
  const b = bandOf(m / 1000);
  if (b < 0) continue;
  prt[b].door.push((2 * WALK_EACH_END) / WALK_SPEED + wait + ride);
  prt[b].ride.push(ride);
  prt[b].wait.push(wait);
}
void warm;

// Survey benchmark. Trip distance in the survey is the route travelled; convert
// to straight-line with the usual city factor of ~1.3.
const modes = {};
const tbiPath = new URL('../data/raw/tbi2023/data/linked_trip.csv', import.meta.url);
if (fs.existsSync(tbiPath)) {
  for await (const r of csvRows(tbiPath)) {
    const w = Number(r.linked_trip_weight || 0);
    if (!(w > 0) || r.trip_o_city !== 'Minneapolis' || r.trip_d_city !== 'Minneapolis') continue;
    const km = Number(r.distance_miles) * 1.609 / 1.3;
    const b = bandOf(km);
    const mins = Number(r.duration_minutes);
    if (b < 0 || !(mins > 0) || mins > 120) continue;
    const mode = r.mode_type_broad;
    if (!['Personal Vehicle', 'Transit', 'Bike/Scooter', 'Taxi/Uber/Lyft'].includes(mode)) continue;
    modes[mode] ??= bands.map(() => []);
    // weight by repeating in proportion (coarse): push value with weight
    modes[mode][b].push([mins, w]);
  }
}
const wmedian = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a[0] - b[0]);
  const tot = s.reduce((a, x) => a + x[1], 0);
  let acc = 0;
  for (const [v, w] of s) if ((acc += w) >= tot / 2) return v;
  return null;
};
const fmt = (x) => (x == null ? '   –' : (x / 60).toFixed(1).padStart(5));
console.log(JSON.stringify(sim.summary()));
console.log('\nMedian door-to-door minutes by straight-line trip distance (PRT includes ~3 min walk each end):');
console.log('distance   PRT   (wait  ride)   car   transit  bike   ride-hail   PRT trips');
bands.forEach(([a, b], i) => {
  const row = [`${a}-${b} km`.padEnd(9), fmt(median(prt[i].door)), ' (', fmt(median(prt[i].wait)), fmt(median(prt[i].ride)), ')'];
  for (const m of ['Personal Vehicle', 'Transit', 'Bike/Scooter', 'Taxi/Uber/Lyft']) row.push(fmt(modes[m] ? wmedian(modes[m][i]) * 60 : null));
  row.push(String(prt[i].door.length).padStart(8));
  console.log(row.join(' '));
});
