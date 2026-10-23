// -----------------------------------------------------------------------------
// The current conditions of a house: the latest observation of the nearest
// FMI weather station that measures the temperature.
//
// The answer (api.js, wfs.js) holds the last 70 minutes of every station of
// a box around the house, every 10 minutes. Measured on 2026-10-24:
//   - a station does not measure everything: road and port stations have no
//     cloud cover nor visibility, some lack the temperature for a while.
//     The nearest station with a recent temperature wins; each other value
//     is its latest one at that station, never borrowed from another;
//   - `r_1h` (precipitation of the last hour) is only given on the hour;
//   - `n_man` is the cloud cover in oktas (0-8; 9 = sky obscured);
//   - the last rows of a station may still be NaN (not yet received).
// Beyond 50 km, or older than 90 minutes, the observation is ignored and the
// forecast describes the current weather.
// -----------------------------------------------------------------------------

import { parseCoverage } from './wfs.js';

const MAX_DISTANCE_KM = 50;
const MAX_AGE_MS = 90 * 60 * 1000;
const EARTH_RADIUS_KM = 6371;

/**
 * @description The great-circle distance between two points.
 * @param {number} lat1 - Degrees.
 * @param {number} lon1 - Degrees.
 * @param {number} lat2 - Degrees.
 * @param {number} lon2 - Degrees.
 * @returns {number} Kilometres.
 * @example
 * distanceKm(60.17, 24.94, 61.5, 23.76); // -> about 160
 */
function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @description The latest value of a parameter among rows sorted by time.
 * @param {Array<object>} rows - The rows of one station.
 * @param {string} field - The parameter.
 * @returns {{value: number, time: number}|null} The value and its time.
 * @example
 * latest(rows, 't2m');
 */
function latest(rows, field) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = rows[index].values[field];
    if (value !== null && value !== undefined) {
      return { value, time: rows[index].time };
    }
  }
  return null;
}

/**
 * @description Cloud cover in percent from oktas.
 * @param {number|null} oktas - 0-8, 9 for an obscured sky.
 * @returns {number|null} Percent.
 * @example
 * oktasToPercent(4); // -> 50
 */
function oktasToPercent(oktas) {
  if (oktas === null || oktas < 0 || oktas > 9) {
    return null;
  }
  return Math.round((Math.min(oktas, 8) / 8) * 100);
}

/**
 * @description Parse the observations and keep the nearest usable station.
 * @param {string} xml - The answer.
 * @param {object} options - Options.
 * @param {number} options.latitude - The latitude of the house.
 * @param {number} options.longitude - Its longitude.
 * @param {number} options.now - The current time in ms.
 * @returns {object|null} `{ station: { id, name, latitude, longitude,
 * distanceKm }, time, temperature, humidity, dewPoint, pressure, windSpeed,
 * windDirection, windGust, cloudCover, visibility (m), precipitation1h }`,
 * null when no station is close and recent enough.
 * @example
 * readObservation(xml, { latitude: 60.17, longitude: 24.94, now: Date.now() });
 */
function readObservation(xml, { latitude, longitude, now }) {
  const { rows } = parseCoverage(xml);
  const byStation = new Map();
  for (const row of rows) {
    if (row.place === null) {
      continue;
    }
    if (!byStation.has(row.place)) {
      byStation.set(row.place, []);
    }
    byStation.get(row.place).push(row);
  }
  const candidates = [...byStation.entries()]
    .map(([place, stationRows]) => ({
      place,
      rows: stationRows.sort((a, b) => a.time - b.time),
      distance: distanceKm(latitude, longitude, place.latitude, place.longitude),
    }))
    .filter(({ distance }) => distance <= MAX_DISTANCE_KM)
    .sort((a, b) => a.distance - b.distance);
  for (const { place, rows: stationRows, distance } of candidates) {
    const temperature = latest(stationRows, 't2m');
    if (temperature === null || now - temperature.time > MAX_AGE_MS) {
      continue;
    }
    // Values measured at the time of the temperature or a little before.
    const at = (field) => {
      const found = latest(
        stationRows.filter((row) => row.time <= temperature.time),
        field,
      );
      return found !== null && temperature.time - found.time <= 30 * 60 * 1000 ? found.value : null;
    };
    return {
      station: {
        id: place.id,
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
        distanceKm: Math.round(distance * 10) / 10,
      },
      time: temperature.time,
      temperature: temperature.value,
      humidity: at('rh'),
      dewPoint: at('td'),
      pressure: at('p_sea'),
      windSpeed: at('ws_10min'),
      windDirection: at('wd_10min'),
      windGust: at('wg_10min'),
      cloudCover: oktasToPercent(at('n_man')),
      visibility: at('vis'),
      precipitation1h: latest(stationRows, 'r_1h')?.value ?? null,
    };
  }
  return null;
}

/**
 * @description Whether an observation still describes now.
 * @param {object|null} observation - The observation.
 * @param {number} now - The current time in ms.
 * @returns {boolean} true when recent enough.
 * @example
 * isFresh(observation, Date.now());
 */
function isFresh(observation, now) {
  return observation !== null && observation !== undefined && now - observation.time <= MAX_AGE_MS;
}

export { MAX_AGE_MS, MAX_DISTANCE_KM, distanceKm, isFresh, oktasToPercent, readObservation };
