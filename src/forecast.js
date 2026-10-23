// -----------------------------------------------------------------------------
// Parse an FMI forecast (wfs.js) into the slim forecast the integration
// caches.
//
// The answer of the edited forecast (api.js) is hourly for about 9.5 days,
// then NaN up to the requested end: rows without a temperature are dropped.
// Every time is UTC, every value metric.
//
// Each row holds the state of the air at its time (temperature, feels-like,
// wind, gust, humidity, pressure, dew point, cloud cover, UV) and what
// happened during the hour that ENDS at it: `Precipitation1h` is the amount
// of the previous hour, and the symbol and the probability go with it. The
// period is attached to the point it STARTS at, the way MET Norway's
// `next_1_hours` does, so that the hour under way — which ends at the first
// row — gets a point of its own, with the values of that first row.
//
// FMI's `WeatherSymbol3` numbers become MET Norway symbol codes
// (symbols.js turns them into Gladys conditions):
//   1 clear  2 partly cloudy  3 cloudy
//   21-23 showers  31-33 rain  41-43 snow showers  51-53 snowfall
//   61-62 thundershowers  63-64 thunder  71-73 sleet showers  81-83 sleet
//   91-92 mist and fog
// The last digit is the intensity: 1 light, 2 moderate, 3 heavy.
// -----------------------------------------------------------------------------

import { num, parseCoverage } from './wfs.js';

const HOUR_MS = 60 * 60 * 1000;

const FMI_SYMBOLS = Object.freeze({
  1: 'clearsky',
  2: 'partlycloudy',
  3: 'cloudy',
  21: 'lightrainshowers',
  22: 'rainshowers',
  23: 'heavyrainshowers',
  31: 'lightrain',
  32: 'rain',
  33: 'heavyrain',
  41: 'lightsnowshowers',
  42: 'snowshowers',
  43: 'heavysnowshowers',
  51: 'lightsnow',
  52: 'snow',
  53: 'heavysnow',
  61: 'rainshowersandthunder',
  62: 'heavyrainshowersandthunder',
  63: 'rainandthunder',
  64: 'heavyrainandthunder',
  71: 'lightsleetshowers',
  72: 'sleetshowers',
  73: 'heavysleetshowers',
  81: 'lightsleet',
  82: 'sleet',
  83: 'heavysleet',
  91: 'fog',
  92: 'fog',
});

/**
 * @description The MET Norway symbol code of an FMI WeatherSymbol3 number.
 * Night variants (number + 100, in SmartSymbol) are folded: day and night
 * come from the sun.
 * @param {any} value - The number ('31.0').
 * @returns {string|null} The symbol code, or null when unknown.
 * @example
 * fmiSymbol('31.0'); // -> 'lightrain'
 */
function fmiSymbol(value) {
  const number = num(value);
  if (number === null) {
    return null;
  }
  return FMI_SYMBOLS[Math.round(number) % 100] ?? null;
}

/**
 * @description Parse an FMI forecast.
 * @param {string} xml - The XML body.
 * @returns {object} The slim forecast: `{ latitude, longitude, place,
 * updatedAt (ms or null), points: [{ time (ms), temperature,
 * apparentTemperature, humidity, pressure, dewPoint, windSpeed,
 * windDirection, windGust, cloudCover, uvIndex, next1, period }] }`, the
 * points sorted by time. `period` is the hour starting at the point (`{
 * hours: 1, symbol, precipitation, probability, thunderProbability }`),
 * `next1` the same.
 * @throws {Error} When the body holds no usable row.
 * @example
 * const forecast = parseForecast(await response.text());
 */
function parseForecast(xml) {
  const { rows, places } = parseCoverage(xml);
  const instants = [];
  for (const { time, values } of rows) {
    const temperature = values.Temperature;
    if (temperature === null || temperature === undefined) {
      continue;
    }
    instants.push({
      time,
      temperature,
      apparentTemperature: values.FeelsLike ?? null,
      humidity: values.Humidity ?? null,
      pressure: values.Pressure ?? null,
      dewPoint: values.DewPoint ?? null,
      windSpeed: values.WindSpeedMS ?? null,
      windDirection: values.WindDirection ?? null,
      windGust: values.HourlyMaximumGust ?? null,
      cloudCover: values.TotalCloudCover ?? null,
      uvIndex: values.UVIndex ?? null,
      // The hour that ends at this row.
      ending: {
        hours: 1,
        symbol: fmiSymbol(values.WeatherSymbol3),
        precipitation: values.Precipitation1h ?? null,
        probability: values.PoP ?? null,
        thunderProbability: values.ProbabilityThunderstorm ?? null,
      },
    });
  }
  if (instants.length === 0) {
    throw new Error('FMI has no forecast for this location');
  }
  instants.sort((a, b) => a.time - b.time);

  const byTime = new Map(instants.map((instant) => [instant.time, instant]));
  const points = [];
  const first = instants[0];
  // The hour under way: it ends at the first row, which lends it its values.
  const all = [{ ...first, time: first.time - HOUR_MS }, ...instants];
  for (const { ending: _ending, ...instant } of all) {
    const next = byTime.get(instant.time + HOUR_MS);
    const period = next === undefined ? null : next.ending;
    points.push({ ...instant, period, next1: period });
  }

  const place = places[0] ?? null;
  const analysis = Date.parse(
    /<om:resultTime>[\s\S]*?<gml:timePosition>([^<]*)</.exec(xml)?.[1] ?? '',
  );
  return {
    latitude: place?.latitude ?? null,
    longitude: place?.longitude ?? null,
    place: place?.name ?? null,
    updatedAt: Number.isFinite(analysis) ? analysis : null,
    points,
  };
}

export { FMI_SYMBOLS, fmiSymbol, parseForecast };
