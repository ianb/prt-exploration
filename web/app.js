import { Sim } from '../src/sim.js';

const net = await (await fetch('../data/network.json')).json();
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- view transform -------------------------------------------------------
const xs = net.geo.city.map((p) => p[0]);
const ys = net.geo.city.map((p) => p[1]);
const bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
let view = { cx: (bounds.x0 + bounds.x1) / 2, cy: (bounds.y0 + bounds.y1) / 2, scale: 0.05 };
let W = 0;
let H = 0;
let dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  if (!resize.done) {
    view.scale = Math.min(W / (bounds.x1 - bounds.x0), H / (bounds.y1 - bounds.y0)) * 0.92;
    resize.done = true;
  }
}
window.addEventListener('resize', resize);
resize();
const sx = (x) => (x - view.cx) * view.scale + W / 2;
const sy = (y) => H / 2 - (y - view.cy) * view.scale;

// pan & zoom
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  view.cx = drag.cx - (e.clientX - drag.x) / view.scale;
  view.cy = drag.cy + (e.clientY - drag.y) / view.scale;
});
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0015);
    const mx = (e.clientX - W / 2) / view.scale + view.cx;
    const my = view.cy - (e.clientY - H / 2) / view.scale;
    view.scale = Math.min(20, Math.max(0.01, view.scale * f));
    view.cx = mx - (e.clientX - W / 2) / view.scale;
    view.cy = my + (e.clientY - H / 2) / view.scale;
  },
  { passive: false }
);

// ---- scenario controls ----------------------------------------------------
const knobs = ['tripsPerHour', 'headway', 'fleetPerStation', 'berths'];
for (const k of knobs) {
  const el = $(k);
  const out = el.nextElementSibling;
  const show = () => (out.textContent = Number(el.value).toLocaleString());
  el.addEventListener('input', show);
  show();
}
let sim;
let lodes = null;
let tbi = null;
async function restart() {
  const opts = Object.fromEntries(knobs.map((k) => [k, Number($(k).value)]));
  const demand = $('demand').value;
  if (demand.startsWith('lodes')) {
    lodes ??= await (await fetch('../data/demand-lodes.json')).json();
    opts.demandData = lodes;
    opts.direction = demand.endsWith('pm') ? 'pm' : 'am';
  }
  if (demand.startsWith('tbi')) {
    try {
      tbi ??= await (await fetch('../data/demand-tbi.json')).json();
      opts.demandData = tbi;
      opts.demandModel = true;
      if (demand === 'tbi-pm') Object.assign(opts, { hourFrom: 16, hourTo: 17 });
    } catch {
      alert('data/demand-tbi.json is missing. It is built locally from the travel survey: see docs/data-sources.md. Using commute data instead.');
      $('demand').value = 'lodes-am';
      return restart();
    }
  }
  sim = new Sim(net, opts);
}
await restart();
$('restart').addEventListener('click', restart);

let playing = true;
let speed = 20;
$('play').addEventListener('click', () => {
  playing = !playing;
  $('play').textContent = playing ? 'Pause' : 'Play';
  $('play').classList.toggle('on', playing);
});
const speedBox = $('speeds');
for (const s of [1, 5, 20, 60]) {
  const b = document.createElement('button');
  b.textContent = `${s}×`;
  b.onclick = () => {
    speed = s;
    for (const c of speedBox.children) c.classList.toggle('on', c === b);
  };
  if (s === speed) b.classList.add('on');
  speedBox.appendChild(b);
}

// ---- drawing ---------------------------------------------------------------
function poly(pts, close) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(sx(p[0]), sy(p[1])) : ctx.moveTo(sx(p[0]), sy(p[1]))));
  if (close) ctx.closePath();
}

