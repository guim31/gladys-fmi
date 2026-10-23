// -----------------------------------------------------------------------------
// MET Norway symbols (FMI symbols become them) → Gladys conditions: every code of the official legend
// (test/fixtures/weathericons-legend.csv, from metno/weathericons) is mapped,
// to a condition Gladys renders, with its day/night variant.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEATHER_CONDITIONS as C } from '@gladysassistant/integration-sdk';
import {
  SYMBOLS,
  allSymbolCodes,
  describeSymbol,
  isDayFromSymbol,
  skyCondition,
  toCondition,
} from '../src/symbols.js';
import { FMI_SYMBOLS, fmiSymbol } from '../src/forecast.js';
import { HOUSES, forecastOf } from './helpers/fixtures.js';

const legend = readFileSync(new URL('./fixtures/weathericons-legend.csv', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const columns = line.split(',');
    // The legend itself has a trailing space after one id.
    return {
      id: columns[0].trim(),
      oldId: Number(columns.at(-2)),
      variants: columns.at(-1).trim() === '1',
    };
  });

test('the table holds exactly the 41 symbols of the official legend', () => {
  assert.equal(legend.length, 41);
  assert.deepEqual(
    SYMBOLS.map(({ id, variants }) => ({ id, variants })),
    legend.map(({ id, variants }) => ({ id, variants })),
  );
});

test('the 83 codes the API can send all map to a condition Gladys renders', () => {
  const codes = allSymbolCodes();
  assert.equal(codes.length, 83);
  const rendered = Object.values(C).filter((value) => value !== C.UNKNOWN && value !== C.NIGHT);
  for (const code of codes) {
    const condition = toCondition(code, { temperature: 10 });
    assert.ok(rendered.includes(condition), `${code} -> ${condition}`);
    assert.equal(describeSymbol(code).known, true, code);
  }
});

test('the mapping, symbol by symbol', () => {
  const expected = {
    clearsky_day: C.CLEAR,
    fair_night: C.PARTLY_CLOUDY,
    partlycloudy_polartwilight: C.PARTLY_CLOUDY,
    cloudy: C.CLOUD,
    fog: C.FOG,
    lightrain: C.RAIN,
    rain: C.RAIN,
    heavyrain: C.POURING,
    lightrainshowers_day: C.RAIN,
    rainshowers_night: C.RAIN,
    heavyrainshowers_day: C.POURING,
    lightrainandthunder: C.THUNDERSTORM,
    heavyrainshowersandthunder_night: C.THUNDERSTORM,
    lightsleet: C.SLEET,
    heavysleetshowers_day: C.SLEET,
    sleetandthunder: C.THUNDERSTORM,
    lightssleetshowersandthunder_day: C.THUNDERSTORM,
    lightsnow: C.SNOW,
    snowshowers_polartwilight: C.SNOW,
    heavysnow: C.SNOW,
    lightssnowshowersandthunder_night: C.SNOW_THUNDERSTORM,
    heavysnowandthunder: C.SNOW_THUNDERSTORM,
  };
  for (const [code, condition] of Object.entries(expected)) {
    assert.equal(toCondition(code, { temperature: 5 }), condition, code);
  }
});

test('the two misspelled codes of the legend are understood, and so is their fix', () => {
  for (const code of [
    'lightssleetshowersandthunder_day',
    'lightsleetshowersandthunder_day',
    'lightssnowshowersandthunder_night',
    'lightsnowshowersandthunder_night',
  ]) {
    const symbol = describeSymbol(code);
    assert.equal(symbol.intensity, 'light', code);
    assert.equal(symbol.thunder, true, code);
    assert.equal(symbol.showers, true, code);
  }
  assert.equal(toCondition('lightsnowshowersandthunder_day'), C.SNOW_THUNDERSTORM);
});

test('fog freezes at or below 0 °C', () => {
  assert.equal(toCondition('fog', { temperature: 0.4 }), C.FOG);
  assert.equal(toCondition('fog', { temperature: 0 }), C.FREEZING_FOG);
  assert.equal(toCondition('fog', { temperature: -6 }), C.FREEZING_FOG);
  assert.equal(toCondition('fog'), C.FOG);
});

test('the variant is the day/night signal; polar twilight is night', () => {
  assert.equal(isDayFromSymbol('clearsky_day'), true);
  assert.equal(isDayFromSymbol('clearsky_night'), false);
  assert.equal(isDayFromSymbol('fair_polartwilight'), false);
  assert.equal(isDayFromSymbol('cloudy'), null);
  assert.equal(isDayFromSymbol(null), null);
});

test('an unknown or missing symbol falls back to the cloud cover', () => {
  assert.equal(toCondition('meteorshower_day', { cloudCover: 95 }), C.CLOUD);
  assert.equal(toCondition(null, { cloudCover: 50 }), C.PARTLY_CLOUDY);
  assert.equal(toCondition('', { cloudCover: 10 }), C.CLEAR);
  assert.equal(toCondition(42), C.UNKNOWN);
  assert.equal(skyCondition(null), C.UNKNOWN);
  assert.equal(describeSymbol('meteorshower_day').known, false);
});

test('a symbol MET adds on the same pattern is still read', () => {
  // Not in the legend, but built like the others.
  assert.equal(toCondition('heavyrainandthunder_day'), C.THUNDERSTORM);
  assert.equal(describeSymbol('heavysleetshowers_day').kind, 'sleet');
});

test('every FMI WeatherSymbol3 number is a symbol of the legend', () => {
  const ids = new Set(legend.map(({ id }) => id));
  for (const [number, code] of Object.entries(FMI_SYMBOLS)) {
    assert.ok(ids.has(code), `${number}: ${code}`);
    assert.equal(describeSymbol(code).known, true, code);
  }
});

test('FMI symbols become the conditions of Gladys', () => {
  const cases = {
    1: C.CLEAR,
    2: C.PARTLY_CLOUDY,
    3: C.CLOUD,
    21: C.RAIN,
    33: C.POURING,
    42: C.SNOW,
    61: C.THUNDERSTORM,
    72: C.SLEET,
    92: C.FOG,
  };
  for (const [number, condition] of Object.entries(cases)) {
    assert.equal(toCondition(fmiSymbol(number)), condition, number);
  }
});

test('every symbol of the real responses is a known FMI number', () => {
  for (const house of [HOUSES.helsinki, HOUSES.tampere, HOUSES.rovaniemi]) {
    for (const point of forecastOf(house).points) {
      if (point.period !== null) {
        assert.ok(point.period.symbol, `${house.fixture}: ${point.time}`);
      }
    }
  }
});
