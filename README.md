# PRT Exploration

An experiment in personal rapid transit (PRT): small, light, automated vehicles
on a dedicated network with off-line stations, so every trip is nonstop and
on-demand.

The working case is **Minneapolis**: an elevated guideway over city streets,
laid out automatically to reach the most people and jobs, and simulated with
travel-survey demand.

- [docs/design-notes.md](docs/design-notes.md): precedents, guideway options,
  and the hard problems
- [docs/street-network.md](docs/street-network.md): the current network on
  real streets, and door-to-door times compared with car, transit and bike
- [docs/minneapolis-v1.md](docs/minneapolis-v1.md): the first network (an
  idealized half-mile grid), the simulation model, and early results
- [docs/mode-comparison.md](docs/mode-comparison.md): PRT vs transit (on the
  real schedule), car and bike, timed on the same trips
- [docs/speed-and-comfort.md](docs/speed-and-comfort.md): research on PRT
  speeds and ride comfort, faster lines, and route directness
- [docs/data-sources.md](docs/data-sources.md): trip data, what the census
  commute data says about Minneapolis, and other options

## Running it

Needs Node 20 or newer. There are no dependencies.

```sh
# Street and parcel data (Hennepin County GIS)
node scripts/fetch-streets.mjs && node scripts/fetch-parcels.mjs

# Build the street network (data/network.json) and the demand tables for it
npm run build:network

# Door-to-door times vs car / transit / bike from the travel survey
node scripts/travel-times.mjs 60 demand=tbi-model hourFrom=16 hourTo=17 tripsPerHour=7500 headway=0.5 fleetPerStation=5 berths=14

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
- `scripts/build-street-network.mjs`: the street layout, stations,
  junctions and coverage
- `scripts/build-network.mjs`: the original half-mile grid
  (`data/network-grid.json`; open the viewer with `?net=grid`)
- `web/`: the canvas viewer
- `data/geo.json`: the city boundary, lakes and Mississippi River, from
  OpenStreetMap (© OpenStreetMap contributors, ODbL)
- `data/network.json`: the generated network
- `data/demand-lodes.json`: Census LODES 2022 commutes, by home and work
  station (public domain)
- `data/demand-tbi.json`: built locally from the travel survey, not
  committed (see docs/data-sources.md)
