// Build commute demand from Census LODES (where people live and work, by
// census block), assigned to the nearest PRT station.
//
// Run scripts/fetch-lodes.sh first. Output: data/demand-lodes.json
//
// LODES counts jobs, not trips. Each job is roughly one trip to work and one
// trip home per working day. The simulator scales these counts to a
// trips-per-hour figure.

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { project } from '../src/geo.js';

const YEAR = process.argv[2] || '2022';
const RAW = new URL('../data/raw/lodes/', import.meta.url);
const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const WALK = 402; // quarter mile, measured along the street grid

async function* rows(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(new URL(file, RAW)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    // xwalk has quoted fields containing commas
    const f = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) {
        f.push(cur);
        cur = '';
      } else cur += ch;
    }
    f.push(cur);
    if (!header) {
      header = f;
      continue;
    }
    yield Object.fromEntries(header.map((h, i) => [h, f[i]]));
  }
}

// Block -> nearest station (street-grid distance), for blocks in Minneapolis.
const stations = net.stations.map((s) => [s.x, s.y]);
const blockStation = new Map(); // geocode -> [station, walk metres]
for await (const r of rows('mn_xwalk.csv.gz')) {
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
  blockStation.set(r.tabblk2020, [best, bd]);
}
console.log('Minneapolis blocks', blockStation.size);

const S = net.stations.length;
const residents = new Array(S).fill(0);
const jobs = new Array(S).fill(0);
const inbound = new Array(S).fill(0); // live outside the city, work near this station
const outbound = new Array(S).fill(0); // live near this station, work outside the city
const od = new Map(); // "o,d" -> commuters
const tot = { internal: 0, internalServed: 0, sameStation: 0, longWalk: 0, inbound: 0, outbound: 0, residentWorkers: 0, jobs: 0 };

for await (const r of rows(`mn_rac_S000_JT00_${YEAR}.csv.gz`)) {
  const b = blockStation.get(r.h_geocode);
  if (b) {
    residents[b[0]] += Number(r.C000);
    tot.residentWorkers += Number(r.C000);
  }
}
for await (const r of rows(`mn_wac_S000_JT00_${YEAR}.csv.gz`)) {
  const b = blockStation.get(r.w_geocode);
  if (b) {
    jobs[b[0]] += Number(r.C000);
    tot.jobs += Number(r.C000);
  }
}
for await (const r of rows(`mn_od_main_JT00_${YEAR}.csv.gz`)) {
  const h = blockStation.get(r.h_geocode);
  const w = blockStation.get(r.w_geocode);
  const n = Number(r.S000);
  if (h && w) {
    tot.internal += n;
    if (h[1] > WALK || w[1] > WALK) tot.longWalk += n;
    if (h[0] === w[0]) {
      tot.sameStation += n;
      continue;
    }
    tot.internalServed += n;
    const k = `${h[0]},${w[0]}`;
    od.set(k, (od.get(k) || 0) + n);
  } else if (w) {
    inbound[w[0]] += n;
    tot.inbound += n;
  } else if (h) {
    outbound[h[0]] += n;
    tot.outbound += n;
  }
}
// Workers living in other states (Wisconsin etc.) are in the "aux" file.
if (fs.existsSync(new URL(`mn_od_aux_JT00_${YEAR}.csv.gz`, RAW))) {
  for await (const r of rows(`mn_od_aux_JT00_${YEAR}.csv.gz`)) {
    const w = blockStation.get(r.w_geocode);
    if (w) {
      inbound[w[0]] += Number(r.S000);
      tot.inbound += Number(r.S000);
    }
  }
}

const out = {
  stations: net.stations.length, // the network this table was built for
  source: `US Census Bureau, LEHD Origin-Destination Employment Statistics (LODES8), Minnesota, ${YEAR}`,
  note: 'Counts are primary+secondary jobs (S000) for workers living and working in Minneapolis, keyed by nearest station. home station -> work station.',
  totals: tot,
  residents,
  jobs,
  inbound,
  outbound,
  od: [...od].map(([k, n]) => [...k.split(',').map(Number), n]),
};
fs.writeFileSync(new URL('../data/demand-lodes.json', import.meta.url), JSON.stringify(out));
console.log(JSON.stringify(tot, null, 2));
