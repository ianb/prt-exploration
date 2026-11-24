// Headless run: node scripts/run-sim.mjs [minutes] [key=value ...]
import fs from 'node:fs';
import { Sim } from '../src/sim.js';

const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const args = process.argv.slice(2);
const minutes = Number(args.find((a) => !a.includes('=')) ?? 30);
const opts = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => a.split('=')).map(([k, v]) => [k, Number(v)]));
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
