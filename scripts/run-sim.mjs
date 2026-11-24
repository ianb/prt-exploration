// Headless run: node scripts/run-sim.mjs [minutes] [key=value ...]
// demand=lodes uses the Census commute table (direction=am|pm|both).
// demand=tbi uses the travel-survey table (hourFrom=16 hourTo=17 for the 4-5 PM peak);
// demand=tbi-model uses the smoothed model built from the survey.
import fs from 'node:fs';
import { Sim } from '../src/sim.js';

const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const args = process.argv.slice(2);
const minutes = Number(args.find((a) => !a.includes('=')) ?? 30);
const opts = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => a.split('=')).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]));
if (opts.demand === 'lodes') opts.demandData = JSON.parse(fs.readFileSync(new URL('../data/demand-lodes.json', import.meta.url)));
if (opts.demand === 'tbi-model') {
  opts.demand = 'tbi';
  opts.demandModel = true;
}
if (opts.demand === 'tbi') opts.demandData = JSON.parse(fs.readFileSync(new URL('../data/demand-tbi.json', import.meta.url)));
delete opts.demand;
const t0 = Date.now();
const sim = new Sim(net, opts);
console.log(`setup ${Date.now() - t0} ms, ${sim.vehicles.length} vehicles, ${sim.stations.length} stations`);
const steps = Math.round((minutes * 60) / sim.p.dt);
const every = Math.round(600 / sim.p.dt);
for (let i = 1; i <= steps; i++) {
  sim.step();
  if (i % every === 0 || i === steps) console.log(JSON.stringify(sim.summary()));
}
console.log(`run ${((Date.now() - t0) / 1000).toFixed(1)} s`);
