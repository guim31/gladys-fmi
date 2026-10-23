// -----------------------------------------------------------------------------
// The integration end to end, against the fake Gladys of the SDK
// (@gladysassistant/integration-sdk/testing): a real GladysIntegration whose
// transport is in memory, with the checks of the core on what it sends.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WARNINGS_URL } from '../src/api.js';
import { createApp } from '../src/app.js';
import { MESSAGES } from '../src/texts.js';
import {
  FIXTURE_NOW,
  HOUSES,
  asGladysHouse,
  fakeFetch,
  fmiRoute,
  forecastXml,
  loadText,
  manualClock,
  silentLogger,
  withHours,
} from './helpers/fixtures.js';

const MINUTE = 60 * 1000;

/**
 * @param {object} [options] - { houses, config, route }.
 * @returns {Promise<object>} { gladys, app, fetchImpl, now }.
 */
async function start({ houses = [HOUSES.helsinki], config = {}, route } = {}) {
  const now = manualClock(FIXTURE_NOW);
  const fetchImpl = fakeFetch(route ?? fmiRoute());
  const gladys = createFakeGladys({ houses: houses.map(asGladysHouse), config });
  const app = createApp(gladys, {
    fetchImpl,
    now,
    random: () => 0,
    timeZone: 'Europe/Helsinki',
    logger: silentLogger(),
    // No real timer: the tests must not keep the process alive.
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  await gladys.connect();
  await app.scheduler.settled();
  return { gladys, app, fetchImpl, now };
}

const forecastCalls = (fetchImpl) =>
  fetchImpl.calls.filter((call) => call.url.includes('forecast'));
const observationCalls = (fetchImpl) =>
  fetchImpl.calls.filter((call) => call.url.includes('observations'));
const warningCalls = (fetchImpl) => fetchImpl.calls.filter((call) => call.url === WARNINGS_URL);

test('at connection, the houses and the warnings are read; no device', async () => {
  const { gladys, fetchImpl } = await start({ houses: [HOUSES.helsinki, HOUSES.tampere] });
  assert.equal(forecastCalls(fetchImpl).length, 2);
  assert.equal(observationCalls(fetchImpl).length, 2);
  assert.equal(warningCalls(fetchImpl).length, 1, 'one warning feed for every house');
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  // A weather provider: no device, no state (no conformity test of devices
  // to run here).
  assert.deepEqual(gladys.fake.discoveredDevices, []);
  assert.deepEqual(gladys.fake.states, []);
});

test('a weather request is answered from memory: station, forecast, alerts', async () => {
  const { gladys, fetchImpl } = await start({ houses: [HOUSES.helsinki, HOUSES.rovaniemi] });
  const calls = fetchImpl.calls.length;
  const ack = await gladys.fake.weatherGet({
    latitude: HOUSES.helsinki.latitude,
    longitude: HOUSES.helsinki.longitude,
    language: 'en',
    units: 'metric',
  });
  assert.equal(ack.success, true, ack.error);
  const { weather } = ack.data;
  assert.equal(weather.temperature, 11.2, 'Helsinki Kaisaniemi');
  assert.equal(weather.hours.length, 24);
  assert.equal(weather.days.length, 8);
  assert.deepEqual(
    weather.alerts.map((alert) => `${alert.severity} ${alert.type}`),
    ['moderate wind'],
  );
  assert.equal(fetchImpl.calls.length, calls, 'no new call');

  const cabin = await gladys.fake.weatherGet({
    latitude: HOUSES.rovaniemi.latitude,
    longitude: HOUSES.rovaniemi.longitude,
    language: 'en',
    units: 'us',
  });
  assert.equal(cabin.success, true);
  assert.equal(cabin.data.weather.temperature, 40.5);
  assert.equal(cabin.data.weather.alerts, undefined, 'no warning in Lapland');
});

test('outside the domain of FMI, the core falls through to another provider', async () => {
  const { gladys } = await start();
  const ack = await gladys.fake.weatherGet({
    latitude: HOUSES.paris.latitude,
    longitude: HOUSES.paris.longitude,
    language: 'fr',
    units: 'metric',
  });
  assert.equal(ack.success, false);
  const noLocation = await gladys.fake.weatherGet({ language: 'en', units: 'metric' });
  assert.equal(noLocation.success, false);
});

test('only a house abroad: the status says no forecast', async () => {
  const { gladys } = await start({ houses: [HOUSES.paris] });
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: false,
    message: MESSAGES.noForecast,
  });
});

test('no located house: the status says where to set it', async () => {
  const { gladys, fetchImpl } = await start({ houses: [] });
  assert.equal(forecastCalls(fetchImpl).length, 0);
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: false,
    message: MESSAGES.noLocation,
  });
});

