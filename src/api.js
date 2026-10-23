// -----------------------------------------------------------------------------
// FMI open data clients: three requests, no key, no account.
//
//   Forecast      GET https://opendata.fmi.fi/wfs?…&storedquery_id=
//                 fmi::forecast::edited::weather::scandinavia::point::multipointcoverage
//                 &latlon=..,..&timestep=60&endtime=..&parameters=..
//                 The forecast edited by FMI's forecasters, hourly for about
//                 10 days (wfs.js, forecast.js). The `multipointcoverage`
//                 answer is a value table (about 40 KB); the `simple` one
//                 repeats a whole XML element per value (2.7 MB).
//   Observations  GET same address, storedquery_id=
//                 fmi::observations::weather::multipointcoverage&bbox=..
//                 The last hour of the stations around a house, every 10
//                 minutes (observations.js). `latlon` + `maxlocations` answers
//                 nothing for the centre of Helsinki: the box is reliable.
//   Warnings      GET https://alerts.fmi.fi/cap/feed/atom_en-GB.xml
//                 The CAP warnings in force or announced, with the polygon of
//                 every area (warnings.js).
//
// Terms (https://en.ilmatieteenlaitos.fi/open-data-licence): CC BY 4.0,
// "Source: Finnish Meteorological Institute" to be cited; 20,000 requests a
// day and 600 every 5 minutes per user. The integration stays far below:
// two forecast-side requests per house and one warning feed every 30 minutes
// (forecast-store.js, warnings.js).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const WFS_URL = 'https://opendata.fmi.fi/wfs';
const WARNINGS_URL = 'https://alerts.fmi.fi/cap/feed/atom_en-GB.xml';
const FORECAST_QUERY = 'fmi::forecast::edited::weather::scandinavia::point::multipointcoverage';
const OBSERVATIONS_QUERY = 'fmi::observations::weather::multipointcoverage';
const CONTACT = 'github.com/guim31/gladys-fmi';

// The forecast parameters, in the order of the value table.
const FORECAST_PARAMETERS = Object.freeze([
  'Temperature',
  'FeelsLike',
  'Humidity',
  'DewPoint',
  'Pressure',
  'WindSpeedMS',
  'WindDirection',
  'HourlyMaximumGust',
  'TotalCloudCover',
  'Precipitation1h',
  'PoP',
  'ProbabilityThunderstorm',
  'WeatherSymbol3',
  'UVIndex',
]);
// The observed parameters: temperature, 10-minute wind, gust and direction,
// humidity, dew point, precipitation of the last hour, sea-level pressure,
// cloud cover (oktas), visibility (m), present weather (WMO 4680).
const OBSERVATION_PARAMETERS = Object.freeze([
  't2m',
  'ws_10min',
  'wg_10min',
  'wd_10min',
  'rh',
  'td',
  'r_1h',
  'p_sea',
  'n_man',
  'vis',
  'wawa',
]);

const FORECAST_DAYS = 10;
const OBSERVATION_WINDOW_MS = 70 * 60 * 1000;
// Half-size of the observation box, in degrees: about 55 km north-south and
// 50 km east-west at 63° N, enough for a station almost everywhere in Finland.
const BOX_LATITUDE = 0.5;
const BOX_LONGITUDE = 1;

// Under the 15 s the core waits for a weather answer, with room to build it.
const REQUEST_TIMEOUT_MS = 10000;

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const USER_AGENT = `gladys-fmi/${PACKAGE.version} ${CONTACT}`;

// What went wrong, as the rest of the integration needs to react to it.
const ERROR_KINDS = Object.freeze({
  THROTTLED: 'throttled', // 429: too many requests — back off
  FORBIDDEN: 'forbidden', // 403: refused (or banned) — stop for a long while
  REQUEST: 'request', // other 4xx: bad coordinates — skip this location
  UPSTREAM: 'upstream', // 5xx: retry later
  NETWORK: 'network', // DNS, timeout, reset: retry later
  INVALID: 'invalid', // no usable data (outside the domain, unusable body)
});

