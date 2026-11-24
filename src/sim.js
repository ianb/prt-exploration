// PRT network simulator. Runs in Node and in the browser.
//
// Vehicles follow the car ahead with the Intelligent Driver Model (IDM), using
// a time headway instead of rail-style brick-wall separation. At merges,
// vehicles from both branches are ordered by distance to the merge point and
// each follows its predecessor in that order ("virtual platoon"), so they
// zip together without colliding. Vehicles leaving a station wait for a gap in
// the main line before launching.

import { cumulative, pointAlong } from './geo.js';

export const DEFAULTS = {
  dt: 0.25, // s
  headway: 1.0, // s, IDM time headway
  minGap: 1.5, // m, standstill gap
  vehicleLength: 3.0, // m
  accel: 2.0, // m/s^2, comfortable
  decel: 2.5, // m/s^2, comfortable
  maxDecel: 5.0, // m/s^2, emergency limit
  horizon: 260, // m, look-ahead for leaders, merges and speed limits
  fleetPerStation: 4,
  tripsPerHour: 12000,
  unloadTime: 15, // s
  loadTime: 15, // s
  minTripMeters: 700, // shorter trips walk instead
  destDecayKm: 4, // gravity model distance decay
  soonS: 120, // a loaded vehicle this close counts as supply for the station
  maxEmptyS: 480, // don't send an empty vehicle from further than this
  keepIdle: 2, // idle vehicles a station keeps before lending them out
  rebalanceS: 20,
  demandData: null, // origin-destination table; null = synthetic placeholder demand
  direction: 'am',
  demandModel: false, // with survey data: true = smoothed model, false = observed table
  hourFrom: 0, // for hourly tables: departures in [hourFrom, hourTo)
  hourTo: 24,
  berths: 0, // override berths per station (0 = use the network's)
  seed: 1,
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple binary heap for Dijkstra.
class Heap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    const lk = k.pop();
    const lv = v.pop();
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.k.length;
  }
}

export class Sim {
  constructor(net, opts = {}) {
    this.p = { ...DEFAULTS, ...opts };
    this.net = net;
    this.rand = mulberry32(this.p.seed);
    this.t = 0;
    const N = net.nodes.length;
    this.edges = net.edges.map((e) => ({ ...e, cum: cumulative(e.pts), queue: [] }));
    this.outEdges = Array.from({ length: N }, () => []);
    this.inEdges = Array.from({ length: N }, () => []);
    for (const e of this.edges) {
      this.outEdges[e.from].push(e.id);
      this.inEdges[e.to].push(e.id);
    }
    this.isMerge = this.inEdges.map((l) => l.length > 1);
    this.stations = net.stations.map((s) => ({
      ...s,
      waiting: [], // passengers
      reserved: 0, // vehicles committed to entering
      inbound: 0, // empty vehicles sent here to pick up
      served: 0,
      waveOffs: 0,
    }));
    if (this.p.berths) for (const s of this.stations) s.berths = this.p.berths;
    this.stationAtSd = new Map(); // diverge node -> station
    this.stationAtSm = new Map(); // merge node after the station -> station
    for (const s of this.stations) {
      this.stationAtSd.set(this.edges[s.entry].from, s);
      this.stationAtSm.set(this.edges[s.exit].to, s);
    }
    this.buildRoutes();
    this.buildDemand();
    this.vehicles = [];
    this.placeFleet();
    this.stats = { diverted: 0, boarded: 0, completed: 0, waitSum: 0, rideSum: 0, waitMax: 0, waveOffs: 0, emptyMoves: 0, minGap: Infinity, collisions: 0, generated: 0 };
    this.nextArrival = this.sampleArrival();
  }

