// -----------------------------------------------------------------------------
// The XML of FMI → the slim forecast and the current observation, on the real
// answers of 2026-10-23 (Helsinki, Tampere, Rovaniemi).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmiSymbol, parseForecast } from '../src/forecast.js';
import { isFresh, oktasToPercent, readObservation } from '../src/observations.js';
import { HOUR_MS } from '../src/time.js';
import { parseCoverage } from '../src/wfs.js';
import { FIXTURE_NOW, HOUSES, forecastOf, loadText, observationsXml } from './helpers/fixtures.js';

const FIRST_ROW = Date.parse('2026-10-24T00:00:00Z');

test('the real answers are read: place, analysis, about 9.5 days of hours', () => {
  for (const house of [HOUSES.helsinki, HOUSES.tampere, HOUSES.rovaniemi]) {
    const forecast = forecastOf(house);
    assert.equal(forecast.latitude, house.latitude);
    assert.equal(forecast.longitude, house.longitude);
    assert.equal(forecast.updatedAt, Date.parse('2026-10-23T22:44:45Z'));
    // 229 rows with values (the rest of the 10 days is NaN), plus the hour
    // under way.
    assert.equal(forecast.points.length, 230);
    for (let i = 1; i < forecast.points.length; i += 1) {
      assert.equal(forecast.points[i].time - forecast.points[i - 1].time, HOUR_MS);
    }
  }
  assert.equal(forecastOf(HOUSES.helsinki).place, 'Central Helsinki');
});

test('a row carries the air; the hour it ends, the symbol and the rain', () => {
  const { points } = forecastOf(HOUSES.tampere);
  const first = points.find((p) => p.time === FIRST_ROW);
  assert.equal(first.temperature, 9.81);
  assert.equal(first.humidity, 95.8);
  assert.equal(first.pressure, 1013.7);
  assert.equal(first.windSpeed, 3.7);
  assert.equal(first.windGust, 5.7);
  // The hour under way (23:00-00:00) is the one the first row ends.
  const underWay = points[0];
  assert.equal(underWay.time, FIRST_ROW - HOUR_MS);
  assert.equal(underWay.temperature, first.temperature);
  assert.deepEqual(underWay.period, {
    hours: 1,
    symbol: 'lightrain',
    precipitation: 0.303,
    probability: 99.7,
    thunderProbability: 0,
  });
  assert.equal(underWay.next1, underWay.period);
  assert.equal(points.at(-1).period, null);
});

test('outside the domain or with a foreign body, there is no forecast', () => {
  assert.throws(() => parseForecast(loadText('real-paris-outside.xml')), /not a feature/);
  assert.throws(() => parseForecast(null), /not a feature/);
  const empty = loadText('real-forecast-helsinki.xml').replace(
    /(<gml:doubleOrNilReasonTupleList>)[\s\S]*?(<\/gml:doubleOrNilReasonTupleList>)/,
    '$1$2',
  );
  assert.throws(() => parseForecast(empty), /no forecast/);
});

test('FMI symbols: intensities, night variants folded, unknown numbers dropped', () => {
  assert.equal(fmiSymbol('1.0'), 'clearsky');
  assert.equal(fmiSymbol('31.0'), 'lightrain');
  assert.equal(fmiSymbol('53'), 'heavysnow');
  assert.equal(fmiSymbol('64'), 'heavyrainandthunder');
  assert.equal(fmiSymbol('92'), 'fog');
  assert.equal(fmiSymbol('121'), 'lightrainshowers');
  assert.equal(fmiSymbol('5'), null);
  assert.equal(fmiSymbol('NaN'), null);
});

test('the coverage reader matches the rows with their station', () => {
  const { fields, places, rows } = parseCoverage(observationsXml(HOUSES.helsinki));
  assert.equal(fields[0], 't2m');
  assert.equal(places.length, 21);
  assert.ok(rows.every((row) => row.place !== null));
  assert.equal(rows[0].values.vis === null || typeof rows[0].values.vis === 'number', true);
});

test('the nearest station with a recent temperature describes now', () => {
  const helsinki = readObservation(observationsXml(HOUSES.helsinki), {
    ...HOUSES.helsinki,
    now: FIXTURE_NOW,
  });
  assert.equal(helsinki.station.name, 'Helsinki Kaisaniemi');
  assert.equal(helsinki.station.distanceKm, 0.7);
  assert.equal(helsinki.temperature, 11.2);
  assert.equal(helsinki.cloudCover, 100);
  assert.equal(isFresh(helsinki, FIXTURE_NOW), true);
  assert.equal(isFresh(helsinki, FIXTURE_NOW + 3 * HOUR_MS), false);

  // A road station: no pressure nor wind, never borrowed from another one.
  const rovaniemi = readObservation(observationsXml(HOUSES.rovaniemi), {
    ...HOUSES.rovaniemi,
    now: FIXTURE_NOW,
  });
  assert.equal(rovaniemi.station.name, 'Rovaniemi rautatieasema');
  assert.equal(rovaniemi.temperature, 4.7);
  assert.equal(rovaniemi.pressure, null);
  assert.equal(rovaniemi.windSpeed, null);

  // Far from every station (the box of Helsinki read from Rovaniemi), or
  // too old: none.
  assert.equal(
    readObservation(observationsXml(HOUSES.helsinki), { ...HOUSES.rovaniemi, now: FIXTURE_NOW }),
    null,
  );
  assert.equal(
    readObservation(observationsXml(HOUSES.helsinki), {
      ...HOUSES.helsinki,
      now: FIXTURE_NOW + 3 * HOUR_MS,
    }),
    null,
  );
});

test('cloud cover in oktas', () => {
  assert.equal(oktasToPercent(0), 0);
  assert.equal(oktasToPercent(4), 50);
  assert.equal(oktasToPercent(9), 100);
  assert.equal(oktasToPercent(null), null);
});
