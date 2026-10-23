# FMI for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) weather provider for
Finland: the station measurements, the forecasts and the **official weather
warnings** of the [Finnish Meteorological Institute](https://en.ilmatieteenlaitos.fi/)
(FMI, Ilmatieteen laitos). Open data: no account, no API key.

Source: Finnish Meteorological Institute, data under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This is a community
project, **not affiliated with FMI**.

> **Developed without a Gladys running in Finland**: tested against real
> answers of FMI (Helsinki, Tampere, Rovaniemi, and the warnings of
> 23 October 2026). Feedback welcome.

## What it does

- **Weather provider** (manifest `type: "weather"`, Gladys 5.2.0 or later):
  the Gladys weather widget and the chat assistant show the current weather
  measured by the nearest FMI station (completed by the forecast), the next
  24 hours (precipitation and its probability, gusts, feels-like) and the next
  8 days of every house of Gladys in or near Finland, in metric or US units.
- **Official warnings**: the FMI warnings whose area holds each house
  (yellow, orange, red: wind, rain, thunderstorm, cold, heat, forest fire,
  traffic weather, pedestrian safety, UV, sea level) are sent as the alerts of
  the weather answer. The weather widget shows them, and the built-in weather
  alert trigger of Gladys fires on them — within a minute, as the integration
  asks the core to pull the weather again after a change.
- **Scene triggers** "FMI warning changed" (issued, upgraded, downgraded,
  updated, lifted; filters on house, change, level, phenomenon), and "Rain or
  snow expected within the hour".
- **Scene actions**: precipitation of the next hour, forecast of the day,
  warnings of a house (highest level).
- Texts of the scenes in English, French, German or Spanish.

The user documentation, in four languages, is in [`docs/`](docs/en.md).

## Install

In Gladys 5.2.0 or later: **Integrations → Install from GitHub**, address
`https://github.com/guim31/gladys-fmi` (or from the integration store once
published). Give your houses a location (**Settings → Houses**), then click
**Test FMI** in the **Configuration** tab.

## Calls and FMI's terms

All on FMI's open data services, without key:

- Forecast: WFS stored query
  `fmi::forecast::edited::weather::scandinavia::point::multipointcoverage` on
  `https://opendata.fmi.fi/wfs`, by `latlon`, hourly, about 9.5 days — the
  forecast edited by FMI's forecasters. The `multipointcoverage` answer is a
  value table of about 40 KB (the `simple` one weighs 2.7 MB). Outside the
  domain, FMI answers `400 No data available`: the core falls back to another
  provider.
- Observations: `fmi::observations::weather::multipointcoverage` on the same
  service, by a `bbox` of about 100 km around the house (the `latlon` +
  `maxlocations` form answers nothing for the centre of Helsinki), the last
  70 minutes; the nearest station within 50 km with a recent temperature wins.
- Warnings: the CAP 1.2 Atom feed `https://alerts.fmi.fi/cap/feed/atom_en-GB.xml`,
  with the polygon of every warning area; a house gets the warnings whose
  polygon holds it (2 km of tolerance for simplified coasts).
- One forecast and one observation call per house location and one warning
  call for all houses, every 30 minutes at most (plus 0-5 min of jitter):
  about 150 requests a day for one house, against FMI's limits of 20,000 a day
  and 600 per 5 minutes. The User-Agent is
  `gladys-fmi/<version> github.com/guim31/gladys-fmi`; coordinates are rounded
  to 4 decimals; 429 and 403 pause the calls.
- Data under [CC BY 4.0](https://en.ilmatieteenlaitos.fi/open-data-licence):
  "Source: Finnish Meteorological Institute" is credited in the configuration
  screen and in the documentation.

## Limits

- Finland and its surroundings only.
- The current sky (clear, rain…) comes from the forecast; road and port
  stations do not measure everything, the forecast fills in.
- Warning texts are English (FMI also publishes Finnish and Swedish); the
  integration translates the level, the phenomenon and the change. Sea-area
  warnings and green notices are left out, the sea level warning is kept.
- One warning per phenomenon and house (the highest level), like the core's
  own alert trigger.

## Development

Node.js 22+, ESM, no build step; the only runtime dependency is
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

```bash
npm ci
npm run format:check   # Prettier (Markdown included)
npm run lint           # ESLint
npm test               # node --test, never touches the network
npx github:GladysAssistant/integration-store .   # store admission checks
```

```
index.js                 SDK wiring only
src/app.js               the integration on an injected client (handlers, status, warnings)
src/api.js               the three FMI calls: addresses, User-Agent, error kinds
src/wfs.js               the WFS multipointcoverage reader (fields, rows, stations)
src/forecast.js          forecast → slim metric forecast, FMI symbols
src/observations.js      the nearest station and its latest measurements
src/forecast-store.js    cache per location, 30 min floor, shared calls, 429 / 403 pauses
src/scheduler.js         the refresh timer (30 min, jitter, retries)
src/warnings.js          the CAP feed: parsing, polygons, pivot alerts, changes
src/pivot.js             slim forecast → Gladys pivot weather, in the requested units
src/daily.js             the days, from the hours
src/symbols.js           MET Norway symbols → Gladys conditions
src/sun.js, time.js      computed sunrise/sunset, local days
src/next-hour.js         precipitation within the hour
src/scene-triggers.js    "precipitation expected within the hour"
src/warning-triggers.js  "FMI warning changed"
src/scene-actions.js     next hour, forecast of the day, warnings of a house
src/houses.js            the houses of Gladys
src/units.js, texts.js   conversions, the texts in English, French, German, Spanish
```

Run it against a Gladys instance:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="fmi" \
LOG_LEVEL=debug \
npm start
```

## Releasing

Versions belong to the **Release** workflow (Actions → Release → patch, minor
or major): it bumps `package.json` and the manifest `version`/`docker_image`,
moves the `## [Unreleased]` section of [`CHANGELOG.md`](CHANGELOG.md), tags,
builds the multi-arch image to `ghcr.io/guim31/gladys-fmi` and publishes the
GitHub Release.

> A hand-pushed tag (`git tag v1.0.0 && git push --tags`) triggers the same
> build and Release but touches no file: bump `version` in `package.json` and
> in `gladys-assistant-integration.json` (with the `docker_image` tag) and
> commit **before** tagging.

## Credits

- Observations, forecasts and warnings: Source: Finnish Meteorological
  Institute ([en.ilmatieteenlaitos.fi](https://en.ilmatieteenlaitos.fi/)),
  under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- The symbols are mapped to MET Norway's: the legend comes from
  [metno/weathericons](https://github.com/metno/weathericons) (MIT, © Yr),
  copied in `test/fixtures/weathericons-legend.csv`. The forecast, cache and
  scene code comes from the sister integrations
  [MET Norway for Gladys](https://github.com/guim31/gladys-met-no) (a
  worldwide forecast from [MET Norway](https://api.met.no/), Finland
  included, without the Finnish stations nor warnings) and
  [Met Éireann for Gladys](https://github.com/guim31/gladys-met-eireann).
- The idea comes from the Home Assistant
  [`fmi`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/fmi)
  integration (Apache-2.0) and its
  [`fmi-weather-client`](https://github.com/saaste/fmi-weather-client) library.
- Cover: the official English logo of the Finnish Meteorological Institute,
  from [en.ilmatieteenlaitos.fi](https://en.ilmatieteenlaitos.fi/), in white on
  its brand blue (#303193).
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js).

## License

Apache-2.0
