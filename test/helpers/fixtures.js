// -----------------------------------------------------------------------------
// Fixture loading and a fake fetch answering like FMI.
// See test/fixtures/README.md for where each fixture comes from.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { FORECAST_PARAMETERS, WARNINGS_URL, WFS_URL } from '../../src/api.js';
import { parseForecast } from '../../src/forecast.js';

// The real responses were recorded on 2026-10-23 at 23:11 UTC; the first row
// of the forecasts is 2026-10-24 00:00 UTC (so the hour under way is
// 23:00-00:00), the last observations 23:00 and 23:10 UTC.
const FIXTURE_NOW = Date.UTC(2026, 9, 23, 23, 15);

// The locations of the real fixtures, as houses of Gladys.
const HOUSES = Object.freeze({
  helsinki: {
    id: 'h-helsinki',
    name: 'Home',
    selector: 'home',
    latitude: 60.1699,
    longitude: 24.9384,
    fixture: 'helsinki',
  },
  tampere: {
    id: 'h-tampere',
    name: 'Cottage',
    selector: 'cottage',
    latitude: 61.4978,
    longitude: 23.761,
    fixture: 'tampere',
  },
  rovaniemi: {
    id: 'h-rovaniemi',
    name: 'Cabin',
    selector: 'cabin',
    latitude: 66.5039,
    longitude: 25.7294,
    fixture: 'rovaniemi',
  },
  paris: {
    id: 'h-paris',
    name: 'Maison',
    selector: 'maison',
    latitude: 48.8566,
    longitude: 2.3522,
    fixture: null,
  },
});

/**
 * @description The house as Gladys returns it (GET /house): the five fields.
 * @param {object} house - A HOUSES entry.
 * @returns {object} `{ id, name, selector, latitude, longitude }`.
 * @example
 * asGladysHouse(HOUSES.helsinki);
 */
function asGladysHouse({ id, name, selector, latitude, longitude }) {
  return { id, name, selector, latitude, longitude };
}

/**
 * @description Load a text fixture.
 * @param {string} name - The file name in test/fixtures.
 * @returns {string} The content.
 * @example
 * loadText('real-warnings.xml');
 */
function loadText(name) {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

/**
 * @description Load a JSON fixture (a fresh copy on every call).
 * @param {string} name - The file name in test/fixtures.
 * @returns {any} The parsed JSON.
 * @example
 * loadFixture('gladys-feature-table.json');
 */
function loadFixture(name) {
  return JSON.parse(loadText(name));
}

/**
 * @description The raw forecast of a house.
 * @param {object} house - A HOUSES entry.
 * @returns {string} The XML.
 * @example
 * forecastXml(HOUSES.helsinki);
 */
function forecastXml(house) {
  return loadText(`real-forecast-${house.fixture}.xml`);
}

/**
 * @description The raw observations around a house.
 * @param {object} house - A HOUSES entry.
 * @returns {string} The XML.
 * @example
 * observationsXml(HOUSES.helsinki);
 */
function observationsXml(house) {
  return loadText(`real-observations-${house.fixture}.xml`);
}

/**
 * @description The slim forecast of a house (without observation).
 * @param {object} house - A HOUSES entry.
 * @returns {object} The parsed forecast.
 * @example
 * forecastOf(HOUSES.helsinki);
 */
function forecastOf(house) {
  return parseForecast(forecastXml(house));
}

/**
 * @description Change the hourly periods of a raw forecast, to stage a
 * shower. The period starting at T is carried by the row of T + 1 h
 * (`Precipitation1h` is the amount of the previous hour).
 * @param {string} xml - A raw forecast.
 * @param {object} changes - `{ 'ISO start': { symbol (WeatherSymbol3),
 * amount, probability? } }`.
 * @returns {string} The changed forecast.
 * @example
 * withHours(xml, { '2026-10-24T00:00:00Z': { symbol: 31, amount: 1.2 } });
 */
function withHours(xml, changes) {
  const positions = /<gmlcov:positions>([\s\S]*?)<\/gmlcov:positions>/.exec(xml)[1].split('\n');
  const block = /(<gml:doubleOrNilReasonTupleList>)([\s\S]*?)(<\/gml:doubleOrNilReasonTupleList>)/;
  const rows = block.exec(xml)[2].split('\n');
  const epochs = positions.map((line) => line.trim().split(/\s+/)[2]);
  const column = (name) => FORECAST_PARAMETERS.indexOf(name);
  for (const [from, change] of Object.entries(changes)) {
    const epoch = String((Date.parse(from) + 3600000) / 1000);
    const index = epochs.indexOf(epoch);
    if (index === -1) {
      throw new Error(`No hourly period from ${from}`);
    }
    const values = rows[index].trim().split(/\s+/);
    values[column('Precipitation1h')] = String(change.amount);
    values[column('WeatherSymbol3')] = String(change.symbol);
    values[column('PoP')] = String(change.probability ?? 50);
    rows[index] = `                ${values.join(' ')} `;
  }
  return xml.replace(block, (match, open, body, close) => `${open}${rows.join('\n')}${close}`);
}

/**
 * @description A fake fetch. `route(url, init)` returns `{ status, body,
 * headers }` (or throws to simulate a network error); every call is recorded
 * with its headers.
 * @param {Function} route - The router.
 * @returns {Function} The fetch, with `.calls` (`{ url, headers }`).
 * @example
 * const fetchImpl = fakeFetch(() => ({ body: loadText('real-warnings.xml') }));
 */
function fakeFetch(route) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...init.headers } });
    const { status = 200, body = '', headers = {} } = await route(String(url), init);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/**
 * @description The house of a WFS request URL, by its coordinates (`latlon`
 * of a forecast, centre of the `bbox` of the observations).
 * @param {string} url - The request URL.
 * @returns {object} The HOUSES entry.
 * @example
 * houseForUrl(buildForecastUrl(60.1699, 24.9384, FIXTURE_NOW));
 */
