// Stadium let-out scenario: US Bank Stadium empties after a game, on top of
// normal afternoon demand.
//
// Fans (in parties of about 2.5, one vehicle each) leave over `duration`
// seconds, walk to whichever station within `radius` has the best walk +
// visible queue, and ride to:
//   - home, for Minneapolis residents (spread by population)
//   - park-and-ride stations at the city edge, for suburban fans (by freeway
//     direction)
//   - hotels, for out-of-town visitors: in the city (by accommodation and food
//     jobs) or at the edge toward the airport / Bloomington hotels
// Group shares and park-and-ride weights are assumptions (no public data on
// where fans live; ~26% of stadium visitors are from out of state per the
// stadium authority's economic impact study).
//
// Usage: node scripts/event.mjs [key=value ...]
//   parties=6600 duration=2700 berths=30 radius=1000 fleetPerStation=10 tripsPerHour=4000

import fs from 'node:fs';
import { Sim } from '../src/sim.js';
import { project } from '../src/geo.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]));
const P = {
  parties: 6600, // ~66,000 attendance x 25% using PRT / 2.5 per party
  duration: 2700, // s over which fans leave
  start: 1800, // s after the simulation starts (15:00 + 30 min = game ends 15:30)
  berths: 30,
  radius: 1000,
  queueSecPerParty: 4,
  stagingRadius: 2500, // m: stations this close stock up with empties during the event
  prepS: 1200, // s before the end of the game to start stocking
  fleetPerStation: 10,
  tripsPerHour: 4000,
  minutes: 120,
  residents: 0.3,
  suburbs: 0.45,
  visitors: 0.25,
  ...args,
};
const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const demand = JSON.parse(fs.readFileSync(new URL('../data/demand-tbi.json', import.meta.url)));
const S = net.stations.length;
const nearestStation = (lat, lon) => {
  const p = project([lon, lat]);
  let b = 0;
  let bd = Infinity;
  net.stations.forEach((s, i) => {
    const d = Math.hypot(s.x - p[0], s.y - p[1]);
    if (d < bd) {
      bd = d;
      b = i;
    }
  });
  return b;
};
const weightsAt = (pairs) => {
  const w = new Float64Array(S);
  for (const [lat, lon, x] of pairs) w[nearestStation(lat, lon)] += x;
  return w;
};
// park-and-ride at the city edge by freeway direction, weighted roughly by the
// suburban population each direction serves (assumption)
const parkAndRide = weightsAt([
  [45.042, -93.3, 0.25], // north / northwest (I-94 / Hwy 252 toward Brooklyn Park, Anoka)
  [45.035, -93.245, 0.1], // northeast (I-35W north)
  [44.97, -93.318, 0.15], // west (I-394 toward Minnetonka, Plymouth)
  [44.893, -93.315, 0.15], // southwest (Hwy 62 / 100 toward Edina, Eden Prairie)
  [44.89, -93.278, 0.25], // south (I-35W toward Bloomington, Burnsville)
  [44.967, -93.215, 0.1], // east (I-94 toward St. Paul and the east metro)
]);
const airportHotels = weightsAt([[44.905, -93.21, 1]]);
const attr = (p) => Float64Array.from(demand.model.attraction[p]);
const cityHotels = attr('Meal'); // accommodation & food jobs
const hotel = new Float64Array(S);
const ch = cityHotels.reduce((a, b) => a + b, 0);
for (let i = 0; i < S; i++) hotel[i] = (0.6 * cityHotels[i]) / ch + 0.4 * airportHotels[i];

