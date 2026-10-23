// -----------------------------------------------------------------------------
// The slim forecast → the pivot weather format of Gladys (contract B.18), on
// the real answers of 2026-10-23 (Helsinki, Tampere, Rovaniemi).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEATHER_CONDITIONS } from '@gladysassistant/integration-sdk';
import { buildDays, precipitationTimeline } from '../src/daily.js';
import { MAX_DAYS, MAX_HOURS, buildWeather } from '../src/pivot.js';
import { HOUR_MS } from '../src/time.js';
import { active, parseWarnings, toAlerts, warningsOf } from '../src/warnings.js';
import { FIXTURE_NOW, HOUSES, forecastOf, loadText, observationsXml } from './helpers/fixtures.js';
import { readObservation } from '../src/observations.js';

const TZ = 'Europe/Helsinki';

/**
 * @param {object} house - A HOUSES entry.
 * @param {object} [options] - Extra options of buildWeather.
 * @returns {object} The pivot weather.
 */
function pivotOf(house, options = {}) {
  return buildWeather(forecastOf(house), {
    latitude: house.latitude,
    longitude: house.longitude,
    units: 'metric',
    timeZone: TZ,
    now: FIXTURE_NOW,
    ...options,
  });
}

test('the current conditions of Tampere, from the hour under way', () => {
  const weather = pivotOf(HOUSES.tampere);
  assert.equal(weather.temperature, 9.8);
  assert.equal(weather.weather, WEATHER_CONDITIONS.RAIN);
  assert.equal(weather.datetime, '2026-10-23T23:00:00.000Z');
  assert.equal(weather.apparent_temperature, 6.7);
  assert.equal(weather.humidity, 96);
  assert.equal(weather.pressure, 1014, 'hPa, rounded');
  assert.equal(weather.wind_speed, 3.7);
  assert.equal(weather.wind_gust, 5.7);
  assert.equal(weather.wind_direction, 137);
  assert.equal(weather.is_day, false, 'at night');
  assert.ok(weather.sunrise < weather.sunset);
  for (const absent of ['uv_index', 'visibility', 'alerts']) {
    assert.equal(Object.hasOwn(weather, absent), false, absent);
  }
});

test('a fresh observation replaces the values it measured, and only those', () => {
  const forecast = forecastOf(HOUSES.rovaniemi);
  forecast.observation = readObservation(observationsXml(HOUSES.rovaniemi), {
    ...HOUSES.rovaniemi,
    now: FIXTURE_NOW,
  });
  const options = {
    latitude: HOUSES.rovaniemi.latitude,
    longitude: HOUSES.rovaniemi.longitude,
    units: 'metric',
    timeZone: TZ,
  };
  const weather = buildWeather(forecast, { ...options, now: FIXTURE_NOW });
  assert.equal(weather.temperature, 4.7, 'measured');
  assert.equal(weather.humidity, 86, 'measured');
  assert.equal(weather.cloud_cover, 63, 'measured');
  assert.equal(weather.pressure, 1018, 'the station has none: forecast');
  assert.equal(weather.wind_speed, 3.5, 'the station has none: forecast');
  assert.equal(weather.datetime, '2026-10-23T23:10:00.000Z');
  assert.equal(Object.hasOwn(weather, 'apparent_temperature'), false);
  // Three hours later, the observation is too old: the forecast again.
  const later = buildWeather(forecast, { ...options, now: FIXTURE_NOW + 3 * HOUR_MS });
  assert.notEqual(later.datetime, weather.datetime);
  assert.equal(typeof later.apparent_temperature, 'number');
});