  // ---- routing ----------------------------------------------------------
  // For each station, a reverse Dijkstra over travel time gives the next edge
  // to take from every node, and the remaining time.
  buildRoutes() {
    const N = this.net.nodes.length;
    const S = this.stations.length;
    this.nextHop = new Int32Array(S * N).fill(-1);
    this.timeTo = new Float32Array(S * N).fill(Infinity);
    const usable = (e, sid) => e.station === undefined || e.station === sid;
    for (const st of this.stations) {
      const base = st.id * N;
      const entry = this.edges[st.entry];
      const start = entry.from;
      this.timeTo[base + start] = 0;
      this.nextHop[base + start] = entry.id;
      const h = new Heap();
      h.push(0, start);
      while (h.size) {
        const n = h.pop();
        const tn = this.timeTo[base + n];
        for (const eid of this.inEdges[n]) {
          const e = this.edges[eid];
          if (!usable(e, -1)) continue; // never route through a station's own lanes
          const t = tn + e.len / e.vmax;
          if (t < this.timeTo[base + e.from]) {
            this.timeTo[base + e.from] = t;
            this.nextHop[base + e.from] = eid;
            h.push(t, e.from);
          }
        }
      }
    }
    // Travel time between stations: from the exit merge of one to the entry diverge of another.
    this.stationTime = (a, b) => this.timeTo[b * N + this.edges[this.stations[a].exit].to];
    this.nearbyGeo = this.stations.map((a) =>
      this.stations
        .filter((b) => b.id !== a.id)
        .map((b) => [b.id, Math.hypot(a.x - b.x, a.y - b.y)])
        .sort((x, y) => x[1] - y[1])
        .slice(0, 6)
        .map((x) => x[0])
    );
    this.reach = this.stations.map((a) =>
      this.stations
        .filter((b) => b.id !== a.id)
        .map((b) => [b.id, this.stationTime(a.id, b.id)])
        .filter((x) => x[1] < this.p.maxEmptyS)
        .sort((x, y) => x[1] - y[1])
        .map((x) => x[0])
    );
    this.nearby = this.stations.map((a) =>
      this.stations
        .filter((b) => b.id !== a.id)
        .map((b) => [b.id, this.stationTime(b.id, a.id)])
        .sort((x, y) => x[1] - y[1])
        .map((x) => x[0])
    );
  }

  // Next edge for a vehicle at node n.
  nextEdge(v, n) {
    const outs = this.outEdges[n];
    if (outs.length === 1) return outs[0];
    const st = this.stationAtSd.get(n);
    if (st && v.waveOff === st.id) {
      return outs.find((e) => this.edges[e].kind === 'main');
    }
    return this.nextHop[v.target * this.net.nodes.length + n];
  }