const sim = new Sim(net, {
  demandData: demand,
  demandModel: true,
  hourFrom: 15,
  hourTo: 17,
  tripsPerHour: P.tripsPerHour,
  fleetPerStation: P.fleetPerStation,
  berths: 18,
  headway: 0.5,
  comfort: 'suspended',
  event: {
    at: project([-93.2575, 44.9737]), // US Bank Stadium
    start: P.start,
    duration: P.duration,
    parties: P.parties,
    radius: P.radius,
    berths: P.berths,
    queueSecPerParty: P.queueSecPerParty,
    stagingRadius: P.stagingRadius,
    prepS: P.prepS,
    groups: [
      { name: 'residents', share: P.residents, weights: attr('Home') },
      { name: 'suburbs', share: P.suburbs, weights: parkAndRide },
      { name: 'visitors', share: P.visitors, weights: hotel },
    ],
  },
});
const ev = sim.event;
console.log(`stations fans can walk to (within ${P.radius} m): ${ev.near.length}, ${P.berths} bays each; staging stations within ${P.stagingRadius} m: ${ev.staging.size}; fleet ${sim.vehicles.length}; ${P.parties} parties over ${P.duration / 60} min`);
const clock = (t) => {
  const m = 15 * 60 + Math.floor(t / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
let lastLog = 0;
for (let i = 1; i <= Math.round((P.minutes * 60) / sim.p.dt); i++) {
  sim.step();
  if (i % Math.round(300 / sim.p.dt) === 0) {
    const waiting = ev.near.reduce((a, x) => a + x.st.waiting.filter((q) => q.event).length, 0);
    const idle = ev.near.reduce((a, x) => a + x.st.slots.filter((v) => v && v.state === 'idle').length, 0);
    const inbound = ev.near.reduce((a, x) => a + x.st.inbound, 0);
    const done = sim.eventLog.slice(lastLog);
    lastLog = sim.eventLog.length;
    const w = done.map((r) => r.wait).sort((a, b) => a - b);
    console.log(`${clock(sim.t)}  fans left so far ${String(sim.eventLeft).padStart(5)}  waiting at stadium stations ${String(waiting).padStart(5)}  idle there ${String(idle).padStart(4)}  empties on the way ${String(inbound).padStart(4)}  | parties arrived home in last 5 min ${String(done.length).padStart(4)}, their wait median ${w.length ? (w[w.length >> 1] / 60).toFixed(1) : '-'} min`);
  }
}
const L = sim.eventLog;
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const total = L.map((r) => (r.walk + r.wait + r.ride) / 60);
const waits = L.map((r) => r.wait / 60);
console.log(`\nparties delivered: ${L.length} of ${sim.eventLeft}; still waiting at the end: ${ev.near.reduce((a, x) => a + x.st.waiting.filter((qq) => qq.event).length, 0)}`);
console.log(`station wait (min): median ${q(waits, 0.5).toFixed(1)}, 90th ${q(waits, 0.9).toFixed(1)}, worst ${q(waits, 1).toFixed(1)}`);
console.log(`stadium to destination (walk + wait + ride, min): median ${q(total, 0.5).toFixed(1)}, 90th ${q(total, 0.9).toFixed(1)}`);
for (const g of ['residents', 'suburbs', 'visitors']) {
  const r = L.filter((x) => x.group === g);
  if (r.length) console.log(`  ${g.padEnd(10)} ${String(r.length).padStart(5)} parties, door-to-door median ${q(r.map((x) => (x.walk + x.wait + x.ride) / 60), 0.5).toFixed(1)} min, ride median ${q(r.map((x) => x.ride / 60), 0.5).toFixed(1)}`);
}
const bg = sim.tripLog.filter((t) => t[7] > P.start && t[7] < P.start + P.duration).map((t) => t[1] / 60);
const bgBefore = sim.tripLog.filter((t) => t[7] > 600 && t[7] < P.start).map((t) => t[1] / 60);
console.log(`everyone else's wait during the let-out: median ${q(bg, 0.5).toFixed(1)}, 90th ${q(bg, 0.9).toFixed(1)} min (before: median ${q(bgBefore, 0.5).toFixed(1)}, 90th ${q(bgBefore, 0.9).toFixed(1)})`);
console.log(JSON.stringify({ collisions: sim.stats.collisions, minGapM: Math.round(sim.stats.minGap * 100) / 100 }));
