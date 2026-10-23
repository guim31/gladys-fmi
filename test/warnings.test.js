// -----------------------------------------------------------------------------
// FMI warnings: the real CAP feed of 2026-10-23 (a yellow wind warning on
// land, sea warnings), the warnings of a house, the pivot alerts and the
// changes between readings.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEATHER_ALERT_SEVERITIES, WEATHER_ALERT_TYPES } from '@gladysassistant/integration-sdk';
import {
  EVENT_TYPES,
  PIVOT_TYPES,
  RETRY_AFTER_FAILURE_MS,
  WARNINGS_MAX_AGE_MS,
  WARNING_TYPES,
  active,
  createWarningStore,
  diffWarnings,
  distanceToPolygonKm,
  insidePolygon,
  parseWarnings,
  toAlerts,
  warningsOf,
} from '../src/warnings.js';
import {
  FIXTURE_NOW,
  HOUSES,
  fakeFetch,
  loadText,
  manualClock,
  silentLogger,
} from './helpers/fixtures.js';

const real = () => active(parseWarnings(loadText('real-warnings.xml')), FIXTURE_NOW);

// A square around Helsinki (60-60.5 N, 24.5-25.5 E).
const SQUARE = '60,24.5 60.5,24.5 60.5,25.5 60,25.5 60,24.5';

/**
 * @description A minimal CAP entry as FMI writes them.
 * @param {object} options - The values.
 * @returns {string} The Atom entry.
 */
function entry({
  id,
  code = 'wind',
  severity = 'Moderate',
  msgType = 'Alert',
  references = '',
  onset = '2026-10-24T08:00:00+03:00',
  expires = '2026-10-24T20:00:00+03:00',
  polygon = SQUARE,
  headline = 'Yellow wind warning for land areas: Uusimaa',
}) {
  const info = (language) => `<info><language>${language}</language>
    <event>Event</event><severity>${severity}</severity>
    <eventCode><valueName>profile</valueName><value>${code}</value></eventCode>
    <onset>${onset}</onset><expires>${expires}</expires>
    <headline>${language === 'en-GB' ? headline : 'Muu'}</headline>
    <description>Strong wind &amp; gusts.</description>
    <area><areaDesc>Uusimaa</areaDesc><polygon>${polygon}</polygon></area></info>`;
  return `<entry><content type="text/xml"><alert><identifier>${id}</identifier>
    <status>Actual</status><msgType>${msgType}</msgType>
    ${references ? `<references>${references}</references>` : ''}
    ${info('fi-FI')}${info('en-GB')}</alert></content></entry>`;
}
const feed = (...entries) => `<feed>${entries.join('')}</feed>`;
const HOME = { latitude: 60.17, longitude: 24.94 };

test('the real feed: the land wind warning, the sea warnings left out', () => {
  const warnings = real();
  assert.equal(warnings.length, 1);
  const [wind] = warnings;
  assert.equal(wind.eventCode, 'wind');
  assert.equal(wind.type, 'wind');
  assert.equal(wind.level, 'yellow');
  assert.equal(wind.rank, 1);
  assert.equal(wind.event, 'Wind warning for land areas');
  assert.match(wind.headline, /^Yellow wind warning for land areas: Kymenlaakso/);
  assert.equal(wind.onset, Date.parse('2026-10-25T08:00:00+02:00'));
  assert.equal(wind.expiry, Date.parse('2026-10-26T14:00:00+02:00'));
  assert.equal(wind.areas.length, 11);
  assert.ok(wind.areas.some((area) => area.name === 'Uusimaa'));
});

test('the warnings of a house: inside the polygon of an area, or close to its edge', () => {
  const helsinki = warningsOf(real(), HOUSES.helsinki);
  assert.deepEqual(
    helsinki.map((warning) => [warning.id, warning.level, warning.area]),
    [['wind', 'yellow', 'Uusimaa']],
  );
  assert.equal(warningsOf(real(), HOUSES.tampere)[0].area, 'Pirkanmaa');
  assert.deepEqual(warningsOf(real(), HOUSES.rovaniemi), [], 'nothing in Lapland');
  // Suomenlinna, an island off Helsinki.
  assert.equal(warningsOf(real(), { latitude: 60.1454, longitude: 24.9881 }).length, 1);
  assert.deepEqual(warningsOf(real(), null), []);
  assert.deepEqual(warningsOf(null, HOME), []);
});

