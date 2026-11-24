// Build a PRT network that follows Minneapolis streets.
//
// The guideway is elevated over arterial and collector streets, so it can
// only go where those streets go, and crosses the river only on existing
// street bridges. The layout is chosen automatically:
//
//  1. Candidate links: street pieces between intersections (parkways excluded).
//  2. Corridors: grown greedily from the busiest link, each step adding the
//     connected link that brings the most new people + jobs within a short
//     walk per km of guideway, with a bonus for continuing along the same
//     street. Dead ends are closed into loops where a short connection exists.
//  3. Direction: streets that are one-way for traffic get one one-way beam;
//     two-way streets get twin beams. One-way pieces that would strand
//     vehicles are upgraded to twin.
//  4. Junctions: grade-separated, with a ramp for every turn, sized by the
//     turning angle. Dead ends get a turnaround loop.
//  5. Stations: placed greedily where they reach the most uncovered people and
//     jobs, at least 300 m apart, preferring spots next to a plausible site
//     (vacant, public, or lightly built land).
//
// Inputs: data/raw/streets.json (fetch-streets.mjs), data/raw/parcels.json
// (fetch-parcels.mjs), LODES xwalk/WAC and 2020 block population
// (fetch-lodes.sh, fetch-census-pop.sh), data/geo.json.
// Output: data/network.json in the simulator's format.

import fs from 'node:fs';
import { project, pointInRing, segmentsIntersect, polylineLength, cumulative, pointAlong } from '../src/geo.js';
import { csvRows } from './csv.mjs';

const P = {
  coverLink: 300, // m, blocks this close to a corridor count as served when choosing corridors
  coverStation: 330, // m straight line, roughly a 400 m (quarter mile) walk
  targetCoverage: 0.95,
  routeBudgetKm: 170, // stop adding corridors at this much street length
  sameStreetBonus: 1.4,
  pieceKm: 1.6, // corridors are chosen about a mile of one street at a time
  pieceOverheadKm: 0.4, // each new piece adds junctions and ramps: count it as this much extra guideway
  freewayCost: 1.3, // freeway rights-of-way: possible, but poor walk access
  crossingKm: 0.6, // a four-way crossing (two levels, two turn ramps) counts as this much extra guideway
  teeKm: 0.15, // a three-way junction (one merge or split)
  bridgeCloseMax: 3000, // m, longest connection added so a line has a way back
  localCost: 1.15, // local streets: a little more disruptive than arterials
  localMinKm: 2.5, // local streets must run at least this far to be candidates
  loopCloseMax: 3000, // m, longest connection added to close a dead end into a loop
  connectKm: 30, // extra street length for shortcuts that make routes more direct
  connectMinRatio: 1.3, // only add a shortcut where the network route is this much longer than the street route
  layout: 'lattice', // 'lattice' (parallel one-way lines on through streets) or 'greedy' (corridors by coverage)
  latticeMinLineKm: 2.5, // a street must run this far to be a lattice line (long lines keep routes direct)
  latticeSpacing: 800, // m between parallel lines
  latticeSpacingDense: 400, // m between parallel lines where activity is dense
  latticeDenseFactor: 3, // "dense" = this many times the city's average people+jobs per km2
  latticeMinGainPerKm: 0.002, // stop adding lines to a family below this share of its activity per km
  directShortcutKm: 0, // extra one-way street length added where one-way routes are much longer than street routes
  turnPenalty: 250, // m added per change of street when closing loops, so lines run straight on
  rampX: 70, // m from junction centre to diverge / merge points
  rampRadius: 30,
  twinOffset: 3, // m each side of the street centreline
  stationHalfSpan: 85, // diverge-to-centre (m): 60 m to brake from 15 m/s, 60 m to accelerate back
  berthHalfLength: 25,
  stationOffset: 9,
  stationMinSep: 300,
  stationMinGain: 0.0002,
  stationTargetCoverage: 0.95,
  berths: 10,
  vMain: 15,
  vStation: 8,
  latAccel: 1.5,
};