  // ---- demand -----------------------------------------------------------
  // Placeholder demand until real data: every station generates trips, with
  // extra weight downtown and at the University; destinations follow a
  // gravity model.
  buildDemand() {
    if (this.p.demandData?.model && this.p.demandModel) return this.buildModelDemand(this.p.demandData.model);
    if (this.p.demandData) return this.buildTableDemand(this.p.demandData);
    const hubs = [
      { x: 360, y: 3220, w: 12, r: 1200 }, // downtown
      { x: 3400, y: 2950, w: 4, r: 900 }, // University of Minnesota
      { x: 850, y: 0, w: 1.5, r: 900 }, // Lake St / Midtown
      { x: -2300, y: 300, w: 1.5, r: 900 }, // Uptown
    ];
    this.weight = this.stations.map((s) => 1 + hubs.reduce((a, h) => a + h.w * Math.exp(-((s.x - h.x) ** 2 + (s.y - h.y) ** 2) / (2 * h.r * h.r)), 0));
    const total = this.weight.reduce((a, b) => a + b, 0);
    this.originCdf = [];
    let c = 0;
    for (const w of this.weight) this.originCdf.push((c += w / total));
    this.destCdf = this.stations.map((a) => {
      const cdf = [];
      let acc = 0;
      for (const b of this.stations) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const w = d < this.p.minTripMeters ? 0 : this.weight[b.id] * Math.exp(-d / 1000 / this.p.destDecayKm);
        cdf.push((acc += w));
      }
      return cdf.map((x) => x / acc);
    });
  }

  // Demand from an origin-destination table. Two shapes:
  //  - commutes (LODES): [home station, work station, count]. 'am' runs
  //    home -> work, 'pm' work -> home, 'both' mixes the two.
  //  - trips by hour (TBI survey): [origin, destination, depart hour, trips],
  //    filtered to hours [hourFrom, hourTo).
  buildTableDemand(data) {
    const S = this.stations.length;
    const rowsByOrigin = Array.from({ length: S }, () => []);
    for (const row of data.od) {
      if (row.length === 4) {
        const [o, d, h, n] = row;
        if (h >= this.p.hourFrom && h < this.p.hourTo) rowsByOrigin[o].push([d, n]);
        continue;
      }
      const [h, w, n] = row;
      if (this.p.direction !== 'pm') rowsByOrigin[h].push([w, n]);
      if (this.p.direction !== 'am') rowsByOrigin[w].push([h, n]);
    }
    const tot = rowsByOrigin.map((r) => r.reduce((a, x) => a + x[1], 0));
    const all = tot.reduce((a, b) => a + b, 0);
    this.originCdf = [];
    let c = 0;
    for (const t of tot) this.originCdf.push((c += t / all));
    this.destLists = rowsByOrigin.map((r, o) => {
      let acc = 0;
      const ids = [];
      const cdf = [];
      for (const [d, n] of r) {
        ids.push(d);
        cdf.push((acc += n));
      }
      return { ids, cdf: cdf.map((x) => x / (tot[o] || 1)) };
    });
  }

  // Smoothed survey model: pick a trip type (origin purpose, destination
  // purpose) in proportion to the survey's trips in the chosen hours, an origin
  // station by attraction for that purpose, and a destination by attraction
  // times exp(-beta * km).
  buildModelDemand(m) {
    this.model = m;
    const cls = [];
    let acc = 0;
    for (const [h, op, dp, n] of m.trips) {
      if (h < this.p.hourFrom || h >= this.p.hourTo) continue;
      cls.push([op, dp]);
      this.classCdfRaw = this.classCdfRaw || [];
      this.classCdfRaw.push((acc += n));
    }
    this.classes = cls;
    this.classCdf = this.classCdfRaw.map((x) => x / acc);
    this.attrCdf = m.attraction ? Object.fromEntries(m.purposes.map((p) => [p, this.cdfOf(m.attraction[p])])) : {};
    this.destCache = new Map();
  }

  cdfOf(w) {
    let a = 0;
    const c = w.map((x) => (a += x));
    return c.map((x) => x / (a || 1));
  }

  modelTrip() {
    const m = this.model;
    const [op, dp] = this.classes[this.pick(this.classCdf)];
    const o = this.pick(this.attrCdf[m.purposes[op]]);
    const key = dp * this.stations.length + o;
    let cdf = this.destCache.get(key);
    if (!cdf) {
      const a = this.stations[o];
      const A = m.attraction[m.purposes[dp]];
      const beta = m.beta[m.purposes[dp]];
      cdf = this.cdfOf(
        this.stations.map((b, j) => {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          return d < m.minTripMeters ? 0 : A[j] * Math.exp((-beta * d) / 1000);
        })
      );
      this.destCache.set(key, cdf);
    }
    return [o, this.pick(cdf)];
  }

  pickDest(o) {
    if (this.destLists) {
      const l = this.destLists[o];
      return l.ids.length ? l.ids[this.pick(l.cdf)] : o;
    }
    return this.pick(this.destCdf[o]);
  }

  pick(cdf) {
    const r = this.rand();
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cdf[m] < r) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  sampleArrival(from = this.t) {
    const rate = this.p.tripsPerHour / 3600;
    return from + (rate > 0 ? -Math.log(1 - this.rand()) / rate : Infinity);
  }

  // ---- fleet ------------------------------------------------------------
  // Stations have sawtooth berths: each docked vehicle sits in its own bay
  // off the berth lane and can leave without waiting for the others.
  placeFleet() {
    for (const st of this.stations) {
      st.slots = new Array(st.berths).fill(null);
      for (let k = 0; k < this.p.fleetPerStation && k < st.berths; k++) {
        const v = { id: this.vehicles.length, edge: st.berth, pos: 0, v: 0, target: st.id, state: 'idle', station: st.id, timer: 0, pax: null, waveOff: -1 };
        this.vehicles.push(v);
        this.dock(v, st);
        st.reserved++;
      }
    }
  }

  dock(v, st) {
    const k = st.slots.indexOf(null);
    st.slots[k] = v;
    v.docked = true;
    v.slot = k;
    v.dockStation = st.id;
    v.v = 0;
    v.edge = st.berth;
    v.pos = ((k + 0.5) / st.berths) * this.edges[st.berth].len;
  }

  // ---- main step --------------------------------------------------------
  step() {
    const { dt } = this.p;
    this.t += dt;
    while (this.nextArrival <= this.t) {
      this.newPassenger();
      this.nextArrival = this.sampleArrival(this.nextArrival);
    }
    if (Math.floor(this.t / this.p.rebalanceS) !== Math.floor((this.t - dt) / this.p.rebalanceS)) this.rebalance();
    this.lookAhead();
    this.stationLogic();
    this.move();
  }

  newPassenger() {
    let o;
    let d;
    if (this.model) [o, d] = this.modelTrip();
    else {
      o = this.pick(this.originCdf);
      d = this.pickDest(o);
    }
    if (o === d) return;
    this.stats.generated++;
    const st = this.stations[o];
    st.waiting.push({ origin: o, dest: d, t0: this.t });
    // Call an empty vehicle if the station can't cover its queue, counting
    // vehicles already docked and loaded vehicles about to arrive.
    if (st.waiting.length > this.supply(st)) this.callEmpty(st);
  }

  supply(st) {
    let n = st.inbound;
    for (const v of st.slots) if (v && (v.state === 'idle' || v.state === 'unloading')) n++;
    const N = this.net.nodes.length;
    for (const v of this.vehicles) {
      if (v.target !== st.id || v.state !== 'loaded' || v.docked) continue;
      const e = this.edges[v.edge];
      if (this.timeTo[st.id * N + e.to] + (e.len - v.pos) / e.vmax < this.p.soonS) n++;
    }
    return n;
  }

  // Every so often, stations with more idle vehicles than they need send one
  // to the nearest station that has none on hand or on the way.
  rebalance() {
    for (const st of this.stations) {
      let idle = 0;
      for (const v of st.slots) if (v && v.state === 'idle') idle++;
      if (idle <= this.p.keepIdle || st.waiting.length) continue;
      const crowded = st.berths - st.reserved < 3;
      if (!crowded && idle <= this.p.keepIdle * 2) continue;
      for (const sid of this.reach[st.id]) {
        const t = this.stations[sid];
        let have = t.inbound + t.waiting.length * -1;
        for (const v of t.slots) if (v && v.state === 'idle') have++;
        if (have < 1 && t.reserved < t.berths) {
          this.dispatch(this.frontIdle(st), sid, 'reposition');
          t.inbound++;
          this.stats.emptyMoves++;
          break;
        }
      }
    }
  }

  callEmpty(st) {
    for (const sid of this.nearby[st.id]) {
      if (this.stationTime(sid, st.id) > this.p.maxEmptyS) break;
      const src = this.stations[sid];
      const v = this.frontIdle(src);
      if (!v) continue;
      // Leave at least one vehicle behind if that station has people waiting.
      if (src.waiting.length > 0) continue;
      this.dispatch(v, st.id, 'toPickup');
      st.inbound++;
      this.stats.emptyMoves++;
      return true;
    }
    return false;
  }

  // An idle vehicle docked at a station.
  frontIdle(st) {
    for (const v of st.slots) if (v && v.state === 'idle') return v;
    return null;
  }

  dispatch(v, target, state) {
    v.target = target;
    v.state = state;
    v.station = -1;
    v.waveOff = -1;
    v.departing = true; // waits for a gap before launching
  }

  stationLogic() {
    const { dt } = this.p;
    for (const v of this.vehicles) {
      if (v.station < 0) continue;
      const st = this.stations[v.station];
      if (v.state === 'arriving') {
        const e = this.edges[v.edge];
        if (e.kind === 'berth' && v.v < 0.05 && e.queue[0] === v && e.len - v.pos < 2 && st.slots.includes(null)) {
          e.queue.shift();
          this.dock(v, st);
          v.state = 'unloading';
          v.timer = v.pax ? this.p.unloadTime : 0;
        }
      } else if (v.state === 'unloading') {
        v.timer -= dt;
        if (v.timer <= 0) {
          if (v.pax) {
            this.stats.completed++;
            this.stats.rideSum += this.t - v.pax.tBoard;
            v.pax = null;
          }
          v.state = 'idle';
        }
      } else if (v.state === 'loading') {
        v.timer -= dt;
        if (v.timer <= 0) this.dispatch(v, v.pax.dest, 'loaded');
      }
    }
    // Board waiting passengers onto front-most idle vehicles.
    for (const st of this.stations) {
      while (st.waiting.length) {
        const v = this.frontIdle(st);
        if (!v) break;
        const pax = st.waiting.shift();
        const w = this.t - pax.t0;
        this.stats.waitSum += w;
        this.stats.boarded++;
        this.stats.waitMax = Math.max(this.stats.waitMax, w);
        pax.tBoard = this.t + this.p.loadTime;
        v.pax = pax;
        v.state = 'loading';
        v.timer = this.p.loadTime;
        st.served++;
      }
    }
  }

  // Walk ahead of every moving vehicle: find merges it will pass, speed limits,
  // the station it will stop at, and the first vehicle physically ahead.
  lookAhead() {
    const H = this.p.horizon;
    const N = this.net.nodes.length;
    this.mergeReg = new Map();
    for (const e of this.edges) for (let i = 0; i < e.queue.length; i++) e.queue[i].qi = i;
    for (const v of this.vehicles) {
      v.ahead = { merges: [], limits: [], stopAt: Infinity, leaderGap: Infinity, leaderV: 0 };
      if (v.docked) continue;
      let e = this.edges[v.edge];
      // Leader on the same edge
      if (v.qi > 0) {
        const l = e.queue[v.qi - 1];
        v.ahead.leaderGap = l.pos - v.pos - this.p.vehicleLength;
        v.ahead.leaderV = l.v;
        v.ahead.leader = l;
      }
      if (v.state === 'arriving' && e.kind === 'berth') v.ahead.stopAt = e.len - 0.5 - v.pos;
      if (e.kind === 'berth') continue; // arriving vehicles stop at the end of the berth lane
      let d = e.len - v.pos;
      let guard = 0;
      while (d < H && guard++ < 20) {
        const n = e.to;
        // Station diverge: commit to entering, or wave off if it's full.
        const st = this.stationAtSd.get(n);
        if (st && st.id === v.target && v.state !== 'arriving' && v.waveOff !== st.id && !v.committed) {
          if (st.reserved < st.berths) {
            st.reserved++;
            v.committed = true;
          } else {
            st.waveOffs++;
            this.stats.waveOffs++;
            this.relieve(st);
            // Full station. A loaded or repositioning vehicle goes to the
            // closest neighbour with room (its rider walks a little further);
            // a vehicle coming to pick someone up goes around and tries again.
            const alt = v.state === 'toPickup' ? null : this.nearbyGeo[st.id].find((sid) => this.stations[sid].reserved < this.stations[sid].berths);
            if (alt !== undefined && alt !== null) {
              if (v.state === 'reposition') {
                st.inbound--;
                this.stations[alt].inbound++;
              }
              v.target = alt;
              if (v.pax) this.stats.diverted++;
            } else {
              v.waveOff = st.id;
            }
          }
        }
        if (this.isMerge[n]) v.ahead.merges.push([n, d]);
        const nextId = this.nextEdge(v, n);
        if (nextId < 0 || nextId === undefined) break;
        const ne = this.edges[nextId];
        v.ahead.limits.push([d, ne.vmax]);
        if (v.ahead.leaderGap === Infinity && ne.queue.length) {
          const tail = ne.queue[ne.queue.length - 1];
          v.ahead.leaderGap = d + tail.pos - this.p.vehicleLength;
          v.ahead.leaderV = tail.v;
          v.ahead.leader = tail;
        }
        if (ne.kind === 'berth') {
          // will stop somewhere in this berth; at most at its end
          v.ahead.stopAt = Math.min(v.ahead.stopAt, d + ne.len - 0.5);
          break;
        }
        d += ne.len;
        e = ne;
      }
      for (const [n, dist] of v.ahead.merges) {
        let l = this.mergeReg.get(n);
        if (!l) this.mergeReg.set(n, (l = []));
        l.push([dist, v]);
      }
    }
    for (const l of this.mergeReg.values()) l.sort((a, b) => a[0] - b[0] || a[1].id - b[1].id);
    void N;
  }

  // A station that has to wave off arrivals sends one idle vehicle away.
  relieve(st) {
    const v = this.frontIdle(st);
    if (!v) return;
    for (const sid of this.reach[st.id]) {
      const s2 = this.stations[sid];
      if (s2.reserved < s2.berths - 2) {
        this.dispatch(v, sid, 'reposition');
        s2.inbound++;
        this.stats.emptyMoves++;
        return;
      }
    }
  }

  isParked(v) {
    return !!v.docked;
  }

  idm(v, gap, vLead, v0) {
    const { accel: a, decel: b, headway: T, minGap: s0 } = this.p;
    const free = 1 - Math.pow(v.v / Math.max(v0, 0.1), 4);
    if (gap === Infinity) return a * free;
    const sStar = s0 + Math.max(0, v.v * T + (v.v * (v.v - vLead)) / (2 * Math.sqrt(a * b)));
    return a * (free - Math.pow(sStar / Math.max(gap, 0.1), 2));
  }

  // Can a vehicle waiting in the berth launch now without cutting off main-line traffic?
  launchClear(v) {
    const st = this.stations[v.dockStation];
    const ex = this.edges[st.exit];
    // room at the start of the exit lane
    if (ex.queue.length && ex.queue[ex.queue.length - 1].pos < this.p.vehicleLength + this.p.minGap + 3) return false;
    const sm = ex.to;
    const reg = this.mergeReg.get(sm) || [];
    const dist = ex.len;
    const vm = this.edges[st.exit].vmax;
    // time to reach the merge accelerating from rest (capped at exit speed)
    const tAcc = vm / this.p.accel;
    const dAcc = (vm * vm) / (2 * this.p.accel);
    const tMe = dist <= dAcc ? Math.sqrt((2 * dist) / this.p.accel) : tAcc + (dist - dAcc) / vm;
    const window = 2.5 * this.p.headway + 1;
    for (const [d, u] of reg) {
      if (this.edges[u.edge].station === st.id) continue;
      const tU = d / Math.max(u.v, 1);
      if (Math.abs(tU - tMe) < window) return false;
    }
    return true;
  }

  move() {
    const { dt, maxDecel } = this.p;
    const L = this.p.vehicleLength;
    // compute accelerations first
    for (const v of this.vehicles) {
      v.acc = 0;
      v.blocker = null;
      v.blockerVirtual = false;
      if (v.departing) {
        // Docked and ready: launch onto the exit lane when there's a slot in the main line.
        if (!this.launchClear(v)) continue;
        const st = this.stations[v.dockStation];
        st.slots[v.slot] = null;
        st.reserved--; // the bay is free only once the vehicle has actually left
        v.docked = false;
        v.departing = false;
        v.committed = false;
        v.edge = st.exit;
        v.pos = 0;
        v.v = 0;
        this.edges[st.exit].queue.push(v);
        continue; // starts moving next step, once it's in the look-ahead
      }
      if (this.isParked(v)) continue;
      const e = this.edges[v.edge];
      let v0 = e.vmax;
      for (const [d, lim] of v.ahead.limits) v0 = Math.min(v0, Math.sqrt(lim * lim + 2 * this.p.decel * Math.max(0, d - 2)));
      let a = this.idm(v, v.ahead.leaderGap, v.ahead.leaderV, v0);
      if (v.ahead.stopAt !== Infinity) a = Math.min(a, this.idm(v, v.ahead.stopAt + this.p.minGap, 0, v0));
      v.accPhysical = a;
      v.blocker = v.ahead.leader || null;
      v.blockerVirtual = false;
      for (const [n, dist] of v.ahead.merges) {
        const l = this.mergeReg.get(n);
        if (!l) continue;
        const i = l.findIndex((x) => x[1] === v);
        if (i > 0) {
          const [pd, pv] = l[i - 1];
          const am = this.idm(v, dist - pd - L, pv.v, v0);
          if (am < a) {
            a = am;
            v.blocker = pv;
            v.blockerVirtual = true;
          }
        }
      }
      v.acc = Math.max(-maxDecel, a);
    }
    this.breakDeadlocks();
    // then integrate
    for (const v of this.vehicles) {
      if (this.isParked(v)) {
        v.v = 0;
        continue;
      }
      if (v.acc === 0 && v.v === 0) continue;
      const nv = Math.max(0, v.v + v.acc * dt);
      let ds = (v.v + nv) * 0.5 * dt;
      v.v = nv;
      if (ds <= 0) continue;
      let e = this.edges[v.edge];
      v.pos += ds;
      while (v.pos >= e.len) {
        const n = e.to;
        const nextId = this.nextEdge(v, n);
        if (nextId < 0 || nextId === undefined) {
          v.pos = e.len;
          v.v = 0;
          break;
        }
        v.pos -= e.len;
        e.queue.shift();
        const ne = this.edges[nextId];
        ne.queue.push(v);
        ne.count = (ne.count || 0) + 1;
        v.edge = nextId;
        if (ne.kind === 'stEntry') {
          if (v.state === 'toPickup' || v.state === 'reposition') this.stations[ne.station].inbound--;
          v.station = ne.station;
          v.state = 'arriving';
          v.committed = false;
        }
        // Passed a station it was waved off from: try again next lap.
        if (v.waveOff >= 0 && this.stationAtSd.get(n)?.id === v.waveOff) v.waveOff = -1;
        e = ne;
      }
    }
    // safety check
    for (const e of this.edges)
      for (let i = 1; i < e.queue.length; i++) {
        const g = e.queue[i - 1].pos - e.queue[i].pos - L;
        if (g < this.stats.minGap && e.kind !== 'berth') this.stats.minGap = g;
        if (g < 0) this.stats.collisions++;
      }
  }

  // Waiting on merge order can form a cycle: A waits for B at one merge, B is
  // stuck behind C on its lane, and C waits for A at another merge. When a
  // stopped vehicle's chain of blockers leads back to itself, let it ignore
  // its merge predecessor; everyone else in the loop is standing still, so
  // it can go safely and the loop unwinds.
  breakDeadlocks() {
    for (const v of this.vehicles) {
      if (!v.blockerVirtual || v.v > 0.5 || v.acc > 0.1) continue;
      let u = v.blocker;
      let k = 0;
      while (u && u !== v && k++ < 200) u = u.blocker;
      if (u === v) {
        v.acc = Math.max(-this.p.maxDecel, v.accPhysical);
        v.blocker = null;
        v.blockerVirtual = false;
        this.stats.deadlocksBroken = (this.stats.deadlocksBroken || 0) + 1;
      }
    }
  }

  // ---- reporting --------------------------------------------------------
  summary() {
    const s = this.stats;
    const by = {};
    for (const v of this.vehicles) by[v.state] = (by[v.state] || 0) + 1;
    const waiting = this.stations.reduce((a, st) => a + st.waiting.length, 0);
    const oldest = this.stations.reduce((a, st) => (st.waiting.length ? Math.max(a, this.t - st.waiting[0].t0) : a), 0);
    return {
      t: Math.round(this.t),
      vehicles: this.vehicles.length,
      byState: by,
      generated: s.generated,
      completed: s.completed,
      waiting,
      oldestWaitS: Math.round(oldest),
      avgWaitS: s.boarded ? Math.round((s.waitSum / s.boarded) * 10) / 10 : 0,
      maxWaitS: Math.round(s.waitMax),
      avgRideS: s.completed ? Math.round(s.rideSum / s.completed) : 0,
      emptyMoves: s.emptyMoves,
      waveOffs: s.waveOffs,
      diverted: s.diverted,
      minGapM: Math.round(s.minGap * 100) / 100,
      busiestLinkVph: Math.round((Math.max(...this.edges.filter((e) => e.kind === 'main').map((e) => e.count || 0)) * 3600) / this.t),
      collisions: s.collisions,
      deadlocksBroken: s.deadlocksBroken || 0,
    };
  }

  // Positions for drawing.
  positions() {
    return this.vehicles.map((v) => {
      const e = this.edges[v.edge];
      let [x, y] = pointAlong(e.pts, e.cum, v.pos);
      if (v.docked) {
        // bays angle off to the right of the berth lane
        const st = this.stations[v.dockStation];
        x += st.dir[1] * 5;
        y -= st.dir[0] * 5;
      }
      return { x, y, state: v.state, v: v.v, docked: !!v.docked };
    });
  }
}
