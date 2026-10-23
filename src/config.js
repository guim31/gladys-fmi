// -----------------------------------------------------------------------------
// Configuration of the integration.
//
// DEFAULT_CONFIG mirrors the `default` values of the manifest `config_schema`
// (test/manifest.test.js keeps both sides in sync). The supervisor sends the
// values as the form stored them: normalizeConfig() validates them and falls
// back to the defaults, so the rest of the code never sees a malformed value.
//
// There is no refresh setting: one forecast, one observation and one
// warning feed every 30 minutes at most (scheduler.js).
// -----------------------------------------------------------------------------

// Language of the texts the integration writes itself (scene variables and
// outputs), French by default (the maintainer's choice). 'auto' follows the
// language of the last weather request of the core. The others are the
// languages of the Gladys interface.
const LANGUAGE_CHOICES = ['auto', 'en', 'fr', 'de', 'es'];

// Units of the scene variables and outputs. 'auto' follows the unit system of
// the last weather request of the core (the preference of the user who
// looked at the weather last).
const UNITS_CHOICES = ['auto', 'metric', 'us'];

const DEFAULT_CONFIG = Object.freeze({
  language: 'fr',
  units: 'auto',
});

/**
 * @description Normalize the raw configuration sent by Gladys.
 * @param {object} [raw] - The configuration values, as stored by the form.
 * @returns {{language: string, units: string}} The
 * normalized configuration.
 * @example
 * normalizeConfig({ language: 'fr' });
 */
function normalizeConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const pick = (key, choices) => {
    const value = String(source[key] ?? DEFAULT_CONFIG[key]).trim();
    return choices.includes(value) ? value : DEFAULT_CONFIG[key];
  };
  return {
    language: pick('language', LANGUAGE_CHOICES),
    units: pick('units', UNITS_CHOICES),
  };
}

export { DEFAULT_CONFIG, LANGUAGE_CHOICES, UNITS_CHOICES, normalizeConfig };