test('point in polygon and distance to its edge', () => {
  const square = [
    [60, 24],
    [61, 24],
    [61, 25],
    [60, 25],
  ];
  assert.equal(insidePolygon(60.5, 24.5, square), true);
  assert.equal(insidePolygon(60.5, 25.5, square), false);
  const km = distanceToPolygonKm(60.5, 25.02, square);
  assert.ok(km > 1 && km < 1.2, String(km));
});

test('superseded, cancelled, green, sea and test alerts are dropped', () => {
  const warnings = parseWarnings(
    feed(
      entry({ id: 'old' }),
      entry({ id: 'new', msgType: 'Update', references: 'sender,old,2026-10-23T10:00:00+03:00' }),
      entry({ id: 'gone', code: 'rain', msgType: 'Cancel' }),
      entry({ id: 'green', code: 'uvNote', severity: 'Minor' }),
      entry({ id: 'sea', code: 'seaWind' }),
      entry({ id: 'level', code: 'seaWaterHeight', severity: 'Severe' }),
    ),
  );
  assert.deepEqual(
    warnings.map((warning) => [warning.id, warning.type, warning.level]),
    [
      ['new', 'wind', 'yellow'],
      ['level', 'sea_level', 'orange'],
    ],
  );
  assert.deepEqual(parseWarnings('nope'), []);
  assert.deepEqual(parseWarnings(null), []);
});

test('expired warnings are dropped at reading', () => {
  const warnings = parseWarnings(feed(entry({ id: 'a' })));
  assert.equal(active(warnings, Date.parse('2026-10-24T19:00:00+03:00')).length, 1);
  assert.equal(active(warnings, Date.parse('2026-10-24T20:00:00+03:00')).length, 0);
});

test('one warning per phenomenon: the highest level, the whole span', () => {
  const warnings = parseWarnings(
    feed(
      entry({ id: 'a', onset: '2026-10-24T08:00:00+03:00', expires: '2026-10-24T12:00:00+03:00' }),
      entry({
        id: 'b',
        severity: 'Severe',
        headline: 'Orange wind warning for land areas: Uusimaa',
        onset: '2026-10-24T10:00:00+03:00',
        expires: '2026-10-24T20:00:00+03:00',
      }),
      entry({ id: 'c', code: 'trafficWeather' }),
    ),
  );
  const mine = warningsOf(warnings, HOME);
  assert.deepEqual(
    mine.map((warning) => [warning.id, warning.level]),
    [
      ['wind', 'orange'],
      ['traffic', 'yellow'],
    ],
  );
  assert.equal(mine[0].headline, 'Orange wind warning for land areas: Uusimaa');
  assert.equal(mine[0].onset, Date.parse('2026-10-24T08:00:00+03:00'));
  assert.equal(mine[0].expiry, Date.parse('2026-10-24T20:00:00+03:00'));
  assert.equal(mine[0].description, 'Strong wind & gusts.');
});

test('pivot alerts: CAP severity, the type of the core when there is one', () => {
  const alerts = toAlerts(warningsOf(real(), HOUSES.helsinki));
  assert.deepEqual(
    alerts.map((alert) => [alert.severity, alert.type, alert.event]),
    [
      [
        WEATHER_ALERT_SEVERITIES.MODERATE,
        WEATHER_ALERT_TYPES.WIND,
        'Yellow wind warning for land areas',
      ],
    ],
  );
  assert.equal(alerts[0].start, '2026-10-25T06:00:00.000Z');
  assert.equal(alerts[0].end, '2026-10-26T12:00:00.000Z');
  for (const type of Object.values(PIVOT_TYPES)) {
    assert.ok(Object.values(WEATHER_ALERT_TYPES).includes(type), type);
  }
  const [fire] = toAlerts(
    warningsOf(parseWarnings(feed(entry({ id: 'f', code: 'forestFireWeather' }))), HOME),
  );
  assert.equal(fire.type, undefined, 'forest fire has no type in the core');
});

test('every FMI event code has a phenomenon of the trigger filter', () => {
  for (const type of Object.values(EVENT_TYPES)) {
    assert.ok(WARNING_TYPES.includes(type), type);
  }
  assert.ok(WARNING_TYPES.includes('other'));
});

test('a reissue with new identifiers is no change', () => {
  const before = warningsOf(parseWarnings(feed(entry({ id: 'a' }))), HOME);
  const after = warningsOf(
    parseWarnings(feed(entry({ id: 'b', msgType: 'Update', references: 's,a,t' }))),
    HOME,
  );
  assert.deepEqual(diffWarnings(before, after), []);
});

