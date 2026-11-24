// Build the PRT guideway network for Minneapolis.
//
// Layout: a square grid of one-way lines every half mile, alternating
// direction like a one-way street grid, with an off-line station at the middle
// of every half-mile segment. On a street grid, that puts every point within a
// quarter-mile walk of a station (see docs/network-layout.md).
//
// Output: data/network.json, used by both the simulator and the viewer.

import fs from 'node:fs';
import { project, pointInRing, segmentsIntersect, MILE, cumulative, polylineLength } from '../src/geo.js';

const P = {
  pitch: MILE / 2, // spacing between parallel lines
  rampRadius: 30, // turn ramp radius at crossings (m)
  rampLane: 60, // decel/accel lane on each side of a turn, so slowing happens off the main line (m)
  stationHalfSpan: 150, // diverge-to-centre distance for a station (m)
  berthHalfLength: 40, // half-length of the berth area (m)
  stationOffset: 12, // berth lane offset from the main line (m)
  berths: 8,
  vMain: 15, // m/s, about 34 mph
  vTurn: Math.sqrt(1.5 * 30), // lateral 1.5 m/s^2 on a 30 m radius ≈ 6.7 m/s
  vStation: 8,
  cellInclusion: 0.3, // share of a cell that must be city land for its loop to be built
};

const geo = JSON.parse(fs.readFileSync(new URL('../data/geo.json', import.meta.url)));
const city = geo.city.map(project);
const lakes = Object.fromEntries(Object.entries(geo.lakes).map(([k, r]) => [k, r.map(project)]));
const river = geo.river.map((l) => l.map(project));

const inLake = (p) => Object.values(lakes).some((r) => pointInRing(p, r));
const onLand = (p) => pointInRing(p, city) && !inLake(p);

// Grid extent
const xs = city.map((p) => p[0]);
const ys = city.map((p) => p[1]);
const iMin = Math.floor(Math.min(...xs) / P.pitch) - 1;
const iMax = Math.ceil(Math.max(...xs) / P.pitch) + 1;
const jMin = Math.floor(Math.min(...ys) / P.pitch) - 1;
const jMax = Math.ceil(Math.max(...ys) / P.pitch) + 1;

// Direction of each line. Vertical line i (x = i*pitch): north if i even.
// Horizontal line j (y = j*pitch): east if j even.
const vDir = (i) => (((i % 2) + 2) % 2 === 0 ? 1 : -1);
const hDir = (j) => (((j % 2) + 2) % 2 === 0 ? 1 : -1);

// 1. Choose cells.
const cells = new Set();
for (let i = iMin; i < iMax; i++) {
  for (let j = jMin; j < jMax; j++) {
    let n = 0;
    let k = 0;
    for (let a = 0; a < 10; a++)
      for (let b = 0; b < 10; b++) {
        k++;
        if (onLand([(i + (a + 0.5) / 10) * P.pitch, (j + (b + 0.5) / 10) * P.pitch])) n++;
      }
    if (n / k >= P.cellInclusion) cells.add(`${i},${j}`);
  }
}

