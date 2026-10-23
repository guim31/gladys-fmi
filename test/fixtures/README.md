# Test fixtures

## Real FMI answers

Every `real-*.xml` file is the untouched body of an FMI open data request,
recorded on 23 October 2026 at 23:11 UTC with the integration's User-Agent.
Public places and FMI's public weather stations only: no private location.
The tests read them "now" at 23:15 UTC (`FIXTURE_NOW`).

| File                              | Request                                                                                            | Why                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `real-forecast-helsinki.xml`      | `fmi::forecast::edited::weather::scandinavia::point::multipointcoverage`, `latlon=60.1699,24.9384` | Helsinki, under a yellow wind warning (Uusimaa)          |
| `real-forecast-tampere.xml`       | same, `latlon=61.4978,23.761`                                                                      | Tampere, light rain now, yellow wind warning (Pirkanmaa) |
| `real-forecast-rovaniemi.xml`     | same, `latlon=66.5039,25.7294`                                                                     | Rovaniemi, dry, no warning                               |
| `real-observations-helsinki.xml`  | `fmi::observations::weather::multipointcoverage`, `bbox` of ±1° lon / ±0.5° lat                    | 21 stations; the nearest, Kaisaniemi, measures all       |
| `real-observations-tampere.xml`   | same, around Tampere                                                                               | 6 stations; the nearest has no cloud cover               |
| `real-observations-rovaniemi.xml` | same, around Rovaniemi                                                                             | 5 stations; the nearest (a road station) has no wind     |
| `real-paris-outside.xml`          | the forecast query, `latlon=48.8566,2.3522`                                                        | Outside the domain: `400`, "No data available"           |
| `real-warnings.xml`               | `https://alerts.fmi.fi/cap/feed/atom_en-GB.xml`                                                    | 13 CAP alerts: one land wind warning, the rest at sea    |

The forecasts were asked with `timestep=60`, `endtime` 10 days ahead and the
14 parameters of `FORECAST_PARAMETERS` (`src/api.js`): 240 rows, the last 11
NaN (the edited forecast stops after about 9.5 days). Their first row is
2026-10-24 00:00 UTC. The observations were asked with `timestep=10` from
22:11 UTC.

The warning feed carries every alert in Finnish, Swedish and English, each
`Update` referencing all the earlier alerts it supersedes, and the polygon of
every area. Showers are staged on the real forecasts by `withHours()`
(`test/helpers/fixtures.js`), which rewrites the precipitation, the symbol and
the probability of chosen rows; warning changes by small CAP entries built in
`test/warnings.test.js`.

## Other files

- `weathericons-legend.csv`: `weather/legend.csv` of
  [metno/weathericons](https://github.com/metno/weathericons) (MIT, © Yr), the
  official list of the 41 symbols, as published (with its trailing space and
  its two misspelled ids). FMI's symbols are mapped onto these.
- `gladys-feature-table.json`: the category/type pairs the Gladys front end can
  display, shared by the maintainer's integrations. This one publishes no
  device (a weather provider), so no test reads it.