test('24 hours with their precipitation and probability, 8 days', () => {
  for (const house of [HOUSES.helsinki, HOUSES.tampere, HOUSES.rovaniemi]) {
    const weather = pivotOf(house);
    assert.equal(weather.hours.length, MAX_HOURS);
    assert.equal(weather.days.length, MAX_DAYS);
    for (const hour of weather.hours) {
      assert.ok(Object.values(WEATHER_CONDITIONS).includes(hour.weather), hour.weather);
      assert.equal(typeof hour.precipitation, 'number');
      assert.ok(hour.precipitation_probability >= 0 && hour.precipitation_probability <= 100);
      assert.equal(typeof hour.is_day, 'boolean');
    }
    for (const day of weather.days) {
      assert.ok(day.temperature_min <= day.temperature_max);
      assert.ok(Object.values(WEATHER_CONDITIONS).includes(day.weather), day.weather);
      assert.equal(typeof day.precipitation, 'number');
    }
  }
});

test('US units convert every value', () => {
  const metric = pivotOf(HOUSES.helsinki);
  const us = pivotOf(HOUSES.helsinki, { units: 'us' });
  assert.ok(Math.abs(us.temperature - ((metric.temperature * 9) / 5 + 32)) <= 0.2);
  assert.ok(Math.abs(us.wind_speed - metric.wind_speed * 2.23694) < 0.1);
  assert.equal(us.pressure, metric.pressure, 'hPa in both systems');
});

test('the warnings of the house become the alerts of the answer', () => {
  const warnings = active(parseWarnings(loadText('real-warnings.xml')), FIXTURE_NOW);
  const weather = pivotOf(HOUSES.tampere, {
    alerts: toAlerts(warningsOf(warnings, HOUSES.tampere)),
  });
  assert.deepEqual(weather.alerts, [
    {
      severity: 'moderate',
      event: 'Yellow wind warning for land areas',
      description: weather.alerts[0].description,
      start: '2026-10-25T06:00:00.000Z',
      end: '2026-10-26T12:00:00.000Z',
      type: 'wind',
    },
  ]);
  assert.match(weather.alerts[0].description, /^Yellow wind warning for land areas: /);
});

test('the precipitation timeline covers the forecast without gap nor overlap', () => {
  const periods = precipitationTimeline(forecastOf(HOUSES.tampere).points);
  for (let i = 1; i < periods.length; i += 1) {
    assert.equal(periods[i].start, periods[i - 1].end);
  }
  assert.deepEqual([...new Set(periods.map((period) => period.hours))], [1]);
});

test('the symbol of a day is the one of its noon period, whatever the step', () => {
  const forecast = forecastOf(HOUSES.tampere);
  const days = buildDays(forecast, {
    latitude: HOUSES.tampere.latitude,
    longitude: HOUSES.tampere.longitude,
    timeZone: TZ,
  });
  // Days of 24 hours (Finland leaves summer time on 25 October 2026).
  for (const day of days.filter((candidate) => candidate.end - candidate.start === 24 * HOUR_MS)) {
    const noon = day.start + 12 * HOUR_MS;
    const period = precipitationTimeline(forecast.points).find(
      (candidate) => candidate.start <= noon && noon < candidate.end,
    );
    if (period !== undefined) {
      assert.equal(day.symbol, period.symbol, new Date(day.start).toISOString());
    }
  }
});

test('days sum the periods, pick the noon symbol, and drop a last day barely entered', () => {
  const forecast = forecastOf(HOUSES.helsinki);
  const days = buildDays(forecast, {
    latitude: HOUSES.helsinki.latitude,
    longitude: HOUSES.helsinki.longitude,
    timeZone: TZ,
  });
  const total = precipitationTimeline(forecast.points).reduce(
    (sum, period) => sum + (period.precipitation ?? 0),
    0,
  );
  const counted = days.reduce((sum, day) => sum + (day.precipitation ?? 0), 0);
  // Only the periods of a dropped last day are missing.
  assert.ok(counted <= total + 1e-9);
  assert.ok(days.at(-1).end <= forecast.points.at(-1).time + 6 * HOUR_MS);
  for (const day of days) {
    assert.ok(day.symbol !== null, 'every day has a symbol');
  }
});