function drawBase() {
  ctx.fillStyle = css('--bg');
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = css('--land');
  ctx.strokeStyle = css('--edge');
  ctx.lineWidth = 1;
  poly(net.geo.city, true);
  ctx.fill();
  ctx.stroke();
  if ($('showGaps').checked) {
    ctx.fillStyle = css('--gap');
    const r = 50 * view.scale;
    for (const [x, y] of net.uncovered) ctx.fillRect(sx(x) - r, sy(y) - r, 2 * r, 2 * r);
  }
  ctx.fillStyle = css('--water');
  for (const ring of Object.values(net.geo.lakes)) {
    poly(ring, true);
    ctx.fill();
  }
  ctx.strokeStyle = css('--water');
  ctx.lineWidth = Math.max(3, 150 * view.scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const l of net.geo.river) {
    poly(l, false);
    ctx.stroke();
  }
  const lw = Math.max(0.7, Math.min(3, 4 * view.scale));
  const colors = { main: css('--line'), turn: css('--turn'), rampLane: css('--turn'), stEntry: css('--station'), stExit: css('--station'), berth: css('--station') };
  for (const kind of ['main', 'rampLane', 'turn', 'stEntry', 'stExit', 'berth']) {
    if (kind.startsWith('st') || kind === 'berth') { if (!$('showStations').checked) continue; }
    if (kind !== 'main' && view.scale < 0.08) continue; // too small to see
    ctx.strokeStyle = colors[kind];
    ctx.lineWidth = kind === 'main' ? lw : lw * 0.8;
    ctx.beginPath();
    for (const e of net.edges) {
      if (e.kind !== kind) continue;
      e.pts.forEach((p, i) => (i ? ctx.lineTo(sx(p[0]), sy(p[1])) : ctx.moveTo(sx(p[0]), sy(p[1]))));
    }
    ctx.stroke();
  }
  // direction arrows when zoomed in
  if (view.scale > 0.15) {
    ctx.fillStyle = css('--line');
    for (const e of net.edges) {
      if (e.kind !== 'main' || e.len < 200) continue;
      const [a, b] = [e.pts[0], e.pts[e.pts.length - 1]];
      const mx = sx((a[0] + b[0]) / 2);
      const my = sy((a[1] + b[1]) / 2);
      const ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-4, -4);
      ctx.lineTo(-4, 4);
      ctx.fill();
      ctx.restore();
    }
  }
}

function drawVehicles() {
  const colors = { loaded: css('--loaded'), toPickup: css('--empty'), reposition: css('--empty'), arriving: css('--arriving'), idle: css('--idle'), loading: css('--loaded'), unloading: css('--arriving') };
  const r = Math.max(1.4, Math.min(4, 3 * view.scale * 1.5));
  const byColor = new Map();
  for (const p of sim.positions()) {
    const c = colors[p.state] || '#f0f';
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(p);
  }
  for (const [c, list] of byColor) {
    ctx.fillStyle = c;
    ctx.beginPath();
    for (const p of list) {
      const x = sx(p.x);
      const y = sy(p.y);
      if (x < -5 || y < -5 || x > W + 5 || y > H + 5) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

const fmtTime = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let lastStats = 0;
function drawStats() {
  const s = sim.summary();
  const moving = (s.byState.loaded || 0) + (s.byState.toPickup || 0) + (s.byState.reposition || 0) + (s.byState.arriving || 0);
  const rows = [
    ['Sim time', fmtTime(s.t)],
    ['Vehicles moving / total', `${moving.toLocaleString()} / ${s.vehicles.toLocaleString()}`],
    ['Trips completed', s.completed.toLocaleString()],
    ['People waiting now', s.waiting.toLocaleString()],
    ['Average wait', `${s.avgWaitS} s`],
    ['Average ride', `${Math.round(s.avgRideS / 6) / 10} min`],
    ['Empty trips', s.emptyMoves.toLocaleString()],
    ['Station full, went elsewhere', `${s.waveOffs.toLocaleString()}`],
    ['Closest spacing seen', `${s.minGapM} m`],
    ['Stations / guideway', `${net.stats.stations} / ${net.stats.guidewayMiles} mi`],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

let last = performance.now();
function frame(now) {
  const elapsed = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (playing) {
    let steps = Math.round((elapsed * speed) / sim.p.dt);
    const t0 = performance.now();
    while (steps-- > 0 && performance.now() - t0 < 30) sim.step();
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBase();
  drawVehicles();
  if (now - lastStats > 500) {
    drawStats();
    lastStats = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