for (const a of process.argv.slice(2)) {
  const m = /^--(\w+)=(.*)$/.exec(a);
  if (m) P[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
}
// Geometry follows the design line speed: slow-down and speed-up lanes for
// turns and stations are long enough for comfortable braking and acceleration
// (0.2 g, seated riders, per ASCE 21 and Anderson's PRT design values).
{
  const a = 1.96;
  const vt = Math.sqrt(3.0 * P.rampRadius); // a 30 m ramp curve at 0.3 g of usable cornering
  const v = P.vMain;
  P.rampX = Math.round(P.rampRadius + Math.max(0, (v * v - vt * vt) / (2 * a)) + 10);
  P.stationHalfSpan = Math.round(P.berthHalfLength + (v * v) / (2 * a) + 10);
}
const raw = (p) => new URL(`../data/raw/${p}`, import.meta.url);
const geo = JSON.parse(fs.readFileSync(new URL('../data/geo.json', import.meta.url)));
const city = geo.city.map(project);
const lakes = Object.values(geo.lakes).map((r) => r.map(project));
const river = geo.river.map((l) => l.map(project));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const unit = (a) => {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
};
const right = (u) => [u[1], -u[0]];
const r1 = (p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];

function pointSegDist(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2 || 1)));
  return dist(p, add(a, mul(ab, t)));
}
function polyDist(p, pts) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, pointSegDist(p, pts[i - 1], pts[i]));
  return d;
}
// Offset a polyline sideways (positive = right of travel).
function offsetLine(pts, off) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const r = right(unit(sub(b, a)));
    return add(p, mul(r, off));
  });
}
// Sub-polyline between distances s0 and s1 along pts.
function slice(pts, cum, s0, s1) {
  const out = [pointAlong(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
  out.push(pointAlong(pts, cum, s1));
  return out;
}
const dirAt = (pts, cum, s) => unit(sub(pointAlong(pts, cum, Math.min(cum[cum.length - 1], s + 1)), pointAlong(pts, cum, Math.max(0, s - 1))));

// ---- activity: people + jobs per census block -----------------------------
const blocks = [];
const blockIndex = new Map();
for await (const r of csvRows(raw('lodes/mn_xwalk.csv.gz'))) {
  if (!r.stplcname.startsWith('Minneapolis city')) continue;
  blockIndex.set(r.tabblk2020, blocks.length);
  blocks.push({ p: project([Number(r.blklondd), Number(r.blklatdd)]), w: 0 });
}
for await (const r of csvRows(raw('pl2020/hennepin_block_pop.csv'))) {
  const i = blockIndex.get(r.block);
  if (i !== undefined) blocks[i].w += Number(r.pop);
}
for await (const r of csvRows(raw('lodes/mn_wac_S000_JT00_2022.csv.gz'))) {
  const i = blockIndex.get(r.w_geocode);
  if (i !== undefined) blocks[i].w += Number(r.C000);
}
const W = blocks.reduce((a, b) => a + b.w, 0);
const CELL = 250;
const hash = new Map();
blocks.forEach((b, i) => {
  const k = `${Math.floor(b.p[0] / CELL)},${Math.floor(b.p[1] / CELL)}`;
  if (!hash.has(k)) hash.set(k, []);
  hash.get(k).push(i);
});
function blocksNear(pts, r) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const out = [];
  for (let cx = Math.floor((Math.min(...xs) - r) / CELL); cx <= Math.floor((Math.max(...xs) + r) / CELL); cx++)
    for (let cy = Math.floor((Math.min(...ys) - r) / CELL); cy <= Math.floor((Math.max(...ys) + r) / CELL); cy++)
      for (const i of hash.get(`${cx},${cy}`) || []) if (pts.length === 1 ? dist(blocks[i].p, pts[0]) <= r : polyDist(blocks[i].p, pts) <= r) out.push(i);
  return out;
}

// ---- candidate street graph -------------------------------------------------
const norm = (n) =>
  (n || '')
    .replace(/^(North|South|East|West)\s+(?!Street|Avenue|Road|Drive|Lane$)/, '')
    .replace(/\s+(North|South|East|West|Northeast|Northwest|Southeast|Southwest)$/, '')
    .trim();
const streets = JSON.parse(fs.readFileSync(raw('streets.json')));
const segs = [];
const nodeKey = (p) => `${Math.round(p[0] / 3)},${Math.round(p[1] / 3)}`;
const gnodes = new Map(); // key -> {p, segs:[]}
const gnode = (p) => {
  const k = nodeKey(p);
  if (!gnodes.has(k)) gnodes.set(k, { k, p, segs: [] });
  return gnodes.get(k);
};
// Local streets only if they run a long way (a through street, not a cul-de-sac).
const nameLen = new Map();
for (const s of streets) {
  if (s.FUNCTIONAL) continue;
  const n = norm(s.ST_CONCAT);
  for (const path of s.paths) nameLen.set(n, (nameLen.get(n) || 0) + polylineLength(path.map(project)));
}
for (const s of streets) {
  if (/Parkway|Pkwy|Victory Memorial/i.test(s.ST_CONCAT || '')) continue;
  const freeway = ['1100', '2100'].includes(s.FUNCTIONAL) || s.ROUTE_SYS === '01';
  const local = !s.FUNCTIONAL && !freeway;
  if (local && (nameLen.get(norm(s.ST_CONCAT)) || 0) < P.localMinKm * 1000) continue;
  for (const path of s.paths) {
    const pts = path.map(project);
    if (pts.length < 2) continue;
    const seg = { id: segs.length, name: norm(s.ST_CONCAT), local, freeway, pts, oneway: s.ONEWAY === 'F' || s.ONEWAY === 'T' ? s.ONEWAY : 'B' };
    seg.a = gnode(pts[0]);
    seg.b = gnode(pts[pts.length - 1]);
    if (seg.a === seg.b) continue;
    seg.a.segs.push(seg);
    seg.b.segs.push(seg);
    segs.push(seg);
  }
}
// Chain segments into links between intersections (or name changes).
const links = [];
const used = new Set();
const passThrough = (n, name) => n.segs.length === 2 && n.segs.every((s) => s.name === name);
for (const s of segs) {
  if (used.has(s)) continue;
  used.add(s);
  // oriented list of [seg, forward?]
  let chain = [[s, true]];
  for (const dir of [1, -1]) {
    let cur = s;
    let fwd = true;
    let end = dir === 1 ? s.b : s.a;
    for (;;) {
      if (!passThrough(end, s.name)) break;
      const nx = end.segs.find((x) => x !== cur);
      if (used.has(nx)) break;
      used.add(nx);
      const nf = nx.a === end;
      if (dir === 1) chain.push([nx, nf]);
      else chain.unshift([nx, !nf]);
      cur = nx;
      fwd = nf;
      end = nf ? nx.b : nx.a;
    }
    void fwd;
  }
  const pts = [];
  let ow = null;
  for (const [sg, f] of chain) {
    const p = f ? sg.pts : [...sg.pts].reverse();
    pts.push(...(pts.length ? p.slice(1) : p));
    const o = sg.oneway === 'B' ? 'B' : (sg.oneway === 'F') === f ? 'F' : 'T';
    ow = ow === null ? o : ow === o ? ow : 'B';
  }
  const a = chain[0][1] ? chain[0][0].a : chain[0][0].b;
  const lastE = chain[chain.length - 1];
  const b = lastE[1] ? lastE[0].b : lastE[0].a;
  if (a === b) continue;
  const len = polylineLength(pts);
  links.push({ id: links.length, name: s.name, pts, len, oneway: ow, a, b, local: chain.every(([sg]) => sg.local), freeway: chain.some(([sg]) => sg.freeway) });
}
for (const n of gnodes.values()) n.links = [];
for (const l of links) {
  l.a.links.push(l);
  l.b.links.push(l);
  l.bridge = river.some((rl) => rl.some((q, k) => k > 0 && l.pts.some((p, i) => i > 0 && segmentsIntersect(l.pts[i - 1], p, rl[k - 1], q))));
  l.cover = blocksNear(l.pts, P.coverLink);
}
console.log(`candidate links: ${links.length}, ${Math.round(links.reduce((a, l) => a + l.len, 0) / 1000)} km, bridges ${links.filter((l) => l.bridge).length}`);

// ---- 2. choose corridors ---------------------------------------------------------
const covered = new Uint8Array(blocks.length);
let coveredW = 0;
const selected = new Set();
const cost = (l) => (l.len / 1000) * (l.local ? P.localCost : 1) * (l.freeway ? P.freewayCost : 1);
const gainOf = (l) => l.cover.reduce((a, i) => a + (covered[i] ? 0 : blocks[i].w), 0);
function select(l) {
  selected.add(l);
  for (const i of l.cover)
    if (!covered[i]) {
      covered[i] = 1;
      coveredW += blocks[i].w;
    }
}
const selNodes = () => new Set([...selected].flatMap((l) => [l.a, l.b]));

// Selection units are "pieces": about a mile of one street, made of whole
// links, so the network comes out as continuous lines along streets rather
// than zigzags through side streets.
const pieces = [];
{
  const seen = new Set();
  const sameNext = (n, l) => {
    const c = n.links.filter((m) => m !== l && m.name === l.name);
    return c.length === 1 ? c[0] : null;
  };
  for (const l0 of links) {
    if (seen.has(l0)) continue;
    seen.add(l0);
    const chain = [l0];
    for (const dir of [1, -1]) {
      let cur = l0;
      let end = dir === 1 ? l0.b : l0.a;
      for (;;) {
        const nx = sameNext(end, cur);
        if (!nx || seen.has(nx)) break;
        seen.add(nx);
        if (dir === 1) chain.push(nx);
        else chain.unshift(nx);
        end = nx.a === end ? nx.b : nx.a;
        cur = nx;
      }
    }
    let cur = [];
    let len = 0;
    const flush = () => {
      if (!cur.length) return;
      const nodes = new Set(cur.flatMap((l) => [l.a, l.b]));
      const cover = [...new Set(cur.flatMap((l) => l.cover))];
      pieces.push({ links: cur, nodes, cover, len, name: l0.name, cost: cur.reduce((a, l) => a + cost(l), 0) + P.pieceOverheadKm });
      cur = [];
      len = 0;
    };
    for (const l of chain) {
      cur.push(l);
      len += l.len;
      if (len >= P.pieceKm * 1000) flush();
    }
    flush();
  }
}
const pieceGain = (pc) => pc.cover.reduce((a, i) => a + (covered[i] ? 0 : blocks[i].w), 0);
function selectPiece(pc) {
  pc.taken = true;
  for (const l of pc.links) select(l);
}
if (P.layout === 'lattice') latticeSelect();
else {
{
  let best = null;
  let bs = -1;
  for (const pc of pieces) {
    const sc = pieceGain(pc) / pc.cost;
    if (sc > bs) {
      bs = sc;
      best = pc;
    }
  }
  selectPiece(best);
}
for (;;) {
  if (coveredW / W >= P.targetCoverage) break;
  if ([...selected].reduce((a, l) => a + l.len, 0) / 1000 > P.routeBudgetKm) break;
  const nodesSel = selNodes();
  let best = null;
  let bs = -1;
  for (const pc of pieces) {
    if (pc.taken) continue;
    let touches = false;
    for (const n of pc.nodes)
      if (nodesSel.has(n)) {
        touches = true;
        break;
      }
    if (!touches) continue;
    // junctions this piece would create: crossings cost more than tees
    let jk = 0;
    for (const n of pc.nodes) {
      const sd = selDegree(n);
      if (!sd) continue;
      const pd = pc.links.filter((l) => l.a === n || l.b === n).length;
      if (sd + pd >= 4) jk += P.crossingKm;
      else if (sd + pd === 3) jk += P.teeKm;
    }
    let sc = pieceGain(pc) / (pc.cost + jk);
    if ([...pc.nodes].some((n) => n.links.some((m) => selected.has(m) && m.name === pc.name))) sc *= P.sameStreetBonus;
    if (sc > bs) {
      bs = sc;
      best = pc;
    }
  }
  if (!best) break;
  selectPiece(best);
}
}

// Lattice layout: pick whole through streets in two families of roughly
// parallel lines (north-south and east-west; downtown uses its own rotated
// grid), spaced about half a mile apart, closer where people and jobs are
// dense. Neighbouring parallel lines then get opposite directions and connect
// wherever they cross, like the idealized grid but on real streets.
function latticeSelect() {
  // whole named streets, chained through same-name continuations
  const lines = [];
  const seen = new Set();
  const sameNext = (n, l) => {
    const c = n.links.filter((m) => m !== l && m.name === l.name);
    return c.length === 1 ? c[0] : null;
  };
  for (const l0 of links) {
    if (seen.has(l0) || l0.freeway) continue;
    seen.add(l0);
    const chain = [l0];
    for (const d of [1, -1]) {
      let cur = l0;
      let end = d === 1 ? l0.b : l0.a;
      for (;;) {
        const nx = sameNext(end, cur);
        if (!nx || seen.has(nx) || nx.freeway) break;
        seen.add(nx);
        if (d === 1) chain.push(nx);
        else chain.unshift(nx);
        end = nx.a === end ? nx.b : nx.a;
        cur = nx;
      }
    }
    const pts = chain.flatMap((l) => l.pts);
    const len = chain.reduce((a, l) => a + l.len, 0);
    if (len < P.latticeMinLineKm * 1000) continue;
    lines.push({ links: chain, pts, len, name: l0.name });
  }
  // family of each line by its overall bearing
  const DT = { c: [600, 3200], r: 1300, angle: 59 };
  const famOf = (ln) => {
    // length-weighted mean direction, mod 90
    let sx = 0;
    let sy = 0;
    for (const l of ln.links) {
      const a = l.pts[0];
      const b = l.pts[l.pts.length - 1];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 4; // x4 folds directions mod 90 degrees
      sx += Math.cos(ang) * l.len;
      sy += Math.sin(ang) * l.len;
    }
    const a90 = (((Math.atan2(sy, sx) / 4) * 180) / Math.PI + 90) % 90;
    const mid = ln.pts[Math.floor(ln.pts.length / 2)];
    const straight = dist(ln.pts[0], ln.pts[ln.pts.length - 1]) / ln.len;
    if (straight < 0.8) return null;
    const near = (x, y) => Math.min(Math.abs(x - y), 90 - Math.abs(x - y)) < 15;
    const end0 = ln.pts[0];
    const end1 = ln.pts[ln.pts.length - 1];
    const along = Math.abs(end1[0] - end0[0]) > Math.abs(end1[1] - end0[1]) ? 'EW' : 'NS';
    if (dist(mid, DT.c) < DT.r && near(a90, DT.angle)) {
      const ang = Math.atan2(end1[1] - end0[1], end1[0] - end0[0]) * (180 / Math.PI);
      const rel = (((ang - DT.angle) % 180) + 180) % 180;
      return rel < 45 || rel > 135 ? 'dtA' : 'dtB';
    }
    if (near(a90, 0)) return along;
    return null;
  };
  for (const ln of lines) ln.fam = famOf(ln);
  const fams = ['NS', 'EW', 'dtA', 'dtB'];
  // local spacing target from activity density
  const densAt = (p) => blocksNear([p], 500).reduce((a, i) => a + blocks[i].w, 0) / (Math.PI * 0.25); // per km^2
  const cityDens = W / 140; // ~140 km^2 of land
  const spacingAt = (p) => (densAt(p) > P.latticeDenseFactor * cityDens ? P.latticeSpacingDense : P.latticeSpacing);
  const blockSpacing = blocks.map((b) => (b.w > 0 ? spacingAt(b.p) : P.latticeSpacing));
  const inDT = blocks.map((b) => dist(b.p, DT.c) < DT.r);
  let chosen = 0;
  for (const fam of fams) {
    const famLines = lines.filter((l) => l.fam === fam);
    const cov = new Uint8Array(blocks.length);
    // which blocks this family serves: downtown families only downtown, others elsewhere
    const serves = (i) => (fam.startsWith('dt') ? inDT[i] : !inDT[i]);
    for (const ln of famLines) ln.cover = blocksNear(ln.pts, P.latticeSpacing / 2 + 50).filter((i) => serves(i) && polyDist(blocks[i].p, ln.pts) <= blockSpacing[i] / 2 + 50);
    const famW = blocks.reduce((a, b, i) => a + (serves(i) ? b.w : 0), 0);
    for (;;) {
      let best = null;
      let bs = 0;
      let bg = 0;
      for (const ln of famLines) {
        if (ln.taken) continue;
        const g = ln.cover.reduce((a, i) => a + (cov[i] ? 0 : blocks[i].w), 0);
        const c = ln.links.reduce((a, l) => a + cost(l), 0);
        if (g / c > bs) {
          bs = g / c;
          best = ln;
          bg = g;
        }
      }
      if (!best || bg / famW / (best.len / 1000) < P.latticeMinGainPerKm) break;
      best.taken = true;
      for (const i of best.cover) cov[i] = 1;
      for (const l of best.links) select(l);
      chosen++;
    }
    // alternate directions across the family, in order of position
    const axis = fam === 'NS' ? [0, 1] : fam === 'EW' ? [1, 0] : fam === 'dtA' ? [Math.cos((DT.angle * Math.PI) / 180), Math.sin((DT.angle * Math.PI) / 180)] : [-Math.sin((DT.angle * Math.PI) / 180), Math.cos((DT.angle * Math.PI) / 180)];
    const normal = [-axis[1], axis[0]];
    const taken = famLines.filter((l) => l.taken);
    const off = (ln) => {
      const m = ln.pts[Math.floor(ln.pts.length / 2)];
      return m[0] * normal[0] + m[1] * normal[1];
    };
    taken.sort((x, y) => off(x) - off(y));
    taken.forEach((ln, k) => {
      const sign = k % 2 === 0 ? 1 : -1;
      for (const l of ln.links) {
        const d = sub(l.pts[l.pts.length - 1], l.pts[0]);
        l.pref = (d[0] * axis[0] + d[1] * axis[1] > 0) === sign > 0 ? 1 : -1;
      }
    });
  }
  console.log(`lattice: ${chosen} street lines chosen from ${lines.length} candidates`);
}
console.log(`corridors: ${selected.size} links, ${Math.round([...selected].reduce((a, l) => a + l.len, 0) / 1000)} km, coverage ${(coveredW / W).toFixed(3)}`);

// Close dead ends into loops via the shortest candidate path to another part of the network.
function selDegree(n) {
  return n.links.filter((l) => selected.has(l)).length;
}
for (let pass = 0; pass < 4; pass++) {
  const ends = [...selNodes()].filter((n) => selDegree(n) === 1);
  for (const e of ends) {
    if (selDegree(e) !== 1) continue;
    const own = e.links.find((l) => selected.has(l));
    // Dijkstra over candidate links, not using the dead end's own link
    const dmap = new Map([[e, 0]]);
    const prev = new Map();
    const q = [[0, e]];
    let hit = null;
    while (q.length) {
      q.sort((x, y) => x[0] - y[0]);
      const [d, n] = q.shift();
      if (d > (dmap.get(n) ?? Infinity)) continue;
      if (n !== e && selNodes().has(n)) {
        hit = n;
        break;
      }
      const via = n === e ? own : prev.get(n);
      for (const l of n.links) {
        if (l === own || selected.has(l)) continue;
        const m = l.a === n ? l.b : l.a;
        const nd = d + cost(l) * 1000 + (via && via.name !== l.name ? P.turnPenalty : 0);
        if (nd > P.loopCloseMax) continue;
        if (nd < (dmap.get(m) ?? Infinity)) {
          dmap.set(m, nd);
          prev.set(m, l);
          q.push([nd, m]);
        }
      }
    }
    if (!hit) continue;
    for (let n = hit; n !== e; ) {
      const l = prev.get(n);
      select(l);
      n = l.a === n ? l.b : l.a;
    }
  }
}
// Trim short dangling spurs.
for (let changed = true; changed; ) {
  changed = false;
  for (const l of [...selected]) {
    const da = selDegree(l.a);
    const db = selDegree(l.b);
    if ((da === 1 || db === 1) && l.len < 250 && selected.size > 1) {
      selected.delete(l);
      changed = true;
    }
  }
}

// Connectivity: add shortcuts where the network forces long detours.
// Sample busy pairs of network nodes, compare the shortest route on the
// chosen network with the shortest route on all candidate streets, and add
// the street route for the worst (by people + jobs at both ends x km saved).
{
  class MinHeap {
    constructor() {
      this.a = [];
    }
    push(k, v) {
      const a = this.a;
      a.push([k, v]);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p][0] <= a[i][0]) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    }
    pop() {
      const a = this.a;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
    get size() {
      return this.a.length;
    }
  }
  function dijkstra(src, onlySelected) {
    const d = new Map([[src, 0]]);
    const prev = new Map();
    const h = new MinHeap();
    h.push(0, src);
    while (h.size) {
      const [dn, n] = h.pop();
      if (dn > d.get(n)) continue;
      for (const l of n.links) {
        if (onlySelected && !selected.has(l)) continue;
        const m = l.a === n ? l.b : l.a;
        const nd = dn + (onlySelected ? l.len : cost(l) * 1000);
        if (nd < (d.get(m) ?? Infinity)) {
          d.set(m, nd);
          prev.set(m, l);
          h.push(nd, m);
        }
      }
    }
    return { d, prev };
  }
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  let added = 0;
  for (let iter = 0; iter < 60 && added < P.connectKm * 1000; iter++) {
    const sn = [...selNodes()];
    const wN = sn.map((n) => blocksNear([n.p], 400).reduce((a, i) => a + blocks[i].w, 0) + 1);
    const tot = wN.reduce((a, b) => a + b, 0);
    const pickNode = () => {
      let r = rand() * tot;
      for (let i = 0; i < sn.length; i++) if ((r -= wN[i]) <= 0) return i;
      return sn.length - 1;
    };
    let best = null;
    let bb = 0;
    for (let k = 0; k < 25; k++) {
      const si = pickNode();
      const dsel = dijkstra(sn[si], true);
      const dall = dijkstra(sn[si], false);
      for (let j = 0; j < 40; j++) {
        const ti = pickNode();
        const t = sn[ti];
        const a = dsel.d.get(t);
        const b = dall.d.get(t);
        if (!a || !b || b < 1200 || a / b < P.connectMinRatio) continue;
        const benefit = wN[si] * wN[ti] * (a - b);
        if (benefit > bb) {
          bb = benefit;
          best = { prev: dall.prev, src: sn[si], t };
        }
      }
    }
    if (!best) break;
    for (let n = best.t; n !== best.src; ) {
      const l = best.prev.get(n);
      if (!selected.has(l)) {
        select(l);
        added += l.len;
      }
      n = l.a === n ? l.b : l.a;
    }
  }
  console.log(`shortcuts added: ${Math.round(added / 100) / 10} km`);
}

