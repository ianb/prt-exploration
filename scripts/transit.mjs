// Transit travel times on Metro Transit's published schedule (GTFS), using
// RAPTOR (round-based public transit routing): walk to any stop within reach,
// wait, ride, transfer on foot between nearby stops, walk to the destination.
// Walking the whole way is allowed when it's faster.
//
// Data: scripts/fetch-gtfs.sh -> data/raw/gtfs/

import fs from 'node:fs';
import { project } from '../src/geo.js';
import { csvRows } from './csv.mjs';

const WALK = 1.3; // m/s
const DETOUR = 1.25; // street walking distance / straight line
const ACCESS_M = 1000; // furthest walk to or from a stop (straight line)
const TRANSFER_M = 400; // furthest walk between stops for a transfer
const ROUNDS = 4; // up to 3 transfers

const hms = (s) => {
  const [h, m, x] = s.split(':').map(Number);
  return h * 3600 + m * 60 + x;
};

export async function loadTransit(dir, date, fromS, toS) {
  const f = (n) => `${dir}/${n}`;
  // active services on the date
  const dow = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00Z`).getUTCDay();
  const dayName = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dow];
  const active = new Set();
  for await (const r of csvRows(f('calendar.txt'))) if (r[dayName] === '1' && r.start_date <= date && r.end_date >= date) active.add(r.service_id);
  if (fs.existsSync(f('calendar_dates.txt')))
    for await (const r of csvRows(f('calendar_dates.txt'))) {
      if (r.date !== date) continue;
      if (r.exception_type === '1') active.add(r.service_id);
      if (r.exception_type === '2') active.delete(r.service_id);
    }
  const tripRoute = new Map();
  for await (const r of csvRows(f('trips.txt'))) if (active.has(r.service_id)) tripRoute.set(r.trip_id, r.route_id);
  const stops = [];
  const stopIdx = new Map();
  for await (const r of csvRows(f('stops.txt'))) {
    if (r.location_type && r.location_type !== '0') continue;
    stopIdx.set(r.stop_id, stops.length);
    const [x, y] = project([Number(r.stop_lon), Number(r.stop_lat)]);
    stops.push({ id: r.stop_id, name: r.stop_name, x, y });
  }
  const trips = new Map(); // trip_id -> [[seq, stop, arr, dep], ...]
  for await (const r of csvRows(f('stop_times.txt'))) {
    if (!tripRoute.has(r.trip_id)) continue;
    const s = stopIdx.get(r.stop_id);
    if (s === undefined) continue;
    let t = trips.get(r.trip_id);
    if (!t) trips.set(r.trip_id, (t = []));
    t.push([Number(r.stop_sequence), s, hms(r.arrival_time), hms(r.departure_time)]);
  }
  // patterns: trips of a route with the same stop sequence, inside the time window
  const patterns = new Map();
  for (const [tid, st] of trips) {
    st.sort((a, b) => a[0] - b[0]);
    if (st[st.length - 1][2] < fromS || st[0][3] > toS) continue;
    const key = `${tripRoute.get(tid)}|${st.map((x) => x[1]).join(',')}`;
    let p = patterns.get(key);
    if (!p) patterns.set(key, (p = { route: tripRoute.get(tid), stops: st.map((x) => x[1]), trips: [] }));
    p.trips.push({ arr: Int32Array.from(st.map((x) => x[2])), dep: Int32Array.from(st.map((x) => x[3])) });
  }
  const pats = [...patterns.values()];
  for (const p of pats) p.trips.sort((a, b) => a.dep[0] - b.dep[0]);
  const stopPats = stops.map(() => []);
  pats.forEach((p, pi) => p.stops.forEach((s, i) => stopPats[s].push([pi, i])));
  // spatial hash of stops, and walking transfers
  const CELL = 500;
  const hash = new Map();
  stops.forEach((s, i) => {
    const k = `${Math.floor(s.x / CELL)},${Math.floor(s.y / CELL)}`;
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k).push(i);
  });
  const near = (x, y, r) => {
    const out = [];
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++)
        for (const i of hash.get(`${cx},${cy}`) || []) {
          const d = Math.hypot(stops[i].x - x, stops[i].y - y);
          if (d <= r) out.push([i, (d * DETOUR) / WALK]);
        }
    return out;
  };
  const transfers = stops.map((s, i) => near(s.x, s.y, TRANSFER_M).filter(([j]) => j !== i));
  return { stops, pats, stopPats, transfers, near, date };
}

// Door-to-door seconds from point o to point d, leaving at departS (seconds after midnight).
export function transitTime(T, o, d, departS) {
  const { stops, pats, stopPats, transfers, near } = T;
  const walkOnly = (Math.hypot(o[0] - d[0], o[1] - d[1]) * DETOUR) / WALK;
  const egress = new Map(near(d[0], d[1], ACCESS_M));
  const best = new Float64Array(stops.length).fill(Infinity);
  let prev = new Float64Array(stops.length).fill(Infinity);
  let marked = new Set();
  for (const [s, w] of near(o[0], o[1], ACCESS_M)) {
    prev[s] = departS + w;
    best[s] = prev[s];
    marked.add(s);
  }
  let answer = departS + walkOnly;
  for (const [s, w] of egress) if (best[s] + w < answer) answer = best[s] + w;
  for (let k = 0; k < ROUNDS && marked.size; k++) {
    const cur = Float64Array.from(prev);
    // patterns to scan, from their earliest marked stop
    const q = new Map();
    for (const s of marked)
      for (const [pi, i] of stopPats[s]) if (!q.has(pi) || i < q.get(pi)) q.set(pi, i);
    const improved = new Set();
    for (const [pi, i0] of q) {
      const p = pats[pi];
      let trip = null;
      for (let i = i0; i < p.stops.length; i++) {
        const s = p.stops[i];
        if (trip && trip.arr[i] < Math.min(best[s], answer)) {
          cur[s] = trip.arr[i];
          best[s] = trip.arr[i];
          improved.add(s);
        }
        // can we catch an earlier trip here?
        if (prev[s] < Infinity && (!trip || prev[s] <= trip.dep[i])) {
          // first trip departing at or after prev[s] (binary search; trips don't overtake)
          let lo = 0;
          let hi = p.trips.length;
          while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (p.trips[m].dep[i] < prev[s]) lo = m + 1;
            else hi = m;
          }
          if (lo < p.trips.length && (!trip || p.trips[lo].dep[i] < trip.dep[i])) trip = p.trips[lo];
        }
      }
    }
    // walking transfers
    const next = new Set(improved);
    for (const s of improved)
      for (const [j, w] of transfers[s])
        if (cur[s] + w < Math.min(best[j], answer)) {
          cur[j] = cur[s] + w;
          best[j] = cur[j];
          next.add(j);
        }
    for (const s of next) {
      const w = egress.get(s);
      if (w !== undefined && cur[s] + w < answer) answer = cur[s] + w;
    }
    prev = cur;
    marked = next;
  }
  return answer - departS;
}
