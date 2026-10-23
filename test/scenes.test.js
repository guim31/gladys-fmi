// -----------------------------------------------------------------------------
// Scene actions and triggers, on the real answers of 2026-10-23: the next
// hour, the day, the warnings of a house, and the two triggers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForecast } from '../src/forecast.js';
import { readNextHour } from '../src/next-hour.js';
import { currentWarnings, dayForecast, precipitationNextHour } from '../src/scene-actions.js';
import { createPrecipitationWatcher } from '../src/scene-triggers.js';
import { createWarningWatcher } from '../src/warning-triggers.js';
import { active, parseWarnings } from '../src/warnings.js';
import {
  FIXTURE_NOW,
  HOUSES,
  forecastOf,
  forecastXml,
  loadText,
  silentLogger,
  withHours,
} from './helpers/fixtures.js';

const TZ = 'Europe/Helsinki';
const MINUTE = 60 * 1000;
const realWarnings = () => active(parseWarnings(loadText('real-warnings.xml')), FIXTURE_NOW);

test('a dry next hour, read from the hour under way and the next one', () => {
  const reading = readNextHour(forecastOf(HOUSES.rovaniemi), FIXTURE_NOW);
  assert.equal(reading.available, true);
  assert.equal(reading.minutesUntil, null);
  const outputs = precipitationNextHour(forecastOf(HOUSES.rovaniemi), {
    language: 'fr',
    units: 'metric',
    now: FIXTURE_NOW,
  });
  assert.deepEqual(outputs, {
    available: true,
    precipitation_expected: false,
    summary: 'Pas de précipitations prévues dans l’heure.',
  });
});

test('the light rain of Tampere is there now (real answer)', () => {
  const outputs = precipitationNextHour(forecastOf(HOUSES.tampere), {
    language: 'en',
    units: 'metric',
    now: FIXTURE_NOW,
  });
  assert.equal(outputs.precipitation_expected, true);
  assert.equal(outputs.minutes_until, 0);
  assert.equal(outputs.precipitation_type, 'rain');
  assert.equal(outputs.intensity, 'light');
  assert.equal(outputs.precipitation, 0.3);
  assert.equal(outputs.probability, 100);
});

test('rain at 00:00 UTC is announced 45 minutes ahead, with its probability', () => {
  const forecast = parseForecast(
    withHours(forecastXml(HOUSES.rovaniemi), {
      '2026-10-24T00:00:00Z': { symbol: 31, amount: 1.2, probability: 80 },
    }),
  );
  const outputs = precipitationNextHour(forecast, {
    language: 'en',
    units: 'metric',
    now: FIXTURE_NOW,
  });
  assert.equal(outputs.precipitation_expected, true);
  assert.equal(outputs.minutes_until, 45);
  assert.equal(outputs.precipitation_type, 'rain');
  assert.equal(outputs.precipitation, 1.2);
  assert.equal(outputs.probability, 80);
  assert.equal(outputs.summary, 'Light rain expected in 45 minutes (80% chance).');
});

test('the forecast of tomorrow, in German', () => {
  const outputs = dayForecast(forecastOf(HOUSES.helsinki), {
    house: HOUSES.helsinki,
    day: 'tomorrow',
    language: 'de',
    units: 'metric',
    timeZone: TZ,
    now: FIXTURE_NOW,
  });
  assert.equal(outputs.available, true);
  assert.ok(outputs.temperature_min <= outputs.temperature_max);
  assert.equal(typeof outputs.precipitation_probability, 'number');
  assert.equal(typeof outputs.wind_gust, 'number');
  assert.match(outputs.summary, /^Morgen: /);
});

test('the warnings of Helsinki: yellow wind, not yet in effect', () => {
  const outputs = currentWarnings(realWarnings(), {
    house: HOUSES.helsinki,
    language: 'en',
    timeZone: TZ,
    now: FIXTURE_NOW,
  });
  assert.equal(outputs.available, true);
  assert.equal(outputs.area, 'Uusimaa');
  assert.equal(outputs.has_warning, true);
  assert.equal(outputs.warning_count, 1);
  assert.equal(outputs.level, 'yellow');
  assert.equal(outputs.in_effect, false);
  assert.equal(outputs.warning_type, 'wind');
  assert.match(outputs.headline, /^Yellow wind warning for land areas: /);
  assert.equal(
    outputs.summary,
    '1 FMI warning for Home: Yellow wind warning, from Sun, Oct 25, 08:00 to Mon, Oct 26, 14:00.',
  );
  const later = currentWarnings(realWarnings(), {
    house: HOUSES.helsinki,
    language: 'fr',
    timeZone: TZ,
    now: Date.parse('2026-10-25T09:00:00+02:00'),
  });
  assert.equal(later.in_effect, true);
});