test('changes: issued, upgraded, downgraded, updated, lifted', () => {
  const wind = warningsOf(parseWarnings(feed(entry({ id: 'a' }))), HOME)[0];
  const rain = { ...wind, id: 'rain', type: 'rain' };
  const changes = diffWarnings(
    [wind, rain],
    [
      { ...wind, level: 'red', rank: 3 },
      { ...wind, id: 'uv', type: 'uv' },
    ],
  ).map(({ change, warning }) => [change, warning.id]);
  assert.deepEqual(changes, [
    ['upgraded', 'wind'],
    ['issued', 'uv'],
    ['lifted', 'rain'],
  ]);
  assert.deepEqual(
    diffWarnings([wind], [{ ...wind, expiry: wind.expiry + 3600000 }]).map((c) => c.change),
    ['updated'],
  );
  assert.deepEqual(
    diffWarnings([{ ...wind, level: 'orange', rank: 2 }], [wind]).map((c) => c.change),
    ['downgraded'],
  );
});

test('the warning feed is read once per 30 minutes, a failure keeps the last one', async () => {
  const now = manualClock(FIXTURE_NOW);
  let fail = false;
  const fetchImpl = fakeFetch(() =>
    fail ? { status: 503, body: '' } : { body: loadText('real-warnings.xml') },
  );
  const store = createWarningStore({ fetchImpl, now, logger: silentLogger() });
  assert.equal(store.current(), null);
  assert.equal((await store.load()).length, 1);
  assert.equal((await store.load()).length, 1);
  assert.equal(fetchImpl.calls.length, 1);
  now.advance(WARNINGS_MAX_AGE_MS);
  fail = true;
  await assert.rejects(store.refresh());
  assert.equal((await store.load()).length, 1, 'the last feed, still recent');
  now.advance(3 * 60 * 60 * 1000);
  assert.equal(await store.load(), null, 'too old: unknown');
});

test('a 429 pauses the warning calls for an hour', async () => {
  const now = manualClock(FIXTURE_NOW);
  const fetchImpl = fakeFetch(() => ({ status: 429, body: '' }));
  const store = createWarningStore({ fetchImpl, now, logger: silentLogger() });
  await assert.rejects(store.refresh());
  now.advance(30 * 60 * 1000);
  await assert.rejects(store.refresh(), /paused/);
  assert.equal(fetchImpl.calls.length, 1);
  now.advance(31 * 60 * 1000);
  await assert.rejects(store.refresh());
  assert.equal(fetchImpl.calls.length, 2);
});

test('after a failure, readers do not call again for 5 minutes', async () => {
  const now = manualClock(FIXTURE_NOW);
  const fetchImpl = fakeFetch(() => ({ status: 503, body: '' }));
  const store = createWarningStore({ fetchImpl, now, logger: silentLogger() });
  assert.equal(await store.load(), null);
  assert.equal(await store.load(), null);
  assert.equal(fetchImpl.calls.length, 1, 'a dashboard open does not wait 10 s again');
  now.advance(RETRY_AFTER_FAILURE_MS);
  await store.load();
  assert.equal(fetchImpl.calls.length, 2);
});

test('two warnings of one phenomenon at one level: the order of the feed changes nothing', () => {
  const sunday = entry({
    id: 'a',
    headline: 'Yellow wind warning for land areas: Uusimaa, Sun 8.00 - 14.00',
    onset: '2026-10-25T08:00:00+02:00',
    expires: '2026-10-25T14:00:00+02:00',
  });
  const tuesday = entry({
    id: 'b',
    headline: 'Yellow wind warning for land areas: Uusimaa, Tue 8.00 - 14.00',
    onset: '2026-10-27T08:00:00+02:00',
    expires: '2026-10-27T14:00:00+02:00',
  });
  const one = warningsOf(parseWarnings(feed(sunday, tuesday)), HOME);
  const other = warningsOf(parseWarnings(feed(tuesday, sunday)), HOME);
  assert.deepEqual(diffWarnings(one, other), []);
  assert.match(one[0].headline, /Sun 8\.00/);
  assert.equal(Object.hasOwn(one[0], 'headlineOnset'), false);
});

test('an alert without English text is still read, from another language', () => {
  const finnish = entry({ id: 'fi' }).replace(/<info><language>en-GB[\s\S]*?<\/info>/, '');
  const [warning] = parseWarnings(feed(finnish));
  assert.equal(warning.type, 'wind');
  assert.equal(warning.headline, 'Muu');
});