// Join separate pieces of network to the largest one by the shortest street
// route (up to 4 km); drop pieces that can't be joined.
{
  let joined = 0;
  let dropped = 0;
  for (let iter = 0; iter < 200; iter++) {
    const nodes = [...selNodes()];
    const comp = new Map();
    let nc = 0;
    for (const n0 of nodes) {
      if (comp.has(n0)) continue;
      const q = [n0];
      comp.set(n0, nc);
      while (q.length) {
        const n = q.pop();
        for (const l of n.links) {
          if (!selected.has(l)) continue;
          const m = l.a === n ? l.b : l.a;
          if (!comp.has(m)) {
            comp.set(m, nc);
            q.push(m);
          }
        }
      }
      nc++;
    }
    if (nc <= 1) break;
    const size = new Array(nc).fill(0);
    for (const c of comp.values()) size[c]++;
    const big = size.indexOf(Math.max(...size));
    // smallest other component
    let c0 = -1;
    for (let c = 0; c < nc; c++) if (c !== big && (c0 < 0 || size[c] < size[c0])) c0 = c;
    const src = nodes.filter((n) => comp.get(n) === c0);
    const dmap = new Map();
    const prev = new Map();
    const h = [];
    for (const n of src) {
      dmap.set(n, 0);
      h.push([0, n]);
    }
    let hit = null;
    while (h.length) {
      h.sort((x, y) => y[0] - x[0]);
      const [d, n] = h.pop();
      if (d > dmap.get(n)) continue;
      if (comp.has(n) && comp.get(n) !== c0) {
        hit = n;
        break;
      }
      for (const l of n.links) {
        if (selected.has(l)) continue;
        const m = l.a === n ? l.b : l.a;
        const nd = d + cost(l) * 1000;
        if (nd > 4000) continue;
        if (nd < (dmap.get(m) ?? Infinity)) {
          dmap.set(m, nd);
          prev.set(m, l);
          h.push([nd, m]);
        }
      }
    }
    if (hit) {
      for (let n = hit; comp.get(n) !== c0; ) {
        const l = prev.get(n);
        select(l);
        n = l.a === n ? l.b : l.a;
      }
      joined++;
    } else {
      for (const l of [...selected]) if (comp.get(l.a) === c0) selected.delete(l);
      dropped++;
    }
  }
  console.log(`separate pieces: ${joined} joined, ${dropped} dropped`);
}