test('no warning in Lapland; an unknown list says so', () => {
  const cabin = currentWarnings(realWarnings(), {
    house: HOUSES.rovaniemi,
    language: 'es',
    timeZone: TZ,
    now: FIXTURE_NOW,
  });
  assert.equal(cabin.has_warning, false);
  assert.equal(cabin.level, 'none');
  assert.equal(Object.hasOwn(cabin, 'area'), false);
  assert.equal(cabin.summary, 'Ningún aviso de FMI para Cabin.');
  const unknown = currentWarnings(null, { house: HOUSES.helsinki, language: 'en', timeZone: TZ });
  assert.equal(unknown.available, false);
  assert.equal(unknown.summary, 'The FMI warnings are unavailable for now.');
});

test('the precipitation trigger fires on the dry → wet transition only', async () => {
  const events = [];
  let now = FIXTURE_NOW;
  const watcher = createPrecipitationWatcher({
    publish: async (key, data) => events.push({ key, data }),
    getLanguage: () => 'fr',
    getUnits: () => 'metric',
    logger: silentLogger(),
    now: () => now,
  });
  const house = HOUSES.rovaniemi;
  const dry = forecastOf(house);
  const wet = parseForecast(
    withHours(forecastXml(house), {
      '2026-10-24T00:00:00Z': { symbol: 52, amount: 3, probability: 70 },
    }),
  );
  assert.equal(await watcher.observe(house, dry), null, 'baseline');
  now += 30 * MINUTE;
  const data = await watcher.observe(house, wet);
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'precipitation_expected');
  assert.equal(data.house, 'cabin');
  assert.equal(data.precipitation_type, 'snow');
  assert.equal(data.minutes_until, 15);
  assert.equal(await watcher.observe(house, wet), null, 'still wet: no new event');
});

test('the warning trigger: baseline, then each change, in the language set', async () => {
  const events = [];
  const watcher = createWarningWatcher({
    publish: async (key, data) => events.push({ key, data }),
    getLanguage: () => 'fr',
    timeZone: TZ,
    logger: silentLogger(),
    now: () => FIXTURE_NOW,
  });
  const house = HOUSES.helsinki;
  const warnings = realWarnings();
  assert.deepEqual(await watcher.observe(house, warnings), [], 'baseline');
  assert.deepEqual(await watcher.observe(house, null), [], 'unknown list: no reading');

  // The wind warning is raised to orange, a rain warning is issued.
  const [wind] = warnings;
  const orange = { ...wind, level: 'orange', rank: 2 };
  const rain = { ...wind, id: 'rain-1', eventCode: 'rain', type: 'rain' };
  const published = await watcher.observe(house, [orange, rain]);
  assert.deepEqual(
    published.map((data) => [data.change, data.level, data.warning_type]),
    [
      ['upgraded', 'orange', 'wind'],
      ['issued', 'yellow', 'rain'],
    ],
  );
  assert.equal(events[0].key, 'warning_changed');
  assert.deepEqual(Object.keys(events[0].data).sort(), [
    'area',
    'change',
    'description',
    'headline',
    'house',
    'house_name',
    'level',
    'summary',
    'warning_type',
  ]);
  assert.equal(events[0].data.house, 'home');
  assert.equal(events[0].data.area, 'Uusimaa');
  assert.equal(
    events[0].data.summary,
    'Vigilance vent orange relevée pour Uusimaa, du dim. 25 oct., 08:00 au lun. 26 oct., 14:00.',
  );

  // The wind warning ends.
  const lifted = await watcher.observe(house, [rain]);
  assert.deepEqual(
    lifted.map((data) => data.change),
    ['lifted'],
  );
  assert.equal(lifted[0].summary, 'Vigilance vent orange levée pour Uusimaa.');
});