class FmiError extends Error {
  /**
   * @param {string} kind - One of ERROR_KINDS.
   * @param {string} message - A message safe to log.
   * @param {object} [details] - { status, retryAfterMs }.
   */
  constructor(kind, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'FmiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * @description A coordinate with at most 4 decimals (about 10 m): enough
 * for a 2.5 km model, and the same location keeps the same address.
 * @param {number} value - Degrees.
 * @returns {string} The coordinate.
 * @example
 * formatCoordinate(60.169856); // -> '60.1699'
 */
function formatCoordinate(value) {
  return String(Number(value.toFixed(4)));
}

/**
 * @description An instant as FMI wants it: ISO 8601, whole minutes, UTC.
 * @param {number} ms - The instant.
 * @returns {string} The time.
 * @example
 * formatTime(0); // -> '1970-01-01T00:00:00Z'
 */
function formatTime(ms) {
  return `${new Date(Math.floor(ms / 60000) * 60000).toISOString().slice(0, 16)}:00Z`;
}

/**
 * @description Build the forecast URL.
 * @param {number} latitude - The latitude.
 * @param {number} longitude - The longitude.
 * @param {number} now - The current time in ms.
 * @returns {string} The URL.
 * @example
 * buildForecastUrl(60.1699, 24.9384, Date.now());
 */
function buildForecastUrl(latitude, longitude, now) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'getFeature',
    storedquery_id: FORECAST_QUERY,
    latlon: `${formatCoordinate(latitude)},${formatCoordinate(longitude)}`,
    timestep: '60',
    // Rounded to the hour: the same location keeps the same address.
    endtime: formatTime(Math.floor(now / 3600000) * 3600000 + FORECAST_DAYS * 86400000),
    parameters: FORECAST_PARAMETERS.join(','),
  });
  return `${WFS_URL}?${params}`;
}

/**
 * @description Build the observation URL: the stations of a box around the
 * location, the last 70 minutes, every 10 minutes.
 * @param {number} latitude - The latitude.
 * @param {number} longitude - The longitude.
 * @param {number} now - The current time in ms.
 * @returns {string} The URL.
 * @example
 * buildObservationsUrl(60.1699, 24.9384, Date.now());
 */
function buildObservationsUrl(latitude, longitude, now) {
  const box = [
    longitude - BOX_LONGITUDE,
    latitude - BOX_LATITUDE,
    longitude + BOX_LONGITUDE,
    latitude + BOX_LATITUDE,
  ].map(formatCoordinate);
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'getFeature',
    storedquery_id: OBSERVATIONS_QUERY,
    bbox: box.join(','),
    timestep: '10',
    starttime: formatTime(now - OBSERVATION_WINDOW_MS),
    parameters: OBSERVATION_PARAMETERS.join(','),
  });
  return `${WFS_URL}?${params}`;
}

/**
 * @description Classify a non-success status.
 * @param {number} status - The HTTP status.
 * @param {string|null} reason - The reason FMI gave.
 * @returns {string} One of ERROR_KINDS.
 * @example
 * kindOfStatus(429); // -> 'throttled'
 */
function kindOfStatus(status, reason = null) {
  if (status === 429) {
    return ERROR_KINDS.THROTTLED;
  }
  if (status === 403) {
    return ERROR_KINDS.FORBIDDEN;
  }
  // Outside the forecast domain (Paris, New York): "No data available for
  // 'Paris'!", with a 400.
  if (status === 400 && /no data available/i.test(reason ?? '')) {
    return ERROR_KINDS.INVALID;
  }
  if (status >= 400 && status < 500) {
    return ERROR_KINDS.REQUEST;
  }
  return ERROR_KINDS.UPSTREAM;
}

/**
 * @description Read a `Retry-After` header: seconds or an HTTP date.
 * @param {string|null} value - The header value.
 * @param {number} now - The current time in ms.
 * @returns {number|null} The delay in ms.
 * @example
 * readRetryAfter('120', Date.now()); // -> 120000
 */
