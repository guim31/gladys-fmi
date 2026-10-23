# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- FMI weather for Gladys (Gladys 5.2.0 or later): the current weather measured
  by the nearest FMI station, completed by the forecast, the next 24 hours
  with the precipitation of each hour and its probability, and the next 8
  days, for every house of Gladys in or near Finland, in metric or US units.
  Open data, no account, no API key.
- The official FMI warnings whose area holds each house (yellow, orange, red:
  wind, rain, thunderstorm, cold, heat, forest fire, traffic weather,
  pedestrian safety, UV, sea level), as alerts of the Gladys weather widget;
  the built-in weather alert scene trigger of Gladys sees a change within a
  minute.
- Scene trigger "FMI warning changed": a warning issued, upgraded,
  downgraded, updated or lifted, filtered by house, change, level and
  phenomenon, with a ready-to-send sentence in English, French, German or
  Spanish.
- Scene trigger "Rain or snow expected within the hour".
- Scene actions "Get the precipitation of the next hour", "Get the forecast of
  the day" (today or tomorrow) and "Get the FMI warnings" (the highest level
  for a house).
- Settings: units and language of the scene texts. A "Test FMI" button that
  names the station used.

[Unreleased]: https://github.com/guim31/gladys-fmi/commits/main
