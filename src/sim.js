// PRT network simulator. Runs in Node and in the browser.
//
// Vehicles follow the car ahead with the Intelligent Driver Model (IDM), using
// a time headway instead of rail-style brick-wall separation.
//
// Merges are coordinated with booked slots: as a vehicle comes within range of
// a merge it books a time to pass it, spaced at least one headway from every
// other booking there, and then caps its speed at the average needed to
// arrive on time. A vehicle leaving a station books its
// slot before it launches. Vehicles keep their order on each approach, so
// bookings never conflict with the physical queue.
//
// Ride comfort comes from a preset: 'rail' (top-supported, little banking) or
// 'suspended' (hangs below the beam and swings into curves, so riders feel
// the force mostly through the seat and curves can be taken faster).

import { cumulative, pointAlong } from './geo.js';

// Comfort presets, from ASCE 21 (automated people mover standards) and
// J. E. Anderson's PRT design values. latAccel is the horizontal acceleration a
// curve may use (felt sideways force plus what banking or swing absorbs);
// accel / decel are normal-service rates.
//  standing:  0.1 g sideways, 0.13 g speeding up / slowing (ASCE, standing riders)
//  flat:      seated, unbanked track: 0.2 g sideways, 0.2 g fore-aft
//  rail:      seated, top-supported with ~6 deg banking: 0.2 g felt + bank = ~0.3 g
//  suspended: seated, cabin swings (damped) ~21 deg: ~0.38 g with little felt sideways
// Anderson notes a banked top-supported vehicle and a swinging one reach about
// the same radius; the swing allowed is the suspended design's main lever.
export const COMFORT = {
  standing: { latAccel: 0.98, accel: 1.27, decel: 1.27 },
  flat: { latAccel: 1.96, accel: 1.96, decel: 1.96 },
  rail: { latAccel: 3.0, accel: 1.96, decel: 1.96 },
  suspended: { latAccel: 3.7, accel: 1.96, decel: 1.96 },
};