// Every line is one-way, so every piece of guideway needs a way back: the
// network must have no "bridges" in the graph sense (a link whose removal
// cuts the network in two). For each one, connect the cut-off side back by
// the shortest street route; if there is none within reach, drop that side.
{
  function findBridges() {
    const nodes = [...selNodes()];
    const idx = new Map(nodes.map((n, i) => [n, i]));
    const adj = nodes.map(() => []);
    for (const l of selected) {
      adj[idx.get(l.a)].push([idx.get(l.b), l]);
      adj[idx.get(l.b)].push([idx.get(l.a), l]);
    }
    const disc = new Array(nodes.length).fill(-1);
    const low = new Array(nodes.length).fill(0);
    const out = [];
    let t = 0;
    for (let s0 = 0; s0 < nodes.length; s0++) {
      if (disc[s0] !== -1) continue;
      const stack = [[s0, null, 0]];
      disc[s0] = low[s0] = t++;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [v, pl] = top;
        if (top[2] < adj[v].length) {
          const [w, l] = adj[v][top[2]++];
          if (l === pl) continue;
          if (disc[w] === -1) {
            disc[w] = low[w] = t++;
            stack.push([w, l, 0]);
          } else low[v] = Math.min(low[v], disc[w]);
        } else {
          stack.pop();
          if (stack.length) {
            const u = stack[stack.length - 1][0];
            low[u] = Math.min(low[u], low[v]);
            if (low[v] > disc[u]) out.push(pl);
          }
        }
      }
    }
    return out;
  }
  function sideOf(start, without) {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      const n = q.pop();
      for (const l of n.links) {
        if (l === without || !selected.has(l)) continue;
        const m = l.a === n ? l.b : l.a;
        if (!seen.has(m)) {
          seen.add(m);
          q.push(m);
        }
      }
    }
    return seen;
  }
  let joined = 0;
  let droppedKm = 0;
  for (let iter = 0; iter < 400; iter++) {
    const br = findBridges();
    if (!br.length) break;
    const b = br[0];
    const A = sideOf(b.a, b);
    const B = sideOf(b.b, b);
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    // multi-source search from the small side to the big side over unselected streets
    const dmap = new Map();
    const prev = new Map();
    const h = [];
    for (const n of small) {
      dmap.set(n, 0);
      h.push([0, n]);
    }
    let hit = null;
    while (h.length) {
      h.sort((x, y) => y[0] - x[0]);
      const [d, n] = h.pop();
      if (d > dmap.get(n)) continue;
      if (big.has(n)) {
        hit = n;
        break;
      }
      for (const l of n.links) {
        if (selected.has(l)) continue;
        const m = l.a === n ? l.b : l.a;
        const nd = d + cost(l) * 1000;
        if (nd > P.bridgeCloseMax || small.has(m)) continue;
        if (nd < (dmap.get(m) ?? Infinity)) {
          dmap.set(m, nd);
          prev.set(m, l);
          h.push([nd, m]);
        }
      }
    }
    if (hit) {
      for (let n = hit; !small.has(n); ) {
        const l = prev.get(n);
        select(l);
        n = l.a === n ? l.b : l.a;
      }
      joined++;
    } else {
      for (const l of [...selected])
        if (l === b || (small.has(l.a) && small.has(l.b))) {
          selected.delete(l);
          droppedKm += l.len / 1000;
        }
    }
  }
  console.log(`one-way loops: ${joined} connections added, ${droppedKm.toFixed(1)} km dropped`);
}

