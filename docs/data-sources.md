# Trip data

What's available for working out where people live and where they go, and
what's in use here.

## In use: Census LODES commutes (Minneapolis)

[LEHD Origin-Destination Employment Statistics](https://lehd.ces.census.gov/data/)
gives, for every census block, how many people live there and how many work
there. It also gives home-block → work-block pairs. It's public, it covers
every state, and it's updated yearly (2022 is used here; 2024 is out).
`scripts/fetch-lodes.sh` downloads it, and `scripts/build-demand.mjs` turns it
into a station-to-station table (`data/demand-lodes.json`).

What it says about Minneapolis (2022):

| | |
|---|---|
| Jobs in the city | 341,800 |
| Working residents | 198,900 |
| Live and work in the city | 82,700 |
| Live outside, work in the city | 259,100 |
| Live in the city, work outside | 113,200 |
| Share of city jobs downtown | 43% |
| Share of working residents downtown | 9% |
| Busiest station (by jobs within its quarter mile) | ~31,000 jobs |
| Average in-city commute, along the street grid | 5.7 km |

Consequences for the design:

- **Most commuters come from outside the city.** Three in four people who
  work in Minneapolis live elsewhere. A city-only network only serves them if
  it connects to park-and-rides, commuter rail and bus hubs at the edges, or
  extends into the inner suburbs.
- **Downtown is extreme.** One station's walking area holds ~31,000 jobs.
  Even if only a quarter of those workers arrive by PRT in a two-hour peak,
  that's about 4,000 vehicles an hour into one station, three or four times
  what a single station can plausibly handle. Downtown needs many more
  stations: a quarter-mile grid at least, and maybe stations inside
  buildings.
- **The morning peak is one-directional.** Nearly every loaded trip goes
  toward jobs, so almost every one creates an empty trip back out. Fleet and
  empty-vehicle handling matter more than they did with the placeholder
  demand.

### Limits

- Commutes only. Work trips are roughly a fifth of all trips. Shopping,
  school, errands and social trips aren't in LODES.
- No time of day. The simulator assumes a peak hour and scales the counts.
- Job location means the employer's site, which is right for most jobs but
  not for, say, construction or home health workers.

### First simulation results with it

One hour, 0.5 s headway, morning (home → work):

| Trips/hour | Fleet | Result |
|---|---|---|
| 5,000 | 2,280 | Works: 54 s average wait. About 1 rider in 4 is sent to a neighbouring station because downtown stations are full. Close to one empty trip for every loaded one. |
| 10,000 | 3,800 | Fails: queues of nearly 2,000 people waiting, and gridlock spreading. |

For scale: if everyone in the city who commutes within the city did it by
PRT, the morning peak hour would be roughly 15,000–20,000 trips. A 25–30%
share is about 5,000.

## In use: Twin Cities Travel Behavior Inventory 2023 (all trips)

The Met Council's household travel survey records every trip, for every
purpose, with times and modes. It's the standard input to the region's
travel model. The 2023 round covers about 108,000 trips from 3,749
households, each with a weight that scales it up to the region's population
on an average weekday (Tuesday–Thursday).

- Download: [2023 TBI](https://www.nlr.gov/transportation/secure-transportation-data/tsdc-cleansed-data/2023-twin-cities-travel-behavior-inventory-household-travel-survey)
  from the Transportation Secure Data Center at the National Laboratory of the
  Rockies (formerly NREL). It's free after a one-time registration that
  accepts their data-use agreement: credit DOE/NLR in anything published, and
  keep their notice with every copy of the data. The 2019 and 2021 surveys are
  on [another page](https://www.nlr.gov/transportation/secure-transportation-data/tsdc-2019-and-2021-twin-cities-travel-behavior-inventory-surveys).
- Summary report: [TBI 2018–2024](https://metropolitan-council.github.io/TBI_Household_Synthesis_Report).
- Unpack it into `data/raw/tbi2023/`, run `scripts/fetch-census-pop.sh`, then
  `node scripts/build-demand-tbi.mjs`. The output, `data/demand-tbi.json`, is
  kept out of git because it's derived from the survey.

**Locations.** The public version gives each trip end as a census block
group, a few city blocks, rather than coordinates. Each end is spread over
the census blocks inside its block group, weighted by what's there for that
trip's purpose:

- Home ends go by 2020 Census population.
- Work ends go by all jobs.
- Shopping goes by retail jobs, meals by restaurant and hotel jobs, school by
  education jobs, and errands by retail, health care and other services.
- Social and recreation trips go by arts, recreation and food jobs plus
  population.

Job sectors come from LODES. Each block maps to its nearest station.

**What it says about Minneapolis**, on an average weekday:

| | |
|---|---|
| Trips with both ends in the city | 1,130,000 |
| …of which between stations at least 700 m apart (PRT-length) | 803,000 (71%) |
| …the rest (short enough to walk) | 328,000 |
| PRT-length trips now made by car | 525,000 |
| …on foot / bike or scooter / transit / ride-hail | 154,000 / 48,000 / 41,000 / 10,000 |
| Busiest hour (4–5 PM), PRT-length trips | 75,000 |
| Trips crossing the city line (not modelled yet) | ~1,020,000 |

Destination purposes for PRT-length trips: home 33%, social and recreation
11%, escorting someone 11%, shopping 10%, work 8%, work-related 7%, meals 6%.
Work is a small slice. Midday and evening trips are as important as the
commute.

**Sample size.** The survey has about 5,400 weighted trips inside
Minneapolis, and only 508 between 4 and 5 PM. Used directly as a
station-to-station table, one hour is mostly sampling noise: it made half of
all trips look one-way and doubled the empty-vehicle moves. So the simulator
uses a **smoothed model** built from the survey:

- **How many trips** of each purpose pair (origin purpose → destination
  purpose) leave in each hour: from the survey.
- **Where they start and end:** station attraction for each purpose, from the
  block weights above.
- **How far they go:** a distance falloff for each destination purpose,
  tuned so average trip length matches the survey. That's 3.5 km for work,
  2.9 km for home, 2.6 km for shopping and social trips, and 2.2 km for
  school.

The observed table is still available (`demand=tbi`) for comparison.

**Simulation, 4–5 PM, smoothed model:**

| Headway | Trips/hour | Share of peak PRT-length trips | Result |
|---|---|---|---|
| 0.5 s | 7,500 | 10% | Works, strained: 57 s average wait, a few stations starved |
| 1.0 s | 7,500 | 10% | Failing: 1,400 waiting by the end of the hour |
| 0.5 s | 12,000 | 16% | Gridlock |
| 0.5 s | 18,000 | 24% | Gridlock, and the merge controller produces collisions |

So with today's controller, the half-mile network can carry about a tenth
of the city's peak-hour trips. That's roughly 14% of the car trips. Reaching
a quarter or more needs the slot-based merge control, a denser downtown, or
both.

## Other sources

### Chicago ride-hail trips: the best observed all-purpose data

Chicago publishes every Uber and Lyft trip ([Transportation Network Providers – Trips](https://data.cityofchicago.org/browse?q=transportation%20network%20providers)),
with pickup and dropoff census tract and times rounded to 15 minutes. That's
tens of millions of trips a year, all purposes, and it's reachable from here.
It's the closest thing to observed demand for an on-demand, door-to-door,
small-vehicle service, which is what PRT is. Chicago also publishes taxi
trips the same way.

The catch is that it's only people who chose ride-hail, which skews toward
nightlife, airports and downtown. Tract-level locations are coarser than a
quarter-mile station grid.

### Others

- **NYC taxi and ride-hail trips:** very large, but locations are only by
  taxi zone (263 zones), too coarse for station-level work.
- **Nice Ride (Minneapolis bike share):** trip-level and station-to-station,
  but a small seasonal sample and biased toward recreation.
- **Metro Transit boardings by stop:** shows where transit demand is, but not
  where riders are going.
- **Replica** (commercial): synthetic all-purpose trips for any US city.
  Good, but paid.

## Recommendation

Stay in Minneapolis. The travel survey plus census blocks gives a credible
all-purpose, hour-by-hour demand, and LODES adds a full-count commute
pattern to check it against. Trips that cross the city line (about as many as
the trips inside it) are the next gap to fill.

If we want to test PRT against observed trips rather than modelled ones,
Chicago's ride-hail data is the strongest public option. A single-city
comparison run there would be worth doing later.