// 2. Segments = sides of chosen cells, minus any that cross a lake.
// Segment key: 'v,i,j' is vertical line i from y=j to y=j+1; 'h,i,j' horizontal line j from x=i to x=i+1.
const segs = new Map();
for (const key of cells) {
  const [i, j] = key.split(',').map(Number);
  for (const s of [`v,${i},${j}`, `v,${i + 1},${j}`, `h,${i},${j}`, `h,${i},${j + 1}`]) segs.set(s, true);
}
const segEnds = (s) => {
  const [t, i, j] = s.split(',');
  const a = [+i * P.pitch, +j * P.pitch];
  const b = t === 'v' ? [a[0], a[1] + P.pitch] : [a[0] + P.pitch, a[1]];
  return [a, b];
};
let lakeDropped = 0;
for (const s of [...segs.keys()]) {
  const [a, b] = segEnds(s);
  for (let t = 0; t <= 1; t += 0.02) {
    if (inLake([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) {
      segs.delete(s);
      lakeDropped++;
      break;
    }
  }
}

// 3. Graph.
const nodes = [];
const edges = [];
const nodeIndex = new Map();
function node(key, x, y) {
  if (nodeIndex.has(key)) return nodeIndex.get(key);
  const id = nodes.length;
  nodes.push({ id, key, x, y });
  nodeIndex.set(key, id);
  return id;
}
function edge(from, to, pts, vmax, kind, extra = {}) {
  edges.push({ id: edges.length, from, to, pts, len: polylineLength(pts), vmax, kind, ...extra });
  return edges.length - 1;
}
const r2 = (p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];

// Directed segment info: for vertical line i, segment between rows j and j+1.
// Travel direction determines which end is the start.
function dirSeg(s) {
  const [t, i, j] = s.split(',');
  const [a, b] = segEnds(s);
  const d = t === 'v' ? vDir(+i) : hDir(+j);
  const [start, end] = d > 0 ? [a, b] : [b, a];
  const unit = t === 'v' ? [0, d] : [d, 0];
  return { t, start, end, unit };
}
const crossingKey = (p) => `${Math.round(p[0] / P.pitch)},${Math.round(p[1] / P.pitch)}`;

// Node ids at crossings: D (diverge, before crossing) and M (merge, after) per line.
// They sit far enough from the crossing to fit a turn ramp's decel/accel lane.
const R = P.rampRadius;
const X = P.rampRadius + P.rampLane;
const dNode = (t, p, u) => node(`D${t}:${crossingKey(p)}`, p[0] - u[0] * X, p[1] - u[1] * X);
const mNode = (t, p, u) => node(`M${t}:${crossingKey(p)}`, p[0] + u[0] * X, p[1] + u[1] * X);

const stations = [];
let bridges = 0;
for (const s of segs.keys()) {
  const { t, start, end, unit } = dirSeg(s);
  const from = mNode(t, start, unit);
  const to = dNode(t, end, unit);
  const p0 = [start[0] + unit[0] * X, start[1] + unit[1] * X];
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const at = (d, off = 0) => {
    // point d metres from mid along travel, offset to the right of travel
    const right = [unit[1], -unit[0]];
    return [mid[0] + unit[0] * d + right[0] * off, mid[1] + unit[1] * d + right[1] * off];
  };
  const crossesRiver = river.some((l) => l.some((q, k) => k > 0 && segmentsIntersect(start, end, l[k - 1], q)));
  // A river crossing is only worth a bridge when both ends are in the city;
  // otherwise it just leads into St. Paul along the boundary.
  if (crossesRiver && !(pointInRing(start, city) && pointInRing(end, city))) continue;
  if (crossesRiver) bridges++;

  // Station on this segment unless the middle is in water or the segment is a bridge.
  const hasStation = !crossesRiver && onLand(mid);
  if (!hasStation) {
    edge(from, to, [p0, [end[0] - unit[0] * X, end[1] - unit[1] * X]].map(r2), P.vMain, 'main', { bridge: crossesRiver });
    continue;
  }
  const H = P.stationHalfSpan;
  const B = P.berthHalfLength;
  const O = P.stationOffset;
  const sd = node(`Sd:${s}`, ...at(-H));
  const sm = node(`Sm:${s}`, ...at(H));
  const sin = node(`Si:${s}`, ...at(-B, O));
  const sout = node(`So:${s}`, ...at(B, O));
  edge(from, sd, [p0, at(-H)].map(r2), P.vMain, 'main');
  edge(sd, sm, [at(-H), at(H)].map(r2), P.vMain, 'main');
  edge(sm, to, [at(H), [end[0] - unit[0] * X, end[1] - unit[1] * X]].map(r2), P.vMain, 'main');
  const curve = (d0, d1, o0, o1) => {
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const f = k / 8;
      const e = (1 - Math.cos(Math.PI * f)) / 2;
      pts.push(r2(at(d0 + (d1 - d0) * f, o0 + (o1 - o0) * e)));
    }
    return pts;
  };
  const id = stations.length;
  // Entry and exit lanes run at line speed: vehicles brake and accelerate off the main line.
  const entry = edge(sd, sin, curve(-H, -B, 0, O), P.vMain, 'stEntry', { station: id });
  const berth = edge(sin, sout, [at(-B, O), at(B, O)].map(r2), P.vStation, 'berth', { station: id });
  const exit = edge(sout, sm, curve(B, H, O, 0), P.vMain, 'stExit', { station: id });
  stations.push({ id, seg: s, x: r2(mid)[0], y: r2(mid)[1], berth: r2(at(0, O)), dir: unit, entry, berth, exit, inNode: sin, outNode: sout, berths: P.berths });
}

// Crossing ramps: straight-through and the two turns.
const crossings = new Set();
for (const s of segs.keys()) {
  const { start, end } = dirSeg(s);
  crossings.add(crossingKey(start));
  crossings.add(crossingKey(end));
}
let turnRamps = 0;
for (const c of crossings) {
  const [ci, cj] = c.split(',').map(Number);
  const p = [ci * P.pitch, cj * P.pitch];
  const uv = [0, vDir(ci)];
  const uh = [hDir(cj), 0];
  const has = (k) => nodeIndex.has(k);
  const Dv = `Dv:${c}`;
  const Mv = `Mv:${c}`;
  const Dh = `Dh:${c}`;
  const Mh = `Mh:${c}`;
  if (has(Dv) && has(Mv)) edge(nodeIndex.get(Dv), nodeIndex.get(Mv), [nodes[nodeIndex.get(Dv)], nodes[nodeIndex.get(Mv)]].map((n) => [n.x, n.y]), P.vMain, 'main');
  if (has(Dh) && has(Mh)) edge(nodeIndex.get(Dh), nodeIndex.get(Mh), [nodes[nodeIndex.get(Dh)], nodes[nodeIndex.get(Mh)]].map((n) => [n.x, n.y]), P.vMain, 'main');
  const arc = (uIn, uOut) => {
    // quarter circle from p - uIn*R to p + uOut*R, centre at p - uIn*R + uOut*R
    const c0 = [p[0] - uIn[0] * R + uOut[0] * R, p[1] - uIn[1] * R + uOut[1] * R];
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const a = ((Math.PI / 2) * k) / 8;
      // start vector from centre = -uOut*R, end vector = uIn*R
      const v = [-uOut[0] * Math.cos(a) + uIn[0] * Math.sin(a), -uOut[1] * Math.cos(a) + uIn[1] * Math.sin(a)];
      pts.push(r2([c0[0] + v[0] * R, c0[1] + v[1] * R]));
    }
    return pts;
  };
  // A turn ramp: decel lane, quarter-circle curve, accel lane.
  const ramp = (dKey, mKey, uIn, uOut, tag) => {
    const a = node(`Ta${tag}:${c}`, p[0] - uIn[0] * R, p[1] - uIn[1] * R);
    const b = node(`Tb${tag}:${c}`, p[0] + uOut[0] * R, p[1] + uOut[1] * R);
    const d = nodes[nodeIndex.get(dKey)];
    const m = nodes[nodeIndex.get(mKey)];
    edge(d.id, a, [[d.x, d.y], [nodes[a].x, nodes[a].y]], P.vMain, 'rampLane');
    edge(a, b, arc(uIn, uOut), P.vTurn, 'turn');
    edge(b, m.id, [[nodes[b].x, nodes[b].y], [m.x, m.y]], P.vMain, 'rampLane');
    turnRamps++;
  };
  if (has(Dv) && has(Mh)) ramp(Dv, Mh, uv, uh, 'v');
  if (has(Dh) && has(Mv)) ramp(Dh, Mv, uh, uv, 'h');
}

