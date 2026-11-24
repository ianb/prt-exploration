# PRT Exploration

An experiment in personal rapid transit (PRT): small, light, automated vehicles
on a dedicated network with off-line stations, so every trip is nonstop and
on-demand.

The working case is **Minneapolis**: one-way guideway loops on a half-mile
grid, with a station within a quarter-mile walk of almost everywhere.

- [docs/design-notes.md](docs/design-notes.md): precedents, guideway options,
  and the hard problems
- [docs/minneapolis-v1.md](docs/minneapolis-v1.md): the first city network,
  the simulation model, and results

## Running it

Needs Node 20 or newer. There are no dependencies.

```sh
# Rebuild the guideway network from data/geo.json -> data/network.json
npm run build:network

# Headless simulation: minutes, then any parameter from src/sim.js DEFAULTS
node scripts/run-sim.mjs 60 tripsPerHour=9000 headway=0.5 fleetPerStation=7 berths=13
```

To watch it, serve the repository root with any static server, for example
`python3 -m http.server`, and open `/web/`. The map pans and zooms. The panel
lets you change demand, headway, fleet size and berths.

## Layout

- `src/geo.js`: projection and geometry helpers
- `src/sim.js`: the simulator, which runs in Node and in the browser
- `scripts/build-network.mjs`: the grid layout, stations, crossings and
  coverage
- `web/`: the canvas viewer
- `data/geo.json`: the city boundary, lakes and Mississippi River, from
  OpenStreetMap (© OpenStreetMap contributors, ODbL)
- `data/network.json`: the generated network
