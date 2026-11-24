# Minneapolis network, version 1

The first full-city layout and simulation, with what it showed.

## Layout

- **Grid.** One-way guideway lines every half mile, north–south and east–west,
  alternating direction like a one-way street grid. The grid is anchored at
  Lake St and Nicollet Ave, so many lines fall near real arterials (Lake, 38th,
  46th, Nicollet, Lyndale…), but it ignores the rotated downtown street grid
  for now.
- **Loops.** With alternating directions, every other half-mile square is a
  closed one-way loop, and every station can reach every other.
- **Stations.** One off-line station at the middle of each half-mile side.
- **Crossings.** Every crossing is grade-separated, with the straight line
  going over or under. Because both lines are one-way, there are only two
  possible turns, so a crossing needs just two quarter-circle ramps: no loops
  and no cloverleaf. Each ramp has a 60 m deceleration lane and a 60 m
  acceleration lane, so vehicles slow down and speed up off the main line.
- **Water.** Segments that cross a lake are dropped. River crossings are kept
  as bridges only where both ends are in the city.

### Why a half-mile grid gives a quarter-mile walk

People walk on streets, so walking distance is measured along the street
grid: east–west plus north–south. Put a station at the middle of every side
of every half-mile square. Within one square the worst place is the corner,
which is a quarter mile along the street from the two nearest stations. The
centre of the square is also exactly a quarter mile from all four. The
diamond-shaped "quarter-mile walk" zones around the stations tile the plane
exactly, with no gaps and no overlap. So this is the sparsest station pattern
that guarantees a quarter-mile walk on a street grid.

### Numbers

| | |
|---|---|
| Stations | 380 |
| One-way guideway (main line) | 210 miles (337 km) |
| Turn ramps | 394 |
| Merge points | 726 |
| River bridges | 18 |
| City land covered within a quarter-mile walk | 85% |
| …within 300 m / 600 m | 47% / 93% |

Most of the uncovered 15% is parkland around the lakes, the Mississippi
banks, and the strips along the city edge that fall outside the outermost
lines. A narrower last row of lines would close the edge gaps.

## Simulation model

- Vehicles 3 m long, cruising at 15 m/s (34 mph), with comfortable
  acceleration of 2 m/s² and braking of 2.5 m/s². Turns are taken at
  6.7 m/s (30 m radius, 1.5 m/s² sideways).
- **Car-following:** Intelligent Driver Model with a set time headway. This
  is deliberately not rail-style brick-wall spacing: a vehicle keeps a time
  gap to the one ahead, as cars do.
- **Merges:** vehicles approaching a merge from both branches are ordered by
  distance to the merge point, and each one keeps its headway behind the one
  before it in that order (a "virtual platoon").
- **Stations:** sawtooth berths, where each docked vehicle can leave without
  waiting for the others. A vehicle reserves a berth before diverging. If the
  station is full it goes to the nearest station with room, and its rider
  walks a little further. A vehicle leaving a station waits for a gap in the
  main line before launching.
- **Empty vehicles:** when people are waiting and no vehicle is docked or due
  within two minutes, the nearest idle vehicle is called. Every 20 s, stations
  with spare idle vehicles send one to a nearby station that has none.
- **Demand (placeholder):** every station generates trips, with extra weight
  downtown, at the University, in Uptown and along Lake St. Destinations
  follow a gravity model with 4 km decay, and trips under 700 m are dropped
  because people would walk. The average trip is 3.8 km in a straight line,
  and the average ride is about 7.5 minutes free-flowing.

## Results

One simulated hour per run. The fleet is about one vehicle per 1,200
trips per hour per station.

| Headway | Trips/hour | Result | Average wait | Notes |
|---|---|---|---|---|
| 1.0 s | 6,000 | Works | 23 s | Closest approach 5.9 m |
| 1.0 s | 7,500 | Starting to fail | 35 s | Some riders wait over 30 min; jams form downtown |
| 1.0 s | 9,000 | Gridlock | — | Spreads out from downtown within ~35 min |
| 0.5 s | 9,000 | Works | 23 s | Closest approach 4.5 m, no collisions |
| 0.5 s | 12,000 | Failing | 45 s | 18 collision events (see below) |
| 0.5 s | 15,000 | Gridlock | — | |

What this says:

1. **Downtown is the limit, not the city.** At failure, most lines outside
   downtown are lightly used. Downtown lines run bumper to bumper, and the
   jam spreads outward from there. A uniform half-mile grid is too thin for the
   core. The obvious next layout is a quarter-mile grid downtown and around
   the University.
2. **Headway is the biggest single lever.** Halving the headway from 1 s to
   0.5 s raised the workable load by about half. This is the
   non-train-rules advantage made concrete.
3. **The merge controller is the weak part of the model.** Ordering vehicles
   at merges by distance can create loops of vehicles all waiting on each
   other (A waits for B at one merge, B is stuck behind C, and C waits for A
   at another merge). The simulator detects and breaks these loops, but under
   heavy load the system still tips into gridlock instead of failing
   gracefully with longer station waits. At 0.5 s headway, a few loop-breaks
   happen fast enough to cause collisions. That's a flaw in the controller,
   not something real vehicles would do.
4. **Empty trips are large.** About a third of vehicle trips are empty,
   because the placeholder demand pulls vehicles toward downtown and leaves
   outer stations short.

## Next steps

- **Slot-based merge control.** This is the classic PRT approach: a vehicle
  books its passage through each merge ahead of time. If a merge is full, it
  takes another route instead of stopping on the line. It should remove
  gridlock and the collisions.
- **Denser core:** quarter-mile lines downtown and around the University.
- **Real demand:** census blocks for where people live, and LEHD job data for
  where they work, to replace the placeholder weights.
- **Station variants:** linear berths versus sawtooth, and berth counts sized
  to each station's demand.
- **Cost model:** guideway miles, ramps, bridges and stations, to set against
  ridership.
