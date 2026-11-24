// Labeled explainer diagrams of the network, drawn from data/network.json.
// Writes docs/img/*.svg.
import fs from 'node:fs';

const net = JSON.parse(fs.readFileSync(new URL('../data/network.json', import.meta.url)));
const P = net.params.pitch;
fs.mkdirSync(new URL('../docs/img/', import.meta.url), { recursive: true });

const C = { bg: '#f7f6f2', line: '#5f5d58', turn: '#c0661d', station: '#2f8f5b', text: '#22252a', muted: '#6b6f76', walk: 'rgba(37,99,235,.10)', walkEdge: 'rgba(37,99,235,.45)', veh: '#2563eb' };

function diagram(name, { x0, y0, x1, y1, width, notes = [], extra = '', overlay = '', lineW = 3 }) {
  const s = width / (x1 - x0);
  const height = Math.round((y1 - y0) * s);
  const X = (x) => ((x - x0) * s).toFixed(1);
  const Y = (y) => ((y1 - y) * s).toFixed(1);
  const pts = (a) => a.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ');
  let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui,-apple-system,sans-serif">`;
  o += `<rect width="${width}" height="${height}" fill="${C.bg}"/>`;
  o += `<defs><marker id="ar" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.line}"/></marker>
  <marker id="lead" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4"><circle cx="5" cy="5" r="4" fill="${C.text}"/></marker></defs>`;
  o += extra ? extra({ X, Y, s }) : '';
  const inView = (e) => e.pts.some(([x, y]) => x > x0 - 50 && x < x1 + 50 && y > y0 - 50 && y < y1 + 50);
  for (const kind of ['main', 'rampLane', 'turn', 'stEntry', 'berth', 'stExit']) {
    for (const e of net.edges) {
      if (e.kind !== kind || !inView(e)) continue;
      const col = kind === 'main' ? C.line : kind === 'turn' || kind === 'rampLane' ? C.turn : C.station;
      const w = kind === 'main' ? lineW : lineW * 0.75;
      o += `<polyline points="${pts(e.pts)}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
      if (kind === 'main' && e.len > 120) {
        const [a, b] = [e.pts[0], e.pts[e.pts.length - 1]];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const u = [(b[0] - a[0]) / e.len, (b[1] - a[1]) / e.len];
        const L = 14 / s;
        o += `<line x1="${X(m[0] - u[0] * L)}" y1="${Y(m[1] - u[1] * L)}" x2="${X(m[0] + u[0] * L)}" y2="${Y(m[1] + u[1] * L)}" stroke="${C.line}" stroke-width="${lineW}" marker-end="url(#ar)"/>`;
      }
    }
  }
  o += overlay ? overlay({ X, Y, s, lineW }) : '';
  for (const n of notes) {
    // n: {at:[x,y] anchor of the text, to:[x,y] optional leader target, text:[lines], align}
    const tx = Number(X(n.at[0]));
    const ty = Number(Y(n.at[1]));
    if (n.to) o += `<line x1="${tx}" y1="${ty}" x2="${X(n.to[0])}" y2="${Y(n.to[1])}" stroke="${C.muted}" stroke-width="1" marker-end="url(#lead)"/>`;
    const anchor = n.align || 'start';
    const dx = n.to ? (anchor === 'end' ? -6 : anchor === 'middle' ? 0 : 6) : 0;
    n.text.forEach((line, i) => {
      const bold = i === 0 && n.text.length > 1;
      o += `<text x="${tx + dx}" y="${ty + 5 + i * 18}" font-size="${bold ? 15 : 14}" font-weight="${bold ? 600 : 400}" fill="${bold ? C.text : C.muted}" text-anchor="${anchor}" paint-order="stroke" stroke="${C.bg}" stroke-width="4">${line}</text>`;
    });
  }
  o += '</svg>';
  fs.writeFileSync(new URL(`../docs/img/${name}.svg`, import.meta.url), o);
}

// 1. A few loops: the grid, directions, stations, and quarter-mile walk zones.
diagram('grid', {
  x0: -0.35 * P, y0: -0.35 * P, x1: 2.35 * P, y1: 2.35 * P, width: 900, lineW: 3,
  extra: ({ X, Y }) => {
    // walk diamonds around each station
    let g = '';
    for (const st of net.stations) {
      if (st.x < -0.4 * P || st.x > 2.4 * P || st.y < -0.4 * P || st.y > 2.4 * P) continue;
      const r = 402;
      g += `<polygon points="${X(st.x)},${Y(st.y + r)} ${X(st.x + r)},${Y(st.y)} ${X(st.x)},${Y(st.y - r)} ${X(st.x - r)},${Y(st.y)}" fill="${C.walk}" stroke="${C.walkEdge}" stroke-width="0.75" stroke-dasharray="4 4"/>`;
    }
    return g;
  },
  notes: [
    { at: [2.3 * P, 2.25 * P], text: ['One-way lines every half mile', 'neighbours run opposite ways'], align: 'end' },
    { at: [1.5 * P, 0.5 * P], text: ['A loop ↺', 'every other square circulates'], align: 'middle' },
    { at: [0.5 * P, 1.5 * P], text: ['A loop ↻', 'its neighbours turn the other way'], align: 'middle' },
    { at: [0.5 * P, 0.5 * P], text: ['Pass-through square'], align: 'middle' },
    { at: [1.5 * P, 1.5 * P], text: ['Pass-through square'], align: 'middle' },
    { at: [1.5 * P, -0.25 * P], to: [1.5 * P, 0], text: ['Station in the middle of each side'], align: 'middle' },
    { at: [-0.3 * P, 2.25 * P], text: ['Blue diamonds', 'within a quarter-mile walk of a station'], align: 'start' },
  ],
});

// 2. One crossing (Lake St & Nicollet in the grid's frame).
diagram('crossing', {
  x0: -170, y0: -130, x1: 170, y1: 130, width: 900, lineW: 6,
  // northbound line drawn as a bridge over the eastbound one
  overlay: ({ X, Y, lineW }) =>
    `<line x1="${X(0)}" y1="${Y(-22)}" x2="${X(0)}" y2="${Y(22)}" stroke="${C.bg}" stroke-width="${lineW * 4}"/>` +
    `<line x1="${X(0)}" y1="${Y(-22)}" x2="${X(0)}" y2="${Y(22)}" stroke="${C.line}" stroke-width="${lineW}"/>` +
    `<line x1="${Number(X(0)) - lineW * 2}" y1="${Y(-22)}" x2="${Number(X(0)) - lineW * 2}" y2="${Y(22)}" stroke="${C.line}" stroke-width="1.5"/>` +
    `<line x1="${Number(X(0)) + lineW * 2}" y1="${Y(-22)}" x2="${Number(X(0)) + lineW * 2}" y2="${Y(22)}" stroke="${C.line}" stroke-width="1.5"/>`,
  notes: [
    { at: [-160, 112], text: ['Two one-way lines cross on different levels', 'Here northbound bridges over eastbound: no signals, no conflicts'] },
    { at: [-150, -55], to: [-60, 0], text: ['Turn ramp, east → north: slow-down lane', '60 m, leaves the line at full speed'] },
    { at: [-150, 55], to: [-12, 20], text: ['30 m curve at 15 mph'] },
    { at: [45, 85], to: [3, 70], text: ['Speed-up lane, 60 m', 'merges back at full speed'] },
    { at: [50, -55], to: [18, -20], text: ['The other turn, north → east,', 'is the mirror image'] },
    { at: [55, 40], text: ['With both lines one-way there are only', 'two possible turns, so two ramps', 'and no cloverleaf'] },
    { at: [150, -16], text: ['Eastbound →'], align: 'end' },
    { at: [10, -120], text: ['Northbound ↑'] },
  ],
});

// 3. One station.
diagram('station', {
  x0: 402 - 230, y0: -80, x1: 402 + 230, y1: 70, width: 900, lineW: 5,
  extra: ({ X, Y }) => {
    let g = '';
    // sawtooth bays below the berth lane
    for (let k = 0; k < 8; k++) {
      const x = 402 - 40 + (k + 0.5) * 10;
      g += `<line x1="${X(x - 3)}" y1="${Y(-12)}" x2="${X(x + 2)}" y2="${Y(-20)}" stroke="${C.station}" stroke-width="3"/>`;
      g += `<rect x="${Number(X(x + 2)) - 6}" y="${Number(Y(-20)) - 3}" width="12" height="9" rx="2" fill="${C.veh}" opacity="${k % 3 === 1 ? 0.25 : 0.9}"/>`;
    }
    g += `<rect x="${X(402 - 45)}" y="${Y(-28)}" width="${Number(X(402 + 45)) - Number(X(402 - 45))}" height="${Number(Y(-36)) - Number(Y(-28))}" fill="#d9d6cc"/>`;
    return g;
  },
  notes: [
    { at: [402 - 220, 55], text: ['Main line: through vehicles never slow down for the station'] },
    { at: [402 - 220, -45], to: [402 - 95, -6], text: ['Exit lane', 'brakes off the main line'] },
    { at: [402, -50], text: ['Sawtooth bays + platform', 'each vehicle can leave on its own'], align: 'middle' },
    { at: [402 + 220, -45], to: [402 + 95, -6], text: ['Launch lane', 'waits for a gap, then', 'speeds up to join'], align: 'end' },
    { at: [402, 30], text: ['300 m from split to merge'], align: 'middle' },
  ],
});
console.log('wrote docs/img/grid.svg, crossing.svg, station.svg');