export const DEFAULTS = {
  dt: 0.25, // s
  headway: 1.0, // s, IDM time headway
  minGap: 1.5, // m, standstill gap
  vehicleLength: 3.0, // m
  comfort: 'rail', // or 'suspended'; sets latAccel, accel and decel unless given
  maxDecel: 5.0, // m/s^2, emergency limit
  vMain: Infinity, // m/s line speed cap; the network's design speed applies otherwise
  horizon: 320, // m, look-ahead for leaders, merges and speed limits
  launchSlack: 2, // s a station launch accepts its merge slot being later than it could get there
  fleetPerStation: 4,
  tripsPerHour: 12000,
  unloadTime: 15, // s
  loadTime: 15, // s
  minTripMeters: 700, // shorter trips walk instead
  destDecayKm: 4, // gravity model distance decay
  soonS: 120, // a loaded vehicle this close counts as supply for the station
  maxEmptyS: 480, // don't send an empty vehicle from further than this
  keepIdle: 2, // idle vehicles a station keeps before lending them out
  rebalanceS: 30,
  forecastS: 600, // s ahead that predictive rebalancing plans for
  placeByDemand: true, // start the fleet where the first trips will be
  rebalanceMaxPerStation: 3, // empties sent to one station per rebalancing round
  // Event surge (e.g. a stadium letting out). null = none. See setupEvent().
  event: null,
  maxLaunchWait: 8, // s a ready vehicle waits for a gap before claiming one
  bumpMinDist: 80, // m: main-line vehicles at least this far from a merge can be asked to yield to a station launch
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
    this.p = { ...DEFAULTS, ...(COMFORT[opts.comfort || DEFAULTS.comfort] || COMFORT.rail), ...opts };
    this.net = net;
    this.rand = mulberry32(this.p.seed);
    this.t = 0;
    const N = net.nodes.length;
    this.edges = net.edges.map((e) => ({ ...e, cum: cumulative(e.pts), queue: [] }));
    // Curve speeds follow the comfort preset: v = sqrt(lateral accel x radius).
    for (const e of this.edges) {
      if (e.kind === 'turn') {
        const r = e.radius ?? (e.vmax * e.vmax) / 1.5;
        e.vmax = Math.min(this.p.vMain, Math.sqrt(this.p.latAccel * r));
      } else {
        e.vmax = Math.min(e.vmax, this.p.vMain);
        if (e.radius) e.vmax = Math.min(e.vmax, Math.sqrt(this.p.latAccel * e.radius));
      }
    }
    this.mergeSlots = new Map(); // merge node -> bookings sorted by time
    this.lastIn = new Map(); // "node|in-edge" -> latest booking from that approach
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
    if (!this.hours) this.originShare = this.originCdf ? this.originCdf.map((c, i) => c - (i ? this.originCdf[i - 1] : 0)) : null;
    this.vehicles = [];
    if (this.p.event) this.setupEvent(this.p.event);
    this.placeFleet();
    this.stats = { diverted: 0, boarded: 0, completed: 0, waitSum: 0, rideSum: 0, waitMax: 0, waveOffs: 0, emptyMoves: 0, minGap: Infinity, collisions: 0, generated: 0 };
    this.nextArrival = this.sampleArrival();
    this.tripLog = [];
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
    const dd = this.p.demandData;
    if (dd && dd.stations !== undefined && dd.stations !== this.stations.length)
      throw new Error(`demand table was built for ${dd.stations} stations but this network has ${this.stations.length}: rebuild it (npm run build:network)`);
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
  // Demand varies by hour: sim time 0 is hourFrom:00. tripsPerHour is the
  // rate in the busiest hour of the window; other hours scale with the survey.
  buildModelDemand(m) {
    this.model = m;
    this.hours = [];
    for (let h = this.p.hourFrom; h < this.p.hourTo; h++) {
      const classes = [];
      const raw = [];
      let acc = 0;
      for (const [hh, op, dp, n] of m.trips) {
        if (hh !== h) continue;
        classes.push([op, dp, n]);
        raw.push((acc += n));
      }
      this.hours.push({ h, classes, cdf: raw.map((x) => x / acc), total: acc });
    }
    const peak = Math.max(...this.hours.map((x) => x.total));
    for (const hr of this.hours) hr.factor = hr.total / peak;
    this.attrCdf = m.attraction ? Object.fromEntries(m.purposes.map((p) => [p, this.cdfOf(m.attraction[p])])) : {};
    // share of departures from each station, per hour (for forecasting)
    const S = this.stations.length;
    const attrShare = Object.fromEntries(
      m.purposes.map((p) => {
        const a = m.attraction[p];
        const tot = a.reduce((x, y) => x + y, 0) || 1;
        return [p, a.map((x) => x / tot)];
      })
    );
    for (const hr of this.hours) {
      hr.share = new Float64Array(S);
      for (const [op, , n] of hr.classes) {
        const sh = attrShare[m.purposes[op]];
        for (let o = 0; o < S; o++) hr.share[o] += (n / hr.total) * sh[o];
      }
    }
    this.destCache = new Map();
  }

  hourIndex(t) {
    if (!this.hours) return 0;
    return Math.min(this.hours.length - 1, Math.max(0, Math.floor(t / 3600)));
  }

  rateFactor(t) {
    return this.hours ? this.hours[this.hourIndex(t)].factor : 1;
  }

  // Expected trips starting at station o between t0 and t1 (from the demand model).
  expectedDepartures(o, t0, t1) {
    return this.baseDepartures(o, t0, t1) + this.eventDepartures(o, t0, t1);
  }

  eventDepartures(o, t0, t1) {
    const ev = this.event;
    if (!ev || !ev.share[o]) return 0;
    const overlap = Math.max(0, Math.min(t1, ev.end) - Math.max(t0, ev.start));
    return (ev.parties / (ev.end - ev.start)) * overlap * ev.share[o];
  }

  baseDepartures(o, t0, t1) {
    const lam = this.p.tripsPerHour / 3600;
    if (!this.hours) return lam * (t1 - t0) * this.originShare[o];
    let tot = 0;
    for (let t = t0; t < t1; ) {
      const i = this.hourIndex(t);
      const end = Math.min(t1, (i + 1) * 3600);
      const span = Math.max(0, end - t) || t1 - t;
      tot += lam * this.hours[i].factor * this.hours[i].share[o] * span;
      t += span;
    }
    return tot;
  }

  cdfOf(w) {
    let a = 0;
    const c = w.map((x) => (a += x));
    return c.map((x) => x / (a || 1));
  }

  modelTrip() {
    const m = this.model;
    const hr = this.hours[this.hourIndex(this.t)];
    const [op, dp] = hr.classes[this.pick(hr.cdf)];
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
    const S = this.stations.length;
    const total = this.p.fleetPerStation * S;
    let alloc = new Array(S).fill(this.p.fleetPerStation);
    if (this.p.placeByDemand && (this.hours || this.originShare)) {
      const need = this.stations.map((st) => this.expectedDepartures(st.id, 0, 1200));
      const sum = need.reduce((a, b) => a + b, 0) || 1;
      alloc = need.map((x) => Math.max(1, Math.round((x / sum) * total)));
      // fit within berths (leave room for arrivals), hand leftovers to the roomiest stations
      let left = total - alloc.reduce((a, b) => a + b, 0);
      alloc = alloc.map((a, i) => Math.min(a, this.stations[i].berths - 2));
      left = total - alloc.reduce((a, b) => a + b, 0);
      for (let i = 0; left > 0 && i < 50 * S; i++) {
        const k = i % S;
        if (alloc[k] < this.stations[k].berths - 2) {
          alloc[k]++;
          left--;
        }
      }
    }
    for (const st of this.stations) {
      st.slots = new Array(st.berths).fill(null);
      for (let k = 0; k < alloc[st.id] && k < st.berths; k++) {
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
      if (this.rand() < this.rateFactor(this.nextArrival)) this.newPassenger();
      this.nextArrival = this.sampleArrival(this.nextArrival);
    }
    if (this.event) this.eventStep();
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

  // ---- event surge ------------------------------------------------------------
  // ev = { at: [x, y], start, duration (s), parties (vehicle loads), radius (m,
  //        stations fans may walk to), berths (bays at those stations),
  //        queueSecPerParty (how long fans expect each party ahead to take),
  //        groups: [{ name, share, weights: per-station destination weights }] }
  // Fans leave the venue at a steady rate over the window, pick the station
  // with the best walk + visible queue, and walk there.
  setupEvent(ev) {
    const S = this.stations.length;
    const near = this.stations
      .map((st) => ({ st, walk: (Math.hypot(st.x - ev.at[0], st.y - ev.at[1]) * 1.25) / 1.3 }))
      .filter((x) => x.walk * 1.04 <= (ev.radius * 1.25) / 1.3);
    if (ev.berths) for (const x of near) x.st.berths = Math.max(x.st.berths, ev.berths);
    const share = new Float64Array(S);
    let tot = 0;
    for (const x of near) tot += Math.exp(-x.walk / 240);
    for (const x of near) share[x.st.id] = Math.exp(-x.walk / 240) / tot;
    const groups = ev.groups.map((g) => ({ ...g, cdf: this.cdfOf(Array.from(g.weights)) }));
    const gcdf = this.cdfOf(groups.map((g) => g.share));
    // staging ring: stations a short hop away keep themselves stocked with empties
    // during the event, so the venue's stations refill in minutes, not from across town
    const nearIds = new Set(near.map((x) => x.st.id));
    const staging = new Set(
      this.stations.filter((st) => !nearIds.has(st.id) && Math.hypot(st.x - ev.at[0], st.y - ev.at[1]) <= (ev.stagingRadius ?? 0)).map((st) => st.id)
    );
    this.event = { ...ev, end: ev.start + ev.duration, near, share, groups, gcdf, next: ev.start, pending: [], headed: {}, staging, maxPerStation: ev.maxPerStation ?? 12 };
    this.eventLog = [];
    this.eventLeft = 0;
  }

  eventStep() {
    const ev = this.event;
    const rate = ev.parties / ev.duration;
    while (ev.next <= this.t && ev.next < ev.end) {
      // pick the station with the best walk + expected queue. Fans (or a
      // stadium app) see everyone already waiting or walking there, and the
      // vehicles already there or on the way.
      let best = null;
      let bc = Infinity;
      for (const x of ev.near) {
        let idle = 0;
        for (const v of x.st.slots) if (v && v.state === 'idle') idle++;
        const ahead = x.st.waiting.length + (ev.headed[x.st.id] || 0) - idle - x.st.inbound;
        const c = x.walk + Math.max(0, ahead) * ev.queueSecPerParty;
        if (c < bc) {
          bc = c;
          best = x;
        }
      }
      ev.headed[best.st.id] = (ev.headed[best.st.id] || 0) + 1;
      const g = ev.groups[this.pick(ev.gcdf)];
      let d = this.pick(g.cdf);
      if (d === best.st.id) d = this.nearbyGeo[d][0];
      ev.pending.push({ at: ev.next + best.walk, origin: best.st.id, dest: d, walk: best.walk, left: ev.next, group: g.name });
      this.eventLeft++;
      ev.next += -Math.log(1 - this.rand()) / rate;
    }
    if (ev.pending.length) {
      const still = [];
      for (const q of ev.pending) {
        if (q.at > this.t) {
          still.push(q);
          continue;
        }
        const st = this.stations[q.origin];
        ev.headed[q.origin]--;
        st.waiting.push({ origin: q.origin, dest: q.dest, t0: q.at, event: true, walk: q.walk, left: q.left, group: q.group });
        this.stats.generated++;
        if (st.waiting.length > this.supply(st)) this.callEmpty(st);
      }
      ev.pending = still;
    }
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
  // Predictive rebalancing. Every rebalanceS seconds, compare each station's
  // expected departures over the next forecastS seconds (from the demand
  // model) with the vehicles it will have: idle ones, empties on the way, and
  // loaded vehicles arriving in time. Stations short of vehicles get empties
  // sent from the nearest stations with more than they need, before the
  // riders show up.
  rebalance() {
    const W = this.p.forecastS;
    const S = this.stations.length;
    const N = this.net.nodes.length;
    const soon = new Float64Array(S);
    for (const v of this.vehicles) {
      if (v.docked || v.state !== 'loaded') continue;
      const e = this.edges[v.edge];
      const eta = this.timeTo[v.target * N + e.to] + (e.len - v.pos) / e.vmax + this.p.unloadTime;
      if (eta < W) soon[v.target]++;
    }
    const idle = new Int32Array(S);
    const bal = new Float64Array(S);
    for (const st of this.stations) {
      for (const v of st.slots) if (v && v.state === 'idle') idle[st.id]++;
      let need = this.expectedDepartures(st.id, this.t, this.t + W) + st.waiting.length;
      // during an event, venue and staging stations want to be full of empties
      const ev = this.event;
      if (ev && this.t > ev.start - ev.prepS && this.t < ev.end + 1800 && (ev.share[st.id] || ev.staging.has(st.id))) need = Math.max(need, st.berths - 2);
      bal[st.id] = idle[st.id] + st.inbound + soon[st.id] - need;
    }
    const deficits = this.stations.filter((st) => bal[st.id] < -0.5).sort((a, b) => bal[a.id] - bal[b.id]);
    let moves = 0;
    for (const d of deficits) {
      const evSt = this.event && (this.event.share[d.id] || this.event.staging.has(d.id));
      let k = Math.min(evSt ? this.event.maxPerStation : this.p.rebalanceMaxPerStation, Math.ceil(-bal[d.id]));
      for (const sid of this.nearby[d.id]) {
        if (k <= 0 || d.reserved + d.inbound >= d.berths) break;
        if (this.stationTime(sid, d.id) > 1.5 * W) break;
        const src = this.stations[sid];
        if (bal[sid] < 1.5 || idle[sid] <= 0 || src.waiting.length) continue;
        const v = this.frontIdle(src);
        if (!v) continue;
        this.dispatch(v, d.id, 'reposition');
        d.inbound++;
        bal[sid]--;
        idle[sid]--;
        bal[d.id]++;
        k--;
        moves++;
        this.stats.emptyMoves++;
        this.stats.predictiveMoves = (this.stats.predictiveMoves || 0) + 1;
      }
    }
    // stations filling up with idle vehicles still lend them out
    for (const st of this.stations) if (st.berths - st.reserved < 2 && idle[st.id] > 0 && bal[st.id] > 1) this.relieve(st);
    return moves;
  }

  callEmpty(st) {
    // never send more vehicles than the station has free bays for: a surplus
    // can only circle, and enough circling jams the network
    if (st.reserved + st.inbound >= st.berths) return false;
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
    v.dispatchedAt = this.t;
    v.dispatchedFrom = v.dockStation;
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
          st.docks = (st.docks || 0) + 1;
          if (this.onDock) this.onDock(v, st);
          v.state = 'unloading';
          v.timer = v.pax ? this.p.unloadTime : 0;
        }
      } else if (v.state === 'unloading') {
        v.timer -= dt;
        if (v.timer <= 0) {
          if (v.pax) {
            if (v.pax.event) this.eventLog.push({ left: v.pax.left, walk: v.pax.walk, wait: v.pax.wait, ride: this.t - v.pax.tBoard + this.p.loadTime, origin: v.pax.origin, dest: v.pax.dest, group: v.pax.group });
            this.stats.completed++;
            this.stats.rideSum += this.t - v.pax.tBoard;
            const a = this.stations[v.pax.origin];
            const b = this.stations[v.pax.dest];
            // per-trip log: straight-line metres, wait s, ride s (boarding to off the vehicle)
            // [straight-line m, wait s, ride s (board to off), guideway m travelled, s spent moving, origin station, destination station, request time]
            this.tripLog.push([Math.hypot(a.x - b.x, a.y - b.y), v.pax.wait, this.t - v.pax.tBoard + this.p.loadTime, (v.odo || 0) - v.pax.odo0, (v.moveT || 0) - v.pax.mt0, v.pax.origin, v.pax.dest, v.pax.t0]);
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
        pax.wait = w;
        this.stats.boarded++;
        this.stats.waitMax = Math.max(this.stats.waitMax, w);
        pax.tBoard = this.t + this.p.loadTime;
        pax.odo0 = v.odo || 0;
        pax.mt0 = v.moveT || 0;
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
              this.releaseAll(v); // route changed: book again
              if (v.pax) this.stats.diverted++;
            } else {
              v.waveOff = st.id;
            }
          }
        }
        if (this.isMerge[n]) v.ahead.merges.push([n, d, e.id]);
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
      let prevT = -Infinity;
      let prevD = 0;
      let prevV = 1;
      for (const [n, dist, inEdge] of v.ahead.merges) {
        let l = this.mergeReg.get(n);
        if (!l) this.mergeReg.set(n, (l = []));
        l.push([dist, v]);
        // book a slot (or a later one if this vehicle has fallen behind its booking);
        // a merge further on can't be reached before the booking at the one before it allows
        const vNode = Math.min(this.edges[inEdge].vmax, this.edges[this.outEdges[n][0]].vmax);
        const eta = Math.max(this.t + this.etaPath(v, dist), prevT + (dist - prevD) / prevV);
        const have = v.res?.get(n);
        if (have && eta <= have.t + have.g) {
          prevT = have.t;
          prevD = dist;
          prevV = Math.max(vNode, 1);
          continue;
        }
        if (have) {
          this.release(v, n);
          this.stats.rebooks = (this.stats.rebooks || 0) + 1;
        }
        const sl = this.book(v, n, inEdge, eta, vNode, null, dist);
        prevT = sl.t;
        prevD = dist;
        prevV = Math.max(vNode, 1);
      }
    }
    void N;
  }

  // ---- merge slots --------------------------------------------------------------
  // Time to cover d metres along this vehicle's path, respecting the speed
  // limits ahead (curves, station lanes) and comfortable acceleration.
  etaPath(v, d) {
    const { accel: a, decel: b } = this.p;
    const segs = [];
    let at = 0;
    let lim = this.edges[v.edge].vmax;
    for (const [dl, vm] of v.ahead.limits) {
      if (dl >= d) break;
      if (dl > at) segs.push([dl - at, lim]);
      at = dl;
      lim = vm;
    }
    segs.push([d - at, lim]);
    let t = 0;
    let cur = v.v;
    for (const [len, vm] of segs) {
      if (len <= 0) continue;
      if (cur < vm) {
        const dA = (vm * vm - cur * cur) / (2 * a);
        if (dA >= len) {
          const ve = Math.sqrt(cur * cur + 2 * a * len);
          t += (ve - cur) / a;
          cur = ve;
          continue;
        }
        t += (vm - cur) / a + (len - dA) / vm;
      } else {
        // slowing for this segment happens before it; approximate the loss
        t += (cur - vm) ** 2 / (2 * b * Math.max(cur, 0.5)) + len / Math.max(vm, 0.5);
      }
      cur = vm;
    }
    return t;
  }

  // Time to cover d metres starting at speed v0 and settling at speed vc.
  eta(d, v0, vc) {
    const { accel: a, decel: b } = this.p;
    if (v0 < vc) {
      const dA = (vc * vc - v0 * v0) / (2 * a);
      if (dA >= d) return (-v0 + Math.sqrt(v0 * v0 + 2 * a * d)) / a;
      return (vc - v0) / a + (d - dA) / vc;
    }
    const dB = (v0 * v0 - vc * vc) / (2 * b);
    if (dB >= d) return d / Math.max(0.5, (v0 + vc) / 2);
    return (v0 - vc) / b + (d - dB) / Math.max(vc, 0.5);
  }

  // Cruise speed vc such that: cruise at vc, then accelerate to vNode just in
  // time, covering dist in exactly T seconds. vNode if there is time to spare
  // at full speed is not needed (on time or late).
  paceSpeed(dist, T, vNode) {
    const a = this.p.accel;
    const time = (vc) => {
      const dUp = (vNode * vNode - vc * vc) / (2 * a);
      if (dUp >= dist) return Infinity; // can't both cruise slow and get up to speed
      return (dist - dUp) / vc + (vNode - vc) / a;
    };
    if (T <= dist / vNode + 0.2) return vNode;
    let lo = 0.3;
    let hi = vNode;
    if (time(lo) < T) return lo;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (time(mid) > T) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  // Earliest time >= t0 at merge n that keeps the spacing from every booking,
  // and keeps this approach's vehicles in the order they're queued.
  freeSlot(n, inEdge, t0, g, dist = Infinity) {
    const list = this.mergeSlots.get(n) || [];
    // stay behind vehicles physically ahead on the same approach
    let t = t0;
    for (const s of list) {
      if (s.inEdge !== inEdge) continue;
      const sd = s.v.ahead?.merges.find((m) => m[0] === n)?.[1];
      if (sd !== undefined && sd < dist) t = Math.max(t, s.t + Math.max(g, s.g));
    }
    for (const s of list) {
      const sep = Math.max(g, s.g);
      if (t <= s.t - sep) break;
      if (t < s.t + sep) t = s.t + sep;
    }
    return t;
  }

  book(v, n, inEdge, eta, vNode, t = null, dist = Infinity) {
    const g = this.p.headway + (this.p.vehicleLength + this.p.minGap) / Math.max(vNode, 1);
    const slot = { t: t ?? this.freeSlot(n, inEdge, eta, g, dist), g, v, vNode, inEdge };
    let list = this.mergeSlots.get(n);
    if (!list) this.mergeSlots.set(n, (list = []));
    let i = list.length;
    while (i > 0 && list[i - 1].t > slot.t) i--;
    list.splice(i, 0, slot);
    if (!v.res) v.res = new Map();
    v.res.set(n, slot);
    return slot;
  }

  release(v, n) {
    const slot = v.res?.get(n);
    if (!slot) return;
    const list = this.mergeSlots.get(n);
    const i = list.indexOf(slot);
    if (i >= 0) list.splice(i, 1);
    v.res.delete(n);
  }

  releaseAll(v) {
    if (v.res) for (const n of [...v.res.keys()]) this.release(v, n);
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

  // A vehicle waiting in a bay launches once it holds a merge slot it can
  // make: it books the slot first, so main-line traffic is never cut off.
  // After maxLaunchWait it takes the next free slot, however late.
  tryLaunch(v, force) {
    const st = this.stations[v.dockStation];
    const ex = this.edges[st.exit];
    if (ex.queue.length && ex.queue[ex.queue.length - 1].pos < this.p.vehicleLength + this.p.minGap + 3) return false;
    const n = ex.to;
    const vNode = Math.min(ex.vmax, this.edges[this.outEdges[n][0]].vmax);
    const eta = this.t + this.eta(ex.len, 0, vNode);
    const g = this.p.headway + (this.p.vehicleLength + this.p.minGap) / Math.max(vNode, 1);
    let t = this.freeSlot(n, ex.id, eta, g, ex.len);
    if (t > eta + this.p.launchSlack && !force) return false;
    if (t > eta + this.p.launchSlack) {
      // Fair share: a vehicle that has waited its turn claims the slot it can
      // make, and main-line vehicles still far enough away to slow down
      // comfortably are pushed back (they book again behind it).
      let tt = eta;
      for (const sl of [...(this.mergeSlots.get(n) || [])]) {
        const sep = Math.max(g, sl.g);
        if (Math.abs(sl.t - tt) >= sep) continue;
        const pd = sl.v.ahead?.merges.find((m) => m[0] === n)?.[1];
        if (sl.inEdge !== ex.id && pd !== undefined && pd > this.p.bumpMinDist) this.release(sl.v, n);
        else tt = Math.max(tt, sl.t + sep);
      }
      t = this.freeSlot(n, ex.id, tt, g, ex.len);
      this.stats.launchClaims = (this.stats.launchClaims || 0) + 1;
    }
    this.book(v, n, ex.id, eta, vNode, t);
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
        // Docked and ready: launch onto the exit lane when there's a slot in
        // the main line. After waiting a while it goes anyway, and main-line
        // traffic makes room at the merge (a vehicle can't wait forever).
        v.launchWait = (v.launchWait || 0) + this.p.dt;
        if (!this.tryLaunch(v, v.launchWait > this.p.maxLaunchWait)) continue;
        v.launchWait = 0;
        const st = this.stations[v.dockStation];
        st.slots[v.slot] = null;
        st.launches = (st.launches || 0) + 1;
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
        const slot = v.res?.get(n);
        if (!slot) continue;
        // pace: cruise at the speed that, followed by a comfortable speed-up,
        // crosses the merge at line speed exactly at the booked time
        const vc = this.paceSpeed(dist, slot.t - this.t, slot.vNode);
        if (vc < slot.vNode) {
          const dUp = (slot.vNode * slot.vNode - vc * vc) / (2 * this.p.accel);
          if (dist > dUp + 1) {
            const ag = Math.max(-this.p.decel, Math.min(this.p.accel, (vc - v.v) / 1.5));
            if (ag < a) {
              a = ag;
              v.blocker = null;
              v.blockerVirtual = false;
            }
          }
        }
        // last 50 m: also fall in behind whoever is physically closer to the merge
        if (dist < 50) {
          const reg = this.mergeReg.get(n) || [];
          let best = null;
          for (const [pd, pv] of reg) if (pv !== v && pd < dist && (!best || pd > best[0])) best = [pd, pv];
          if (best) {
            const am = this.idm(v, dist - best[0] - L, best[1].v, v0);
            if (am < a) {
              a = am;
              v.blocker = best[1];
              v.blockerVirtual = true;
            }
          }
        }
        // and never close on whoever holds the slot before ours, if it hasn't passed yet
        const list = this.mergeSlots.get(n);
        const i = list.indexOf(slot);
        if (i > 0) {
          const pv = list[i - 1].v;
          const pd = pv.ahead?.merges.find((m) => m[0] === n)?.[1];
          if (pd !== undefined && pd < dist) {
            const am = this.idm(v, dist - pd - L, pv.v, v0);
            if (am < a) {
              a = am;
              v.blocker = pv;
              v.blockerVirtual = true;
            }
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
      v.odo = (v.odo || 0) + ds;
      v.moveT = (v.moveT || 0) + dt;
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
        if (v.res?.has(n)) this.release(v, n);
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
      predictiveMoves: s.predictiveMoves || 0,
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