// ---- 3. runs and directions --------------------------------------------------------
// A run is a continuous piece of guideway between junctions (where 3+ selected
// links meet). Every run is one-way. Directions start from a strong
// orientation (every junction can reach every other) and are improved by
// flipping runs whenever that shortens demand-weighted travel and keeps
// everything reachable. Then one-way shortcuts are added where routes are
// much longer than the street distance, and directions are tuned again.
function makeRuns() {
  const runs = [];
  const done = new Set();
  const deg = (n) => n.links.filter((l) => selected.has(l)).length;
  const isJ = (n) => deg(n) !== 2;
  for (const l0 of selected) {
    if (done.has(l0)) continue;
    const chain = [[l0, true]];
    done.add(l0);
    for (const dir of [1, -1]) {
      let cur = l0;
      let end = dir === 1 ? l0.b : l0.a;
      while (!isJ(end)) {
        const nx = end.links.find((x) => x !== cur && selected.has(x));
        if (!nx || done.has(nx)) break;
        done.add(nx);
        const f = nx.a === end;
        if (dir === 1) chain.push([nx, f]);
        else chain.unshift([nx, !f]);
        cur = nx;
        end = f ? nx.b : nx.a;
      }
    }
    const pts = [];
    for (const [l, f] of chain) {
      const p = f ? l.pts : [...l.pts].reverse();
      pts.push(...(pts.length ? p.slice(1) : p));
    }
    const a = chain[0][1] ? chain[0][0].a : chain[0][0].b;
    const last = chain[chain.length - 1];
    const b = last[1] ? last[0].b : last[0].a;
    if (a === b) continue; // closed ring with no junction (rare): skip
    const names = [...new Set(chain.map(([l]) => l.name))];
    runs.push({ id: runs.length, chain, name: names.join(' / '), pts, len: polylineLength(pts), a, b, bridge: chain.some(([l]) => l.bridge), freeway: chain.some(([l]) => l.freeway) });
  }
  return runs;
}

const activityCache = new Map();
const activityAt = (n) => {
  if (!activityCache.has(n)) activityCache.set(n, blocksNear([n.p], 500).reduce((a, i) => a + blocks[i].w, 0) + 1);
  return activityCache.get(n);
};
let rnd3 = 777;
const rand3 = () => ((rnd3 = (rnd3 * 1103515245 + 12345) % 2147483648) / 2147483648);

class Heap {
  constructor() {
    this.a = [];
  }
  push(k, v) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

// Orient runs. `init` = starting directions (1 = a->b, -1 = b->a) or null.
function orient(runs, init) {
  const jn = [...new Set(runs.flatMap((r) => [r.a, r.b]))];
  const ji = new Map(jn.map((n, i) => [n, i]));
  const ends = runs.map((r) => [ji.get(r.a), ji.get(r.b)]);
  const dir = new Int8Array(runs.length);
  {
    const adj = jn.map(() => []);
    runs.forEach((r, k) => {
      adj[ends[k][0]].push([ends[k][1], k]);
      adj[ends[k][1]].push([ends[k][0], k]);
    });
    const disc = new Array(jn.length).fill(-1);
    const used = new Uint8Array(runs.length);
    for (let s0 = 0; s0 < jn.length; s0++) {
      if (disc[s0] !== -1) continue;
      disc[s0] = 1;
      const stack = [[s0, 0]];
      while (stack.length) {
        const top = stack[stack.length - 1];
        const v = top[0];
        if (top[1] < adj[v].length) {
          const [w, k] = adj[v][top[1]++];
          if (used[k]) continue;
          used[k] = 1;
          dir[k] = ends[k][0] === v ? 1 : -1;
          if (disc[w] === -1) {
            disc[w] = 1;
            stack.push([w, 0]);
          }
        } else stack.pop();
      }
    }
  }
  // repair: flip runs between strongly connected parts until everything connects
  const sccCount = () => {
    const out = jn.map(() => []);
    runs.forEach((r, k) => {
      const [a, b] = dir[k] === 1 ? ends[k] : [ends[k][1], ends[k][0]];
      out[a].push(b);
    });
    const index = new Array(jn.length).fill(-1);
    const low = new Array(jn.length).fill(0);
    const on = new Uint8Array(jn.length);
    const st = [];
    const comp = new Int32Array(jn.length);
    let ix = 0;
    let nc = 0;
    for (let s0 = 0; s0 < jn.length; s0++) {
      if (index[s0] !== -1) continue;
      const work = [[s0, 0]];
      index[s0] = low[s0] = ix++;
      st.push(s0);
      on[s0] = 1;
      while (work.length) {
        const top = work[work.length - 1];
        const v = top[0];
        if (top[1] < out[v].length) {
          const w = out[v][top[1]++];
          if (index[w] === -1) {
            index[w] = low[w] = ix++;
            st.push(w);
            on[w] = 1;
            work.push([w, 0]);
          } else if (on[w]) low[v] = Math.min(low[v], index[w]);
        } else {
          work.pop();
          if (work.length) low[work[work.length - 1][0]] = Math.min(low[work[work.length - 1][0]], low[v]);
          if (low[v] === index[v]) {
            let w;
            do {
              w = st.pop();
              on[w] = 0;
              comp[w] = nc;
            } while (w !== v);
            nc++;
          }
        }
      }
    }
    return { nc, comp };
  };
  // From that always-connected start, turn each run toward its preferred
  // direction (e.g. alternating lattice lines) whenever that keeps everything
  // reachable.
  if (init) {
    let agreed = 0;
    for (let sweep = 0; sweep < 3; sweep++) {
      let changed = false;
      for (let k = 0; k < runs.length; k++) {
        if (dir[k] === init[k]) continue;
        dir[k] = init[k];
        if (sccCount().nc === 1) changed = true;
        else dir[k] = -dir[k];
      }
      if (!changed) break;
    }
    for (let k = 0; k < runs.length; k++) if (dir[k] === init[k]) agreed++;
    console.log(`preferred directions kept on ${agreed} of ${runs.length} runs`);
  }
  const wN = jn.map(activityAt);
  const totW = wN.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = rand3() * totW;
    for (let i = 0; i < wN.length; i++) if ((r -= wN[i]) <= 0) return i;
    return wN.length - 1;
  };
  const sources = Array.from({ length: 60 }, pick);
  function objective() {
    const out = jn.map(() => []);
    runs.forEach((r, k) => {
      const [a, b] = dir[k] === 1 ? ends[k] : [ends[k][1], ends[k][0]];
      out[a].push([b, r.len]);
    });
    // everything must get back to the first source
    {
      const back = jn.map(() => []);
      out.forEach((l, v) => l.forEach(([w]) => back[w].push(v)));
      const seen = new Uint8Array(jn.length);
      const q = [sources[0]];
      seen[sources[0]] = 1;
      let c = 1;
      while (q.length) {
        const v = q.pop();
        for (const u of back[v])
          if (!seen[u]) {
            seen[u] = 1;
            c++;
            q.push(u);
          }
      }
      if (c < jn.length) return Infinity;
    }
    let tot = 0;
    for (const s0 of sources) {
      const d = new Float64Array(jn.length).fill(Infinity);
      d[s0] = 0;
      const h = new Heap();
      h.push(0, s0);
      while (h.size) {
        const [dv, v] = h.pop();
        if (dv > d[v]) continue;
        for (const [w, len] of out[v])
          if (dv + len < d[w]) {
            d[w] = dv + len;
            h.push(d[w], w);
          }
      }
      for (let i = 0; i < jn.length; i++) {
        if (d[i] === Infinity) return Infinity;
        // weight by activity, relative to straight-line distance so long trips don't dominate
        const sl = dist(jn[s0].p, jn[i].p);
        if (sl > 800) tot += (wN[i] * d[i]) / sl;
      }
    }
    return tot;
  }
  let best = objective();
  const start = best;
  let flips = 0;
  for (let sweep = 0; sweep < 3; sweep++) {
    let improved = false;
    for (let k = 0; k < runs.length; k++) {
      dir[k] = -dir[k];
      const o = objective();
      if (o < best) {
        best = o;
        flips++;
        improved = true;
      } else dir[k] = -dir[k];
    }
    if (!improved) break;
  }
  console.log(`directions: ${flips} flips, weighted route ratio ${((100 * best) / start).toFixed(1)}% of the start`);
  return dir;
}
function setLinkDirs(runs, dir) {
  runs.forEach((r, k) => {
    for (const [l, f] of r.chain) l.dir = (dir[k] === 1) === f ? 1 : -1;
  });
}
function runDirsFromLinks(runs) {
  return runs.map((r) => {
    let fw = 0;
    for (const [l, f] of r.chain) fw += (l.dir === 1) === f ? l.len : -l.len;
    return fw >= 0 ? 1 : -1;
  });
}

