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

## Checking the transit router against real trips

`scripts/validate-transit.mjs` routes every transit trip in the 2023 survey
with both ends in Minneapolis (470 trips over 0.5 km) at its actual departure
time, from its origin block group to its destination block group. Each block
group is placed at its people+jobs-weighted centre. The router's time is
then compared with the duration the rider reported.

| Straight-line distance | Trips | Median reported | Median router | Router ÷ reported, per trip: median (middle half) |
|---|---|---|---|---|
| 0.5–3 km | 293 | 21.0 min | 20.7 min | 0.98 (0.70–1.41) |
| 3–6 km | 130 | 35.0 min | 34.5 min | 1.01 (0.70–1.37) |
| 6–20 km | 47 | 42.0 min | 41.4 min | 0.97 (0.78–1.23) |
| All | 470 | 26.0 min | 25.4 min | 0.99 (0.72–1.38) |

**Typical times match closely.** The router is within about 1–2% of
reported times at every distance.

**Individual trips scatter by about ±30%.** That's expected given what's
being compared:
- the survey only gives block groups, not exact addresses;
- the survey is from 2023 and the schedule from 2026;
- reported times are rounded and include the rider's own choices (a slower
  route, a stop on the way).

So the router is a fair stand-in for what riders actually experience, and the
same-trip comparison above can be trusted at the level of medians.

## How bad do transit trips get?

Medians hide the hard trips, so here is the spread on the same trips at
three times:

| | Weekday 4–5 PM | Weekday 9–10 PM | Sunday 2–3 PM |
|---|---|---|---|
| Transit: median / 90th percentile / worst (min) | 24.6 / 41.3 / 84 | 26.6 / 45.5 / 111 | 23.9 / 40.6 / 78 |
| PRT walking: median / 90th / worst (min) | 15.6 / 29.4 / 66 | 15.4 / 25.3 / 57 | 15.5 / 25.0 / 49 |
| Transit over 45 minutes | 6% | 11% | 6% |
| Transit over 60 minutes | 1% | 2% | 1% |
| Transit at least 2× the car | 85% | 87% | 81% |
| Transit at least 3× the car | 26% | 36% | 23% |
| Transit at least 2× PRT | 24% | 35% | 25% |
| PRT faster than transit | 80% | 87% | 85% |

**Why the tail isn't worse:**

- **Minneapolis's network is dense.** Inside the city, almost every place
  is near a frequent route, so few trips need more than one transfer.
  Truly bad trips tend to be suburban, or across the city late at night.
- **The trips are mostly short** (median about 2.8 km), and walking the
  whole way caps the worst short trips.
- **The router is generous to transit:**
  - perfectly on-time buses;
  - no buffer for transfers;
  - straight-line walking.

  Real hard trips also cost things this doesn't measure: missed
  connections, uncertainty, and waiting outside in a Minneapolis winter.

**The bigger pattern** is that transit is reliably slow rather than
occasionally terrible. About 85% of trips take at least twice as long as
driving, and a quarter to a third take at least three times as long.

## Trips to "odd places"

The trips above follow the survey, so they go where trips usually go. A trip
to an unusual destination (an event venue, a park, someone's house across
town) isn't weighted that way. `scripts/odd-trips.mjs` picks origin and
destination as random census blocks anywhere in the city, unweighted, leaving
between 7 and 9 PM on a weekday.

**PRT is estimated, not simulated, here:**
- free-flow route time, since there's no congestion at that hour;
- plus a 1-minute wait;
- plus boarding and getting off;
- plus the walks.

| 1,500 random trips, median 6.1 km | Median | 75th pct | 90th pct | Worst | Over 45 min | Over 60 min |
|---|---|---|---|---|---|---|
| Transit | 48 min | 60 | 71 | 121 | 58% | 26% |
| PRT (walking) | 25 min | 32 | 38 | 59 | 3% | 0% |

For trips that aren't between common places, which are also longer, transit
over 45 minutes is the norm, and a quarter take over an hour in the evening.
PRT's on-demand, nonstop service doesn't depend on a destination being
popular, so it stays at about half the time.
