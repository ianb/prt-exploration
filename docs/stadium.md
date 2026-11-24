# Stadium let-out: US Bank Stadium

**Question:** what happens when a stadium crowd leaves all at once, on top
of normal afternoon demand? `scripts/event.mjs` runs it.

## Assumptions

- **Crowd:** 66,000 attendance. 25% use PRT, in parties averaging 2.5 per
  vehicle: 6,600 vehicle loads, leaving over 45 minutes after a 3:30 PM end.
- **Background:** about 4,000 normal trips an hour around the city.
- **Where fans go:** no public data says where fans live. The stadium
  authority's economic impact study found about 26% of visitors are from
  out of state. Assumed:
  - **Minneapolis residents, 30%:** home, spread by population.
  - **Suburban fans, 45%:** park-and-ride stations at the city edge, by
    freeway direction:

    | Direction | Freeways | Share |
    |---|---|---|
    | North | I-94 / Hwy 252 | 25% |
    | Northeast | I-35W | 10% |
    | West | I-394 | 15% |
    | Southwest | Hwy 62 / 100 | 15% |
    | South | I-35W | 25% |
    | East | I-94 | 10% |

  - **Out-of-town visitors, 25%:** hotels. 60% in the city (spread by
    accommodation and food jobs), 40% at the edge toward the airport and
    Bloomington hotels.
- **Stations:** fans walk to any of the 12 stations within 1 km of the
  stadium, choosing by walk plus expected queue. They see everyone already
  waiting or walking to each station, and the vehicles there or on the way,
  as a stadium app would show.

## What it took to make it work at all

1. **Meter empties into the venue.** Sending an empty for every waiting
   party sent about 1,700 vehicles toward 360 bays. The surplus circled and
   gridlocked downtown. Fix: never send more vehicles to a station than it
   has free bays.
2. **Spread the crowd.** When fans judged queues only by who was already at
   a station, nearly everyone walked to the three closest stations while
   eight others sat with idle vehicles. Showing the whole picture spreads
   them out.
3. **Pre-stage the fleet.** With bays capped, refilling depends on how far
   away the empties are; returning from suburban park-and-rides takes
   15–20 minutes. A game lasts three hours, so vehicles should be parked
   beside the stadium during the game, for example on a floor of a nearby
   parking ramp. Modelled as 150 storage spots at each of the 12 stations
   (about 1,600 vehicles staged), plus a ring of stations within 2.5 km kept
   stocked.
4. **Fair launches.** Main-line vehicles booked merge slots further ahead
   than station vehicles could, so on busy lines loaded vehicles sat 6–12
   minutes waiting to leave. Now a vehicle that has waited claims the next
   slot, and main-line vehicles at least 80 m away yield. This also slightly
   improved normal service.

## Result

With all of the above (6,240 vehicles):

- **First 35–40 minutes:** fine. Pre-staged vehicles carry the first ~3,000
  parties with almost no wait.
- **After that:** the stadium area sends out roughly 3,000–4,500 vehicles an
  hour against 8,800 an hour arriving to leave, so a queue builds. About
  3,400 parties are still waiting an hour after the end of the let-out.
- **Rides get longer:** they stretch from about 10–15 minutes to about 20.
  The guideway lines leaving downtown east carry both loaded vehicles going
  out and empties coming back.
- **Everyone else's wait:** the 90th percentile rises from about 3 minutes
  to about 20 during the let-out.

**The binding limit is guideway capacity around the venue,** not fleet size,
station size or launching. Doubling the fleet or the bays barely changed
throughput. One lane at 0.5 s headways carries up to about 4,500 vehicles an
hour, less through junctions, and every fan trip needs two passes (an empty
in, a loaded vehicle out).

## Ways to close the gap (not yet modelled)

| Lever | Effect |
|---|---|
| Full vehicles | 3 people per vehicle instead of 2.5 cuts vehicles needed by about 17% |
| Shared rides by destination (e.g. one park-and-ride) | Fewer vehicles still |
| Dedicated event lines or loops around the stadium | More line capacity in and out |
| Platooning (vehicles leaving in coupled groups) | More vehicles per lane |
| Staggered or longer let-out | Spreads the demand |
| Light rail and buses carrying more of the crowd | Lower PRT share. The Blue and Green Lines stop at the stadium and are built for this |

A 25% PRT share of a 66,000 crowd is probably more than this network
should carry on its own. About 10–12% (7,000–8,000 people) would clear
within the let-out window.

Source: Minnesota Sports Facilities Authority,
[U.S. Bank Stadium economic impact study](https://www.usbankstadium.com/news/detail/minnesota-sports-facilities-authority-releases-economic-impact-study-of-us-bank-stadium) (Placer.ai data: 26% of visitors from out of state).