// 4. Keep the largest strongly connected component (Tarjan, iterative).
function largestSCC() {
  const out = nodes.map(() => []);
  for (const e of edges) out[e.from].push(e.to);
  const index = new Array(nodes.length).fill(-1);
  const low = new Array(nodes.length).fill(0);
  const onStack = new Array(nodes.length).fill(false);
  const stack = [];
  const comps = [];
  let idx = 0;
  for (let s = 0; s < nodes.length; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0]];
    index[s] = low[s] = idx++;
    stack.push(s);
    onStack[s] = true;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, k] = top;
      if (k < out[v].length) {
        top[1]++;
        const w = out[v][k];
        if (index[w] === -1) {
          index[w] = low[w] = idx++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) low[work[work.length - 1][0]] = Math.min(low[work[work.length - 1][0]], low[v]);
        if (low[v] === index[v]) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack[w] = false;
            comp.push(w);
          } while (w !== v);
          comps.push(comp);
        }
      }
    }
  }
  comps.sort((a, b) => b.length - a.length);
  return new Set(comps[0]);
}
const keep = largestSCC();
const nodeMap = new Map();
const fNodes = [];
for (const n of nodes) if (keep.has(n.id)) {
  nodeMap.set(n.id, fNodes.length);
  fNodes.push({ id: fNodes.length, x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10 });
}
const edgeMap = new Map();
const fEdges = [];
for (const e of edges) if (keep.has(e.from) && keep.has(e.to)) {
  edgeMap.set(e.id, fEdges.length);
  fEdges.push({ ...e, id: fEdges.length, from: nodeMap.get(e.from), to: nodeMap.get(e.to), len: Math.round(e.len * 10) / 10 });
}
const fStations = [];
for (const st of stations) {
  if (!edgeMap.has(st.entry) || !edgeMap.has(st.exit) || !edgeMap.has(st.berth)) continue;
  const id = fStations.length;
  fStations.push({ ...st, id, entry: edgeMap.get(st.entry), berth: edgeMap.get(st.berth), exit: edgeMap.get(st.exit), inNode: nodeMap.get(st.inNode), outNode: nodeMap.get(st.outNode) });
}
for (const e of fEdges) if (e.station !== undefined) e.station = fStations.findIndex((s) => s.entry === e.id || s.exit === e.id || s.berth === e.id);

