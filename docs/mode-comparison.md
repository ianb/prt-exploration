# PRT vs transit, car and bike on the same trips

Earlier tables compared PRT with the travel survey's times for trips people
actually took by transit or bike. Those are self-selected: people take
transit where it works well for them, near frequent routes with short waits.
That flatters transit. This comparison times **every mode on the same
trips**.

## Method (`scripts/compare-modes.mjs`)

1. **Trips:** run the PRT simulation (4–5 PM survey-model demand, 7,500
   trips/hour, suspended comfort, current network). Each simulated trip gets
   a real starting and ending census block, drawn from the walking areas of
   its two stations and weighted by people + jobs.
2. **Time that block-to-block trip by each mode:**

| Mode | How it's timed |
|---|---|
| PRT | Walk (or bike) to the station, plus the simulated wait and ride, plus the walk (or bike) at the end |
| Transit | Metro Transit's published weekday schedule (GTFS, Wednesday 2 December 2026), routed with RAPTOR: walk up to 1 km to a stop, wait, ride, up to 3 transfers with walks of up to 400 m between stops, walk to the destination. Walking the whole way counts if it's faster. The rider leaves at their request time. **transit\*** is the best case, leaving at the ideal moment within the next 30 minutes |
| Car | The survey's median door-to-door car time for that straight-line distance. Most trips are by car, so this is little self-selected |
| Bike | Street distance (1.3 × straight line) at 16 km/h, plus 1 minute |

## Results

Median door-to-door minutes, 1,490 trips:

| Distance | PRT, walking | PRT, bike along | Transit | Transit, perfectly timed | Car | Bike | PRT (walking) faster than transit |
|---|---|---|---|---|---|---|---|
| 0.5–2 km | 13.5 | 9.9 | 17.3 | 14.2 | 7.0 | 7.3 | 71% |
| 2–3 km | 16.0 | 12.0 | 27.9 | 21.6 | 10.0 | 12.9 | 87% |
| 3–5 km | 18.9 | 14.7 | 34.1 | 28.2 | 15.0 | 18.5 | 90% |
| 5–8 km | 25.1 | 20.5 | 45.0 | 36.9 | 17.0 | 29.1 | 92% |
| 8–20 km | 31.6 | 28.8 | 53.3 | 42.7 | 22.0 | 43.9 | (6 trips) |
| All | 15.6 | 11.8 | 24.6 | 19.5 | 10.0 | 11.4 | 80% |

- **Transit is much slower on trips in general** than the self-selected
  survey medians suggested. For 2–3 km it takes 28 minutes here against the
  survey's 20; for 3–5 km, 34 against 30.
- **PRT with walking is 40–45% faster than transit at 2–8 km,** and still
  faster than transit with perfect schedule timing.
- **With a bike along, PRT is within about 1–3 minutes of driving up to
  5 km,** and faster than biking the whole way beyond about 3 km.
- **The transit times are, if anything, optimistic.** They assume every
  vehicle runs exactly on schedule, and walking to a stop is limited to 1 km.

The earlier tables' transit column (in `street-network.md` and
`speed-and-comfort.md`) is the self-selected survey figure and should be read
with this in mind.