// Directed shortcuts: for busy pairs of places where the one-way route is much
// longer than a street route, add the street route as a new one-way line in
// the direction that helps. Adding a one-way link never strands anyone.
function directedShortcuts() {
  const budget = P.directShortcutKm * 1000;
  let added = 0;
  let count = 0;
  const travel = (l, from) => {
    // can a vehicle use link l leaving node `from`? returns cost or Infinity
    if (selected.has(l)) {
      const forward = l.a === from;
      return (l.dir === 1) === forward ? l.len : Infinity;
    }
    return cost(l) * 1000;
  };
  for (let iter = 0; iter < 200 && added < budget; iter++) {
    const sn = [...selNodes()];
    const wN = sn.map(activityAt);
    const totW = wN.reduce((a, b) => a + b, 0);
    const pick = () => {
      let r = rand3() * totW;
      for (let i = 0; i < wN.length; i++) if ((r -= wN[i]) <= 0) return i;
      return wN.length - 1;
    };
    let best = null;
    let bestScore = 0;
    for (let k = 0; k < 24; k++) {
      const si = pick();
      const s0 = sn[si];
      // network distances (selected links only, in their direction)
      const dNet = new Map([[s0, 0]]);
      {
        const h = new Heap();
        h.push(0, s0);
        while (h.size) {
          const [d, n] = h.pop();
          if (d > dNet.get(n)) continue;
          for (const l of n.links) {
            if (!selected.has(l)) continue;
            const c = travel(l, n);
            if (c === Infinity) continue;
            const m = l.a === n ? l.b : l.a;
            if (d + c < (dNet.get(m) ?? Infinity)) {
              dNet.set(m, d + c);
              h.push(d + c, m);
            }
          }
        }
      }
      // with new streets allowed
      const dAll = new Map([[s0, 0]]);
      const prev = new Map();
      {
        const h = new Heap();
        h.push(0, s0);
        while (h.size) {
          const [d, n] = h.pop();
          if (d > dAll.get(n)) continue;
          if (d > 12000) break;
          for (const l of n.links) {
            const c = travel(l, n);
            if (c === Infinity) continue;
            const m = l.a === n ? l.b : l.a;
            if (d + c < (dAll.get(m) ?? Infinity)) {
              dAll.set(m, d + c);
              prev.set(m, [l, n]);
              h.push(d + c, m);
            }
          }
        }
      }
      for (let j = 0; j < sn.length; j++) {
        const t = sn[j];
        const sl = dist(s0.p, t.p);
        if (sl < 1200) continue;
        const a = dNet.get(t);
        const b = dAll.get(t);
        if (a === undefined || b === undefined || a <= b * 1.05) continue;
        // new street length on the improved path
        let newLen = 0;
        for (let n = t; n !== s0; ) {
          const [l, from] = prev.get(n);
          if (!selected.has(l)) newLen += l.len;
          n = from;
        }
        if (newLen < 50) continue;
        const score = (wN[si] * wN[j] * (a - b)) / sl / newLen;
        if (score > bestScore) {
          bestScore = score;
          best = { s0, t, prev };
        }
      }
    }
    if (!best) break;
    for (let n = best.t; n !== best.s0; ) {
      const [l, from] = best.prev.get(n);
      if (!selected.has(l)) {
        select(l);
        l.dir = l.a === from ? 1 : -1;
        added += l.len;
      }
      n = from;
    }
    count++;
  }
  console.log(`directed shortcuts: ${count} added, ${(added / 1000).toFixed(1)} km`);
}

let beams;
{
  let runs = makeRuns();
  const prefInit = runs.map((r) => {
    let v = 0;
    for (const [l, f] of r.chain) if (l.pref) v += (l.pref === 1) === f ? l.len : -l.len;
    return v >= 0 ? 1 : -1;
  });
  let dir = orient(runs, P.layout === 'lattice' ? prefInit : null);
  setLinkDirs(runs, dir);
  directedShortcuts();
  runs = makeRuns();
  dir = orient(runs, runDirsFromLinks(runs));
  setLinkDirs(runs, dir);
  // replace the selection by runs; node.links must point at runs now
  for (const n of gnodes.values()) n.links = n.links.filter((l) => !selected.has(l));
  selected.clear();
  for (const r of runs) {
    selected.add(r);
    r.a.links.push(r);
    r.b.links.push(r);
  }
  console.log(`runs between junctions: ${selected.size}`);
  beams = runs.map((r, k) => (dir[k] === 1 ? { link: r, from: r.a, to: r.b, pts: r.pts } : { link: r, from: r.b, to: r.a, pts: [...r.pts].reverse() }));
  for (const r of runs) r.oneway = 'F';
}

// ---- 5. station sites (chosen before building geometry) ---------------------------
const parcelsRaw = fs.existsSync(raw('parcels.json')) ? JSON.parse(fs.readFileSync(raw('parcels.json'))) : { rows: [] };
// Publicly owned land (not parks): city, county, state, Met Council, county rail authority, university.
const PUBLIC = /^(CITY OF MINNEAPOLIS|CITY OF MPLS)\s*$|COUNTY OF HENNEPIN|HENNEPIN COUNTY|HENNEPIN FORFEITED|HENNEPIN CO REGIONAL R|STATE OF MINN|STATE OF MN|METROPOLITAN COUNCIL|REGENTS/i;
const parcels = [];
for (const [type, owner, area, land, bldg, lat, lon] of parcelsRaw.rows) {
  if (lat == null || lon == null) continue;
  const t = (type || '').toUpperCase();
  let why = null;
  if (/VACANT/.test(t)) why = 'vacant land';
  else if (/^LAND/.test(t)) why = 'commercial or industrial land with no building (often parking)';
  else if (PUBLIC.test(owner || '')) why = 'publicly owned';
  else if (/COMMERCIAL|INDUSTRIAL/.test(t) && (bldg || 0) < 0.4 * (land || 0) && (area || 0) > 1500) why = 'lightly built commercial (likely parking)';
  if (why) parcels.push({ p: project([lon, lat]), why, type, owner });
}
const phash = new Map();
for (const [i, q] of parcels.entries()) {
  const k = `${Math.floor(q.p[0] / CELL)},${Math.floor(q.p[1] / CELL)}`;
  if (!phash.has(k)) phash.set(k, []);
  phash.get(k).push(i);
}
function siteNear(p, r = 90) {
  let best = null;
  let bd = r;
  for (let cx = Math.floor((p[0] - r) / CELL); cx <= Math.floor((p[0] + r) / CELL); cx++)
    for (let cy = Math.floor((p[1] - r) / CELL); cy <= Math.floor((p[1] + r) / CELL); cy++)
      for (const i of phash.get(`${cx},${cy}`) || []) {
        const d = dist(parcels[i].p, p);
        if (d < bd) {
          bd = d;
          best = parcels[i];
        }
      }
  return best;
}
console.log(`plausible station parcels: ${parcels.length}`);