function houseForUrl(url) {
  const params = new URL(url).searchParams;
  let lat;
  let lon;
  if (params.has('latlon')) {
    [lat, lon] = params.get('latlon').split(',').map(Number);
  } else {
    const [west, south, east, north] = params.get('bbox').split(',').map(Number);
    lat = (south + north) / 2;
    lon = (west + east) / 2;
  }
  const house = Object.values(HOUSES).find(
    (candidate) =>
      Math.abs(lat - candidate.latitude) < 1e-3 && Math.abs(lon - candidate.longitude) < 1e-3,
  );
  if (house === undefined) {
    throw new Error(`No fixture for ${url}`);
  }
  return house;
}

/**
 * @description An answer like FMI's: the forecast or observation fixture of
 * the location (the 400 of FMI outside its domain), or the warning feed.
 * @param {object} [options] - Options.
 * @param {Function} [options.warnings] - `() => feed`, the real feed of
 * 2026-10-23 by default.
 * @param {Function} [options.forecast] - `(house) => xml`, the fixture of
 * the house by default.
 * @param {Function} [options.observations] - `(house) => xml`, likewise.
 * @returns {Function} A route for fakeFetch.
 * @example
 * fakeFetch(fmiRoute());
 */
function fmiRoute({
  warnings = () => loadText('real-warnings.xml'),
  forecast = (house) => forecastXml(house),
  observations = (house) => observationsXml(house),
} = {}) {
  return (url) => {
    if (url === WARNINGS_URL) {
      return { body: warnings(), headers: { 'content-type': 'application/atom+xml' } };
    }
    if (url.startsWith(WFS_URL)) {
      const house = houseForUrl(url);
      if (house.fixture === null) {
        return { status: 400, body: loadText('real-paris-outside.xml') };
      }
      const query = new URL(url).searchParams.get('storedquery_id');
      return {
        body: query.includes('forecast') ? forecast(house) : observations(house),
        headers: { 'content-type': 'text/xml' },
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
}

/**
 * @description A logger that records nothing.
 * @returns {object} The logger.
 * @example
 * createApp(gladys, { logger: silentLogger() });
 */
function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

/**
 * @description A logger that keeps every line, by level.
 * @returns {object} The logger, with `lines` (`[{ level, message }]`) and
 * `at(level)` (the messages of one level).
 * @example
 * const logger = recordingLogger(); logger.at('info');
 */
function recordingLogger() {
  const lines = [];
  const record = (level) => (message) => lines.push({ level, message: String(message) });
  return {
    lines,
    at: (level) => lines.filter((line) => line.level === level).map((line) => line.message),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

/**
 * @description A clock the test moves by hand.
 * @param {number} start - The start, in ms.
 * @returns {Function} `() => ms`, with `.advance(ms)` and `.set(ms)`.
 * @example
 * const clock = manualClock(FIXTURE_NOW); clock.advance(60000);
 */
function manualClock(start) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  now.set = (ms) => {
    current = ms;
  };
  return now;
}

export {
  FIXTURE_NOW,
  HOUSES,
  asGladysHouse,
  fakeFetch,
  fmiRoute,
  forecastOf,
  forecastXml,
  houseForUrl,
  loadFixture,
  loadText,
  manualClock,
  observationsXml,
  withHours,
  recordingLogger,
  silentLogger,
};
