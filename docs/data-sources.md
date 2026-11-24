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

## Other sources

### Twin Cities Travel Behavior Inventory: the best fit for Minneapolis

The Met Council's household travel survey covers every trip, for every
purpose, with times and modes, recorded by thousands of households.
It's the standard input to the region's travel model.

- 2023 survey: about 108,000 trips from 3,749 households, through NREL's
  Transportation Secure Data Center ([2023 TBI](https://www.nrel.gov/transportation/secure-transportation-data/tsdc-cleansed-data/2023-twin-cities-travel-behavior-inventory-household-travel-survey)).
  The "cleansed" public version is a free download after registration.
  Exact locations are in the secure version only.
- 2019 survey: listed on the [Minnesota Geospatial Commons](https://gisdata.mn.gov/dataset/us-mn-state-metc-society-tbi-home-interview2019),
  but I couldn't get a direct download from here.
- Summary report: [TBI 2018–2024](https://metropolitan-council.github.io/TBI_Household_Synthesis_Report).

Survey samples are too small to give a station-to-station table on their own.
Their real use is calibration: how many trips per person per day, the split by
purpose, time of day, and trip length. Those rates can then be applied to the
census population and jobs to build a full-day, all-purpose table.

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

Stay in Minneapolis. LODES already gives a real commute pattern at the
census-block level. The next step is to fill in the other four-fifths of trips
with a standard trip-generation model: population and jobs from census data,
with rates from the TBI summary report. Pulling the cleansed TBI download
would let us check those rates properly.

If we want to test PRT against observed trips rather than modelled ones,
Chicago's ride-hail data is the strongest public option. A single-city
comparison run there would be worth doing later.