function readRetryAfter(value, now) {
  if (value === null || value === undefined || value.trim() === '') {
    return null;
  }
  if (/^\d+$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * @description The reason of a WFS error: the first `ExceptionText` of its
 * `ExceptionReport`, bounded. Never the second one, which echoes the URL.
 * @param {string} text - The body.
 * @returns {string|null} The reason.
 * @example
 * readReason('<ExceptionText>No data available for &apos;Paris&apos;!</ExceptionText>');
 */
function readReason(text) {
  const match = /<ExceptionText>([^<]*)<\/ExceptionText>/.exec(text ?? '');
  if (match === null || match[1].trim() === '') {
    return null;
  }
  return match[1]
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
    .slice(0, 200);
}

/**
 * @description GET an FMI address.
 * @param {string} url - The address.
 * @param {object} options - Options.
 * @param {Function} options.fetchImpl - fetch.
 * @param {Function} options.now - `() => ms`.
 * @param {number} options.timeoutMs - The request timeout.
 * @returns {Promise<string>} The body of a 200.
 * @throws {FmiError} On any failure, classified by `kind`.
 * @example
 * await get(WARNINGS_URL, { fetchImpl: fetch, now: Date.now, timeoutMs: 10000 });
 */
async function get(url, { fetchImpl, now, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? 'timeout' : err?.cause?.code || err?.name;
    throw new FmiError(ERROR_KINDS.NETWORK, `FMI unreachable (${reason})`);
  }
  if (response.status !== 200) {
    const reason = readReason(await response.text().catch(() => ''));
    throw new FmiError(
      kindOfStatus(response.status, reason),
      `FMI answered HTTP ${response.status}${reason ? `: ${reason}` : ''}`,
      {
        status: response.status,
        retryAfterMs: readRetryAfter(response.headers.get('retry-after'), now()),
      },
    );
  }
  try {
    return await response.text();
  } catch {
    throw new FmiError(ERROR_KINDS.INVALID, 'FMI sent an unreadable body', {
      status: response.status,
    });
  }
}

/**
 * @description Check coordinates before any call.
 * @param {number} latitude - The latitude.
 * @param {number} longitude - The longitude.
 * @returns {FmiError|null} The error, or null.
 * @example
 * invalidCoordinates(60.17, 24.94); // -> null
 */
function invalidCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? null
    : new FmiError(ERROR_KINDS.REQUEST, 'Invalid coordinates');
}

/**
 * @description Fetch the forecast of a location.
 * @param {object} options - Options.
 * @param {number} options.latitude - The latitude.
 * @param {number} options.longitude - The longitude.
 * @param {Function} [options.fetchImpl] - fetch, injectable for the tests.
 * @param {Function} [options.now] - `() => ms`, for the tests.
 * @param {number} [options.timeoutMs] - The request timeout.
 * @returns {Promise<string>} The XML body.
 * @throws {FmiError} On any failure, classified by `kind`.
 * @example
 * const xml = await fetchForecast({ latitude: 60.1699, longitude: 24.9384 });
 */
function fetchForecast({
  latitude,
  longitude,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const invalid = invalidCoordinates(latitude, longitude);
  if (invalid !== null) {
    return Promise.reject(invalid);
  }
  return get(buildForecastUrl(latitude, longitude, now()), { fetchImpl, now, timeoutMs });
}

/**
 * @description Fetch the recent observations of the stations around a
 * location.
 * @param {object} options - Same options as fetchForecast.
 * @returns {Promise<string>} The XML body.
 * @throws {FmiError} On any failure, classified by `kind`.
 * @example
 * const xml = await fetchObservations({ latitude: 60.1699, longitude: 24.9384 });
 */
function fetchObservations({
  latitude,
  longitude,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const invalid = invalidCoordinates(latitude, longitude);
  if (invalid !== null) {
    return Promise.reject(invalid);
  }
  return get(buildObservationsUrl(latitude, longitude, now()), { fetchImpl, now, timeoutMs });
}

/**
 * @description Fetch the CAP feed of the FMI warnings.
 * @param {object} [options] - Options.
 * @param {Function} [options.fetchImpl] - fetch, injectable for the tests.
 * @param {Function} [options.now] - `() => ms`, for the tests.
 * @param {number} [options.timeoutMs] - The request timeout.
 * @returns {Promise<string>} The Atom feed.
 * @throws {FmiError} On any failure, classified by `kind`.
 * @example
 * const feed = await fetchWarnings();
 */
async function fetchWarnings({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const text = await get(WARNINGS_URL, { fetchImpl, now, timeoutMs });
  if (!/<feed\b/.test(text)) {
    throw new FmiError(ERROR_KINDS.INVALID, 'The warning feed is not an Atom feed');
  }
  return text;
}

export {
  ERROR_KINDS,
  FORECAST_PARAMETERS,
  FmiError,
  OBSERVATION_PARAMETERS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  WARNINGS_URL,
  WFS_URL,
  buildForecastUrl,
  buildObservationsUrl,
  fetchForecast,
  fetchObservations,
  fetchWarnings,
  formatCoordinate,
  formatTime,
  kindOfStatus,
  readReason,
  readRetryAfter,
};