// 5. Coverage: share of city land within a street-grid (L1) walk of a station.
const cov = { 300: 0, 402: 0, 600: 0, n: 0 };
const stPts = fStations.map((s) => [s.x, s.y]);
const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);
const uncovered = [];
for (let x = minX; x < maxX; x += 100)
  for (let y = minY; y < maxY; y += 100) {
    if (!onLand([x, y])) continue;
    cov.n++;
    let best = Infinity;
    for (const q of stPts) best = Math.min(best, Math.abs(q[0] - x) + Math.abs(q[1] - y));
    for (const d of [300, 402, 600]) if (best <= d) cov[d]++;
    if (best > 402) uncovered.push([Math.round(x), Math.round(y)]);
  }

const guidewayKm = fEdges.filter((e) => e.kind === 'main').reduce((a, e) => a + e.len, 0) / 1000;
const stats = {
  cells: cells.size,
  stations: fStations.length,
  stationsDroppedBySCC: stations.length - fStations.length,
  nodes: fNodes.length,
  edges: fEdges.length,
  guidewayKm: Math.round(guidewayKm * 10) / 10,
  guidewayMiles: Math.round((guidewayKm / 1.609) * 10) / 10,
  turnRamps: fEdges.filter((e) => e.kind === 'turn').length,
  merges: fNodes.filter((n) => fEdges.filter((e) => e.to === n.id).length > 1).length,
  bridges: fEdges.filter((e) => e.bridge).length,
  segmentsDroppedForLakes: lakeDropped,
  landSqMi: Math.round((cov.n * 100 * 100) / (MILE * MILE) * 10) / 10,
  coverage: {
    within300m: Math.round((1000 * cov[300]) / cov.n) / 10,
    withinQuarterMile: Math.round((1000 * cov[402]) / cov.n) / 10,
    within600m: Math.round((1000 * cov[600]) / cov.n) / 10,
  },
};

const out = {
  params: P,
  stats,
  geo: { city: city.map(r2), lakes: Object.fromEntries(Object.entries(lakes).map(([k, r]) => [k, r.map(r2)])), river: river.map((l) => l.map(r2)) },
  nodes: fNodes,
  edges: fEdges,
  stations: fStations,
  uncovered,
};
fs.writeFileSync(new URL('../data/network-grid.json', import.meta.url), JSON.stringify(out));
console.log(JSON.stringify(stats, null, 2));