test('a refusal (403) shows in the status', async () => {
  const { gladys } = await start({ route: () => ({ status: 403, body: 'Forbidden' }) });
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: false,
    message: MESSAGES.forbidden,
  });
});

test('without observations, the forecast still answers', async () => {
  const base = fmiRoute();
  const { gladys } = await start({
    route: (url) => (url.includes('observations') ? { status: 503, body: '' } : base(url)),
  });
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  const ack = await gladys.fake.weatherGet({
    latitude: HOUSES.helsinki.latitude,
    longitude: HOUSES.helsinki.longitude,
    language: 'en',
    units: 'metric',
  });
  assert.equal(ack.data.weather.temperature, 11.1, 'the forecast of the hour');
});

test('the scene actions answer in the language and the units set', async () => {
  const { gladys } = await start({
    houses: [HOUSES.rovaniemi, HOUSES.tampere],
    config: { language: 'es', units: 'us' },
  });
  const nextHour = await gladys.fake.sceneAction('get_precipitation_next_hour', { house: 'cabin' });
  assert.deepEqual(nextHour.data.outputs, {
    available: true,
    precipitation_expected: false,
    summary: 'No se esperan precipitaciones en la próxima hora.',
  });
  const tomorrow = await gladys.fake.sceneAction('get_day_forecast', {
    house: 'cottage',
    day: 'tomorrow',
  });
  assert.equal(tomorrow.success, true);
  assert.match(tomorrow.data.outputs.summary, /^Mañana: .* °F/);
  const warnings = await gladys.fake.sceneAction('get_warnings', { house: 'cottage' });
  assert.equal(warnings.data.outputs.area, 'Pirkanmaa');
  assert.equal(warnings.data.outputs.level, 'yellow');
  assert.match(
    warnings.data.outputs.summary,
    /^1 aviso de FMI para Cottage: Aviso amarillo por viento/,
  );
  const unknown = await gladys.fake.sceneAction('get_day_forecast', { house: 'nowhere' });
  assert.equal(unknown.success, false);
});

test('a warning change fires the trigger and nudges the core', async () => {
  let feed = loadText('real-warnings.xml');
  const route = fmiRoute({ warnings: () => feed });
  const { gladys, app, now } = await start({ route, config: { language: 'en' } });
  assert.deepEqual(gladys.fake.sceneEvents, [], 'the first reading is a baseline');
  // FMI ends the land wind warning: its entry leaves the feed.
  feed = feed.replace(/<entry>(?:(?!<\/entry>)[\s\S])*?<value>wind<\/value>[\s\S]*?<\/entry>/, '');
  now.advance(31 * MINUTE);
  await app.scheduler.requestCycle();
  assert.equal(gladys.fake.sceneEvents.length, 1);
  const [event] = gladys.fake.sceneEvents;
  assert.equal(event.key, 'warning_changed');
  assert.equal(event.data.change, 'lifted');
  assert.equal(event.data.summary, 'Yellow wind warning lifted for Uusimaa.');
  assert.equal(gladys.fake.weatherRefreshes, 1);
});

test('the precipitation trigger fires through Gladys when rain comes into the hour', async () => {
  let wet = false;
  const route = fmiRoute({
    forecast: (house) =>
      wet
        ? withHours(forecastXml(house), {
            '2026-10-24T00:00:00Z': { symbol: 31, amount: 0.4, probability: 65 },
          })
        : forecastXml(house),
  });
  const { gladys, app, now } = await start({
    houses: [HOUSES.rovaniemi],
    route,
    config: { language: 'en' },
  });
  wet = true;
  now.advance(31 * MINUTE);
  await app.scheduler.requestCycle();
  assert.deepEqual(gladys.fake.sceneEvents, [
    {
      key: 'precipitation_expected',
      data: {
        house: 'cabin',
        house_name: 'Cabin',
        // 23:46 UTC: the rain of 00:00 starts in 14 minutes.
        summary: 'Light rain expected in 14 minutes (65% chance).',
        minutes_until: 14,
        precipitation_type: 'rain',
        intensity: 'light',
        thunder: false,
        precipitation: 0.4,
        probability: 65,
      },
    },
  ]);
});

test('the test action reports the station, the warnings, in four languages', async () => {
  const { gladys } = await start();
  const ack = await gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true, ack.error);
  const { message } = ack.data;
  assert.equal(
    message.en,
    'It works: 52.2 °F (11.2 °C) now at Home (station Helsinki Kaisaniemi), forecast of 01:44. 1 FMI warning for Home: Yellow wind warning.',
  );
  assert.equal(
    message.fr,
    'Ça fonctionne : 11,2 °C en ce moment à Home (station Helsinki Kaisaniemi), prévision de 01:44. 1 vigilance FMI pour Home : Vigilance vent jaune.',
  );
  assert.deepEqual(Object.keys(message).sort(), ['de', 'en', 'es', 'fr']);
});