// Junction clearance: room for ramps at each end of a link.
const X = (n) => (selDegree(n) <= 1 ? 40 : P.rampX);
const cands = [];
for (const l of selected) {
  const cum = cumulative(l.pts);
  const lo = X(l.a) + P.stationHalfSpan + 15;
  const hi = l.len - X(l.b) - P.stationHalfSpan - 15;
  for (let s = lo; s <= hi; s += 30) {
    const p = pointAlong(l.pts, cum, s);
    if (lakes.some((r) => pointInRing(p, r)) || !pointInRing(p, city)) continue;
    const site = siteNear(p);
    cands.push({ link: l, s, p, cover: blocksNear([p], P.coverStation), site, factor: site ? 1 : 0.5 });
  }
}
const scov = new Uint8Array(blocks.length);
let scovW = 0;
const sites = [];
for (;;) {
  let best = null;
  let bs = 0;
  let bg = 0;
  for (const c of cands) {
    if (c.taken) continue;
    if (sites.some((s) => dist(s.p, c.p) < P.stationMinSep)) {
      c.taken = true;
      continue;
    }
    const g = c.cover.reduce((a, i) => a + (scov[i] ? 0 : blocks[i].w), 0);
    if (g * c.factor > bs) {
      bs = g * c.factor;
      best = c;
      bg = g;
    }
  }
  if (!best || bg / W < P.stationMinGain || scovW / W >= P.stationTargetCoverage) break;
  best.taken = true;
  sites.push(best);
  for (const i of best.cover)
    if (!scov[i]) {
      scov[i] = 1;
      scovW += blocks[i].w;
    }
}
console.log(`station sites: ${sites.length}, coverage of people+jobs within ~400 m walk: ${(scovW / W).toFixed(3)}`);

// ---- 4. simulator graph -------------------------------------------------------------
const nodes = [];
const edges = [];
const node = (p) => {
  nodes.push({ id: nodes.length, x: p[0], y: p[1] });
  return nodes.length - 1;
};
const edge = (from, to, pts, vmax, kind, extra = {}) => {
  const pp = pts.map(r1);
  edges.push({ id: edges.length, from, to, pts: pp, len: polylineLength(pp), vmax, kind, ...extra });
  return edges.length - 1;
};
// Main-line edges, split into pieces of at most 150 m, each tagged with its
// tightest curve radius so speed can follow the street's bends.
function radiusOf(pts) {
  const cum = cumulative(pts);
  const L = cum[cum.length - 1];
  let rmin = Infinity;
  for (let s0 = 0; s0 + 40 <= L; s0 += 10) {
    const A = pointAlong(pts, cum, s0);
    const B = pointAlong(pts, cum, s0 + 20);
    const C = pointAlong(pts, cum, s0 + 40);
    const a = dist(B, C);
    const b = dist(A, C);
    const c = dist(A, B);
    const area2 = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
    if (area2 > 1e-6) rmin = Math.min(rmin, (a * b * c) / (2 * area2));
  }
  return rmin;
}
function mainEdge(from, to, pts, extra) {
  const cum = cumulative(pts);
  const L = cum[cum.length - 1];
  const k = Math.max(1, Math.ceil(L / 150));
  let prev = from;
  for (let i = 0; i < k; i++) {
    const piece = slice(pts, cum, (L * i) / k, (L * (i + 1)) / k);
    const next = i === k - 1 ? to : node(piece[piece.length - 1]);
    const r = radiusOf(piece);
    edge(prev, next, piece, P.vMain, 'main', r < 2000 ? { ...extra, radius: Math.round(Math.max(r, 8)) } : extra);
    prev = next;
  }
}
const stations = [];
for (const b of beams) {
  b.pts = b.twin ? offsetLine(b.pts, P.twinOffset) : b.pts;
  b.cum = cumulative(b.pts);
  b.len = b.cum[b.cum.length - 1];
  b.x0 = Math.min(X(b.from), b.len / 3);
  b.x1 = Math.min(X(b.to), b.len / 3);
  b.m = node(pointAlong(b.pts, b.cum, b.x0)); // start of the beam's main section (merge side)
  b.d = node(pointAlong(b.pts, b.cum, b.len - b.x1)); // end (diverge side)
  // stations on this beam
  const here = sites
    .filter((s) => s.link === b.link)
    .map((s) => ({ site: s, at: b.from === b.link.a ? s.s : b.link.len - s.s }))
    .sort((x, y) => x.at - y.at);
  let cur = b.m;
  let curS = b.x0;
  for (const { site, at } of here) {
    const H = P.stationHalfSpan;
    const B = P.berthHalfLength;
    if (at - H < curS + 5 || at + H > b.len - b.x1 - 5) continue;
    const u = dirAt(b.pts, b.cum, at);
    const r = right(u);
    const c = pointAlong(b.pts, b.cum, at);
    const atp = (d, off) => add(add(c, mul(u, d)), mul(r, off));
    const sd = node(pointAlong(b.pts, b.cum, at - H));
    const sm = node(pointAlong(b.pts, b.cum, at + H));
    const sin = node(atp(-B, P.stationOffset));
    const sout = node(atp(B, P.stationOffset));
    mainEdge(cur, sd, slice(b.pts, b.cum, curS, at - H), { bridge: b.link.bridge, street: b.link.name });
    mainEdge(sd, sm, slice(b.pts, b.cum, at - H, at + H), { street: b.link.name });
    const curve = (d0, d1, o0, o1) => {
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        const f = k / 8;
        const e = (1 - Math.cos(Math.PI * f)) / 2;
        pts.push(atp(d0 + (d1 - d0) * f, o0 + (o1 - o0) * e));
      }
      return pts;
    };
    const id = stations.length;
    const entry = edge(sd, sin, curve(-H, -B, 0, P.stationOffset), P.vMain, 'stEntry', { station: id });
    const berth = edge(sin, sout, [atp(-B, P.stationOffset), atp(B, P.stationOffset)], P.vStation, 'berth', { station: id });
    const exit = edge(sout, sm, curve(B, H, P.stationOffset, 0), P.vMain, 'stExit', { station: id });
    stations.push({
      id,
      x: Math.round(c[0] * 10) / 10,
      y: Math.round(c[1] * 10) / 10,
      dir: u.map((v) => Math.round(v * 1000) / 1000),
      street: b.link.name,
      site: site.site ? { why: site.site.why, type: site.site.type } : null,
      entry,
      berth,
      exit,
      inNode: sin,
      outNode: sout,
      berths: P.berths,
    });
    cur = sm;
    curS = at + H;
  }
  mainEdge(cur, b.d, slice(b.pts, b.cum, curS, b.len - b.x1), { bridge: b.link.bridge, street: b.link.name });
}

