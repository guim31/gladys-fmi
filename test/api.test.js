// -----------------------------------------------------------------------------
// The FMI clients: the requests (addresses, User-Agent) and the
// classification of the failures.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_KINDS,
  FORECAST_PARAMETERS,
  USER_AGENT,
  WARNINGS_URL,
  WFS_URL,
  buildForecastUrl,
  buildObservationsUrl,
  fetchForecast,
  fetchObservations,
  fetchWarnings,
  formatTime,
  readReason,
  readRetryAfter,
} from '../src/api.js';
import { FIXTURE_NOW, fakeFetch, loadText } from './helpers/fixtures.js';

test('the forecast address: edited forecast, 4 decimals, hourly, 10 days', () => {
  const url = new URL(buildForecastUrl(60.169856, 24.93841, FIXTURE_NOW));
  assert.equal(`${url.origin}${url.pathname}`, WFS_URL);
  const params = Object.fromEntries(url.searchParams);
  assert.equal(
    params.storedquery_id,
    'fmi::forecast::edited::weather::scandinavia::point::multipointcoverage',
  );
  assert.equal(params.latlon, '60.1699,24.9384');
  assert.equal(params.timestep, '60');
  assert.equal(params.endtime, '2026-11-02T23:00:00Z');
  assert.equal(params.parameters, FORECAST_PARAMETERS.join(','));
  // Within the same hour, the same address.
  assert.equal(
    buildForecastUrl(60.1699, 24.9384, FIXTURE_NOW),
    buildForecastUrl(60.1699, 24.9384, FIXTURE_NOW + 40 * 60000),
  );
});

test('the observation address: a box around the house, the last 70 minutes', () => {
  const params = Object.fromEntries(
    new URL(buildObservationsUrl(60.1699, 24.9384, FIXTURE_NOW)).searchParams,
  );
  assert.equal(params.storedquery_id, 'fmi::observations::weather::multipointcoverage');
  assert.equal(params.bbox, '23.9384,59.6699,25.9384,60.6699');
  assert.equal(params.starttime, '2026-10-23T22:05:00Z');
  assert.equal(params.timestep, '10');
  assert.equal(formatTime(Date.UTC(2026, 0, 1, 1, 2, 33)), '2026-01-01T01:02:00Z');
});

test('the User-Agent names the integration, its version and a contact', () => {
  assert.match(USER_AGENT, /^gladys-fmi\/\d+\.\d+\.\d+ github\.com\/guim31\/gladys-fmi$/);
});

test('a forecast and observations are fetched with the User-Agent', async () => {
  const fetchImpl = fakeFetch(() => ({ body: loadText('real-forecast-helsinki.xml') }));
  const xml = await fetchForecast({
    latitude: 60.1699,
    longitude: 24.9384,
    fetchImpl,
    now: () => FIXTURE_NOW,
  });
  assert.match(xml, /<wfs:FeatureCollection/);
  await fetchObservations({ latitude: 60.1699, longitude: 24.9384, fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  for (const call of fetchImpl.calls) {
    assert.equal(call.headers['user-agent'], USER_AGENT);
    assert.ok(call.url.startsWith(`${WFS_URL}?`));
  }
});

test('the warning feed is fetched and must be an Atom feed', async () => {
  const feed = await fetchWarnings({
    fetchImpl: fakeFetch(() => ({ body: loadText('real-warnings.xml') })),
  });
  assert.match(feed, /<feed /);
  await assert.rejects(
    fetchWarnings({ fetchImpl: fakeFetch(() => ({ body: '<html>' })) }),
    (err) => err.kind === ERROR_KINDS.INVALID,
  );
  assert.equal(WARNINGS_URL, 'https://alerts.fmi.fi/cap/feed/atom_en-GB.xml');
});

test('outside the domain, the real 400 is "no forecast", with its reason', async () => {
  await assert.rejects(
    fetchForecast({
      latitude: 48.8566,
      longitude: 2.3522,
      fetchImpl: fakeFetch(() => ({ status: 400, body: loadText('real-paris-outside.xml') })),
    }),
    (err) =>
      err.kind === ERROR_KINDS.INVALID &&
      err.message === "FMI answered HTTP 400: No data available for 'Saint-Merri'!",
  );
});

test('failures are classified', async () => {
  for (const [status, kind] of [
    [400, ERROR_KINDS.REQUEST],
    [429, ERROR_KINDS.THROTTLED],
    [403, ERROR_KINDS.FORBIDDEN],
    [502, ERROR_KINDS.UPSTREAM],
  ]) {
    await assert.rejects(
      fetchForecast({
        latitude: 60,
        longitude: 25,
        fetchImpl: fakeFetch(() => ({ status, body: '<html>nginx</html>' })),
      }),
      (err) => err.kind === kind && err.status === status,
    );
  }
  await assert.rejects(
    fetchForecast({
      latitude: 60,
      longitude: 25,
      fetchImpl: () =>
        Promise.reject(Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } })),
    }),
    (err) => err.kind === ERROR_KINDS.NETWORK && /ENOTFOUND/.test(err.message),
  );
  await assert.rejects(
    fetchObservations({ latitude: Number.NaN, longitude: 25, fetchImpl: fakeFetch(() => ({})) }),
    (err) => err.kind === ERROR_KINDS.REQUEST,
  );
});

test('Retry-After and error reasons are read safely', () => {
  assert.equal(readRetryAfter('120', 0), 120000);
  assert.equal(readRetryAfter(null, 0), null);
  assert.equal(readRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60000);
  assert.equal(readReason('<html>404</html>'), null);
  // Only the first text: the second one echoes the request.
  assert.equal(
    readReason(
      '<ExceptionText>Bad &amp; wrong</ExceptionText><ExceptionText>URI: /wfs?x</ExceptionText>',
    ),
    'Bad & wrong',
  );
});
