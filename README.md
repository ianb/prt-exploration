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
- [docs/data-sources.md](docs/data-sources.md): trip data, what the census
  commute data says about Minneapolis, and other options

## Running it

Needs Node 20 or newer. There are no dependencies.

```sh
# Rebuild the guideway network from data/geo.json -> data/network.json
npm run build:network

# Census commute data (LODES): download, then build the station-to-station table
./scripts/fetch-lodes.sh && node scripts/build-demand.mjs

# Travel survey (TBI 2023): unpack the TSDC download into data/raw/tbi2023 first
./scripts/fetch-census-pop.sh && node scripts/build-demand-tbi.mjs

# Headless simulation: minutes, then any parameter from src/sim.js DEFAULTS
node scripts/run-sim.mjs 60 tripsPerHour=9000 headway=0.5 fleetPerStation=7 berths=13
node scripts/run-sim.mjs 60 demand=lodes direction=am tripsPerHour=5000 headway=0.5 fleetPerStation=6 berths=14
node scripts/run-sim.mjs 60 demand=tbi-model hourFrom=16 hourTo=17 tripsPerHour=7500 headway=0.5 fleetPerStation=6 berths=14
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
- `data/demand-lodes.json`: Census LODES 2022 commutes, by home and work
  station (public domain)
- `data/demand-tbi.json`: built locally from the travel survey, not
  committed (see docs/data-sources.md)
