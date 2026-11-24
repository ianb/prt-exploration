// Route directness: guideway distance between random pairs of stations
// (by the simulator's fastest routes) divided by straight-line distance.
// Usage: node scripts/route-ratio.mjs [network.json]
import fs from 'node:fs';
import { Sim } from '../src/sim.js';
const net = JSON.parse(fs.readFileSync(process.argv[2] || new URL('../data/network.json', import.meta.url)));
const s = new Sim(net, { tripsPerHour: 0, fleetPerStation: 0 });
const N = net.nodes.length;
let rnd = 99;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const ratios = [];
for (let k = 0; ratios.length < 3000 && k < 20000; k++) {
  const a = Math.floor(rand() * s.stations.length);
  const b = Math.floor(rand() * s.stations.length);
  const A = s.stations[a];
  const B = s.stations[b];
  const sl = Math.hypot(A.x - B.x, A.y - B.y);
  if (sl < 1000) continue;
  let n = s.edges[A.exit].to;
  let d = 0;
  for (let g = 0; g < 5000; g++) {
    const e = s.nextHop[b * N + n];
    if (e < 0) break;
    const E = s.edges[e];
    if (E.kind === 'stEntry') break;
    d += E.len;
    n = E.to;
  }
  ratios.push(d / sl);
}
ratios.sort((x, y) => x - y);
const mean = ratios.reduce((x, y) => x + y, 0) / ratios.length;
console.log(`route / straight line over ${ratios.length} station pairs >= 1 km: mean ${mean.toFixed(2)}, median ${ratios[ratios.length >> 1].toFixed(2)}, 90th pct ${ratios[Math.floor(ratios.length * 0.9)].toFixed(2)}`);
