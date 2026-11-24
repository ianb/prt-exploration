# PRT Design Notes

## Goal

A modern personal rapid transit (PRT) design: small, light, automated vehicles
on a dedicated network, with off-line stations so every trip is nonstop and
on-demand. Two tracks of work that feed each other:

1. **Simulation** — network, vehicles, control, and demand, to find out what
   headway, station size, and fleet size a design actually needs.
2. **Engineering and design** — the guideway, vehicle, switching, and stations.

Assumptions: optimize for light vehicles (roughly 300–600 kg empty, 2–4
seats). Don't inherit rail rules such as brick-wall stopping distance or
fixed-block signalling. Vehicles can brake together, talk to each other, and
run headways closer to a well-behaved highway lane than to a train.

## Precedents worth studying

| System | Years | Form | Lessons |
|---|---|---|---|
| Morgantown PRT (WV) | 1975– | Heavy 8–20 pax vehicles, heated concrete guideway | Still running; shows the cost of heavy vehicles and snow-melt guideway |
| Cabintaxi (Germany) | 1970s test | Top-running and suspended on the same beam | Showed a single slender beam can carry both directions; 0.5 s headways tested |
| Taxi 2000 / SkyWeb Express (Minnesota) | 1980s–2000s | Small top-running vehicles in a narrow U-channel | J. Edward Anderson at the U of M; the most worked-out theory of PRT guideways and control |
| ULTra (Heathrow) | 2011– | 4-pax battery vehicles on a kerbed concrete path, steered, no moving switches | Closest to a working modern system; simple guideway; reliability good |
| Vectus (Suncheon, Korea) | 2014– | Steel rail guideway, linear motors | Licensed under rail-style safety rules, which held headway back |
| 2getthere (Masdar, Rotterdam) | 2010– | Free-ranging vehicles at grade, magnets in the floor | No physical guideway at all |
| SkyTran | proposed | Suspended maglev, very light pods | Very light structure; unproven |
| Glydways (San Jose area) | 2020s | Narrow dedicated lanes, autonomous steered vehicles | "Path, not track"; leans on modern autonomy |

## Guideway options

| | Top-running channel | Suspended (box beam above) | Path (narrow lane) |
|---|---|---|---|
| Example | Taxi 2000, Morgantown | Cabintaxi lower side, SkyTran | ULTra, Glydways |
| Switching | Vehicle-borne switch arm, no moving track | Vehicle-borne, inside the beam | Steering; just a fork in the lane |
| Structure | Medium; carries vehicle on top | Slender beam; wheels hidden inside | Cheapest at grade; elevated deck is wide |
| Snow and ice | Open channel collects snow | Running surface enclosed and protected | Must plough or heat |
| Ride and visual | Conventional | Swings on curves unless banked; reads as lightweight | Low visual impact at grade, but takes land |
| Getting to grade | Needs ramps | Hard; vehicle hangs, so stations sit under or beside | Natural; can share elevated and at-grade |

Working lean, to test rather than settle: for Minnesota winters, a
**suspended vehicle with bogies running inside an enclosed beam** keeps
the running and switching surfaces dry and the structure slender. The rival
is a **steered vehicle on a narrow path**, which is cheapest wherever land
at grade is available and needs no switch hardware at all. A hybrid —
steered path at grade, a light beam where it must go overhead — is worth
keeping in view.

## The hard problems

- **Merges.** The capacity limit is almost always where two lines join.
  Vehicles must hold or claim a slot before the merge. Options range from
  fixed slots booked at departure (synchronous) to vehicles adjusting speed
  just before the merge (asynchronous).
- **Stations.** Off-line stations with several berths. The design questions
  are berth layout (linear, sawtooth, or parallel), how vehicles enter and
  leave without blocking each other, and berths per peak passenger flow.
- **Empty vehicles.** At peak, flows are lopsided; empty vehicles must be
  moved to where the next riders will be. Fleet size depends on this.
- **Headway and safety.** Capacity of one lane is about 3600 / headway
  vehicles per hour: 1800 at 2 s, 7200 at 0.5 s. What safety case allows
  sub-second headways is the core regulatory question.
- **Network shape.** One-way loops in a grid with lines about 0.5–1 km apart
  so a station is a short walk from anywhere.

## Simulation plan

Start small and grow:

1. A single one-way loop with a few off-line stations; vehicles with simple
   car-following; measure trip times and berth occupancy.
2. Add diverges and merges on a small grid; try merge-control strategies and
   find where throughput breaks down.
3. Add demand from an origin–destination table with a peak, and empty-vehicle
   redistribution; size the fleet.
4. Make it visual — an animated map in the browser to watch vehicles move.
5. Lay it over a real area (for example a Minneapolis neighbourhood) to judge
   station spacing and guideway length.

## Open questions

- Is the target a whole-city network, a district (a campus or downtown), or
  a single connector line?
- How much weight to give to a realistic cost model versus an ideal design?
- Seated-only small pods, or a mix with a larger group or freight vehicle?