// Junction connectors.
let turnRamps = 0;
let turnarounds = 0;
const byNodeIn = new Map();
const byNodeOut = new Map();
for (const b of beams) {
  if (!byNodeIn.has(b.to)) byNodeIn.set(b.to, []);
  byNodeIn.get(b.to).push(b);
  if (!byNodeOut.has(b.from)) byNodeOut.set(b.from, []);
  byNodeOut.get(b.from).push(b);
}
for (const [J, ins] of byNodeIn) {
  const outs = byNodeOut.get(J) || [];
  const deadEnd = selDegree(J) === 1;
  for (const bi of ins) {
    const D = [nodes[bi.d].x, nodes[bi.d].y];
    const uIn = dirAt(bi.pts, bi.cum, bi.len - bi.x1);
    for (const bo of outs) {
      const isU = bo.link === bi.link;
      if (isU && !deadEnd) continue;
      const M = [nodes[bo.m].x, nodes[bo.m].y];
      const uOut = dirAt(bo.pts, bo.cum, bo.x0);
      if (isU) {
        // turnaround loop beyond the end of the line
        const Rr = 14;
        const c = add(J.p, mul(uIn, 20));
        const pts = [D, add(J.p, mul(uIn, 0))];
        for (let k = 0; k <= 10; k++) {
          const a = (Math.PI * k) / 10;
          const v = add(mul(right(uIn), -Math.cos(a) * Rr * -1), mul(uIn, Math.sin(a) * Rr));
          pts.push(add(c, add(mul(right(uIn), -P.twinOffset * 0), v)));
        }
        pts.push(M);
        edge(bi.d, bo.m, pts, Math.sqrt(P.latAccel * Rr), 'turn', { radius: Rr });
        turnarounds++;
        continue;
      }
      const cos = uIn[0] * uOut[0] + uIn[1] * uOut[1];
      const theta = Math.acos(Math.max(-1, Math.min(1, cos))); // 0 = straight on
      if (theta < (25 * Math.PI) / 180) {
        edge(bi.d, bo.m, [D, M], P.vMain, 'main');
        continue;
      }
      // decel lane, curve, accel lane
      const R = Math.min(P.rampRadius, bi.x1 * 0.4, bo.x0 * 0.4);
      const A = sub(J.p, mul(uIn, R));
      const Bp = add(J.p, mul(uOut, R));
      const curve = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        // quadratic Bezier A -> J -> B
        curve.push(add(add(mul(A, (1 - t) ** 2), mul(J.p, 2 * t * (1 - t))), mul(Bp, t * t)));
      }
      const rEff = Math.max(6, R * Math.tan((Math.PI - theta) / 2));
      const a = node(A);
      const bn = node(Bp);
      edge(bi.d, a, [D, A], P.vMain, 'rampLane');
      edge(a, bn, curve, Math.min(P.vMain, Math.sqrt(P.latAccel * rEff)), 'turn', { radius: Math.round(rEff * 10) / 10 });
      edge(bn, bo.m, [Bp, M], P.vMain, 'rampLane');
      turnRamps++;
    }
  }
}

// ---- keep the largest strongly connected component ---------------------------------
function largestSCC() {
  const out = nodes.map(() => []);
  for (const e of edges) out[e.from].push(e.to);
  const index = new Array(nodes.length).fill(-1);
  const low = new Array(nodes.length).fill(0);
  const on = new Array(nodes.length).fill(false);
  const st = [];
  const comps = [];
  let ix = 0;
  for (let s = 0; s < nodes.length; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0]];
    index[s] = low[s] = ix++;
    st.push(s);
    on[s] = true;
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      if (top[1] < out[v].length) {
        const w = out[v][top[1]++];
        if (index[w] === -1) {
          index[w] = low[w] = ix++;
          st.push(w);
          on[w] = true;
          work.push([w, 0]);
        } else if (on[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) low[work[work.length - 1][0]] = Math.min(low[work[work.length - 1][0]], low[v]);
        if (low[v] === index[v]) {
          const c = [];
          let w;
          do {
            w = st.pop();
            on[w] = false;
            c.push(w);
          } while (w !== v);
          comps.push(c);
        }
      }
    }
  }
  comps.sort((a, b) => b.length - a.length);
  return new Set(comps[0]);
}
const keep = largestSCC();
console.log(`graph: ${nodes.length} nodes, ${keep.size} in the largest strongly connected part; ${stations.length} stations placed`);
const nmap = new Map();
const fNodes = [];
for (const n of nodes)
  if (keep.has(n.id)) {
    nmap.set(n.id, fNodes.length);
    fNodes.push({ id: fNodes.length, x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10 });
  }
const emap = new Map();
const fEdges = [];
for (const e of edges)
  if (keep.has(e.from) && keep.has(e.to)) {
    emap.set(e.id, fEdges.length);
    fEdges.push({ ...e, id: fEdges.length, from: nmap.get(e.from), to: nmap.get(e.to), len: Math.round(e.len * 10) / 10 });
  }
const fStations = [];
for (const s of stations) {
  if (![s.entry, s.berth, s.exit].every((e) => emap.has(e))) continue;
  const id = fStations.length;
  fStations.push({ ...s, id, entry: emap.get(s.entry), berth: emap.get(s.berth), exit: emap.get(s.exit), inNode: nmap.get(s.inNode), outNode: nmap.get(s.outNode) });
}
for (const e of fEdges) if (e.station !== undefined) e.station = fStations.findIndex((s) => s.entry === e.id || s.berth === e.id || s.exit === e.id);

// ---- stats --------------------------------------------------------------------------
const routeKm = [...selected].reduce((a, l) => a + l.len, 0) / 1000;
const beamKm = beams.reduce((a, b) => a + b.len, 0) / 1000;
const stPts = fStations.map((s) => [s.x, s.y]);
// Coverage at a quarter, third and half mile; walking distance approximated
// as straight-line x 1.25.
const walkCut = { quarterMile: 402, thirdMile: 536, halfMile: 805 };
const cov = Object.fromEntries(Object.keys(walkCut).map((k) => [k, 0]));
let walkSum = 0;
for (const b of blocks) {
  let de = Infinity;
  for (const q of stPts) de = Math.min(de, dist(q, b.p));
  for (const [k, d] of Object.entries(walkCut)) if (de * 1.25 <= d) cov[k] += b.w;
  walkSum += b.w * de * 1.25;
}
const uniqueSites = new Set(sites).size;
const stats = {
  layout: 'streets',
  routeMiles: Math.round((routeKm / 1.609) * 10) / 10,
  guidewayMiles: Math.round((beamKm / 1.609) * 10) / 10,
  freewayMiles: Math.round(([...selected].filter((l) => l.freeway).reduce((a, l) => a + l.len, 0) / 1609) * 10) / 10,
  crossings: [...selNodes()].filter((n) => selDegree(n) >= 4).length,
  tees: [...selNodes()].filter((n) => selDegree(n) === 3).length,
  streets: new Set([...selected].map((l) => l.name)).size,
  bridges: [...selected].filter((l) => l.bridge).length,
  stationSites: uniqueSites,
  stations: fStations.length,
  plausibleSites: sites.filter((s) => s.site).length,
  turnRamps,
  turnarounds,
  nodes: fNodes.length,
  edges: fEdges.length,
  merges: fNodes.filter((n) => fEdges.filter((e) => e.to === n.id).length > 1).length,
  // share of people + jobs within this walk of a station (%)
  walkCoverage: Object.fromEntries(Object.entries(cov).map(([k, v]) => [k, Math.round((1000 * v) / W) / 10])),
};
const out = {
  params: P,
  // meanWalkM: average walk to the nearest station, weighted by people + jobs (straight line x 1.25)
  stats: { ...stats, designSpeedKmh: Math.round(P.vMain * 3.6), meanWalkM: Math.round(walkSum / W) },
  geo: { city: city.map(r1), lakes: Object.fromEntries(Object.entries(geo.lakes).map(([k, r]) => [k, r.map(project).map(r1)])), river: river.map((l) => l.map(r1)) },
  corridors: [...selected].map((l) => ({ name: l.name, oneway: l.oneway !== 'B', bridge: l.bridge, pts: l.pts.map(r1) })),
  nodes: fNodes,
  edges: fEdges,
  stations: fStations,
  uncovered: [],
};
fs.writeFileSync(new URL(`../data/${P.out || 'network'}.json`, import.meta.url), JSON.stringify(out));
console.log(JSON.stringify(stats, null, 2));
