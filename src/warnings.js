// -----------------------------------------------------------------------------
// FMI weather warnings: parsing of the CAP feed, the warnings of a house, the
// pivot alerts of the core, and the changes between two readings.
//
// The feed (api.js, WARNINGS_URL) is an Atom feed of CAP 1.2 alerts, one
// entry per warning in force or announced, measured on 2026-10-24
// (real-warnings.xml) and described by FMI's CAP profile
// (https://alerts.fmi.fi/cap/profile/v1.1.0):
//   - each alert has one `<info>` per language (fi-FI, sv-FI, en-GB, in no
//     fixed order): the English one is read;
//   - the phenomenon is `<eventCode>` (wind, rain, thunderstorm, coldWeather,
//     hotWeather, forestFireWeather, trafficWeather, pedestrianSafety, uvNote,
//     sea…), never the free-text `<event>`, which may change;
//   - `<severity>` is FMI's colour: Minor green, Moderate yellow, Severe
//     orange, Extreme red. Green is a mere notice: left out;
//   - every `<area>` has a name (`Uusimaa`, an ISO 3166-2 region, or a sea
//     area) and one or more `<polygon>` of "lat,lon" pairs: the warning of a
//     house is the one whose polygon holds it. The polygons follow a simplified
//     coastline: a house up to 2 km outside still counts (islands, shores;
//     near a land border too, so a house within 2 km of a neighbouring
//     region also gets its warnings — the safe side);
//   - FMI reissues its warnings as `Update`s carrying new identifiers, each
//     `<references>` listing every earlier alert it supersedes, and a
//     `Cancel` ends one. Identifiers are therefore no identity. Like the
//     core's own alert trigger (diff by phenomenon), a house has at most one
//     warning per phenomenon: the highest level, from the earliest onset to
//     the latest end of its alerts;
//   - sea warnings (wind, waves, icing, thunderstorm at sea) concern boats,
//     not houses: left out, except the sea level (`seaWaterHeight`), which
//     floods shores.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, FmiError, fetchWarnings } from './api.js';
import { createFailureLog } from './failure-log.js';

const LEVELS = Object.freeze(['yellow', 'orange', 'red']);
const CAP_LEVELS = Object.freeze({ Moderate: 'yellow', Severe: 'orange', Extreme: 'red' });

// Level -> CAP severity of the pivot alerts (contract B.18).
const SEVERITIES = Object.freeze({ yellow: 'moderate', orange: 'severe', red: 'extreme' });

// FMI event code -> phenomenon of the scene trigger filter.
const EVENT_TYPES = Object.freeze({
  wind: 'wind',
  rain: 'rain',
  thunderstorm: 'thunderstorm',
  coldWeather: 'cold',
  hotWeather: 'heat',
  forestFireWeather: 'forest_fire',
  trafficWeather: 'traffic',
  pedestrianSafety: 'pedestrian',
  uvNote: 'uv',
  seaWaterHeight: 'sea_level',
});

// The phenomena of the scene trigger filter.
const WARNING_TYPES = Object.freeze([...new Set(Object.values(EVENT_TYPES)), 'other']);

// Phenomenon -> pivot alert type (contract B.18). The others have no
// equivalent: the alert goes without a type, drawn from its `event` text.
const PIVOT_TYPES = Object.freeze({
  wind: 'wind',
  rain: 'rain',
  thunderstorm: 'thunderstorm',
  cold: 'cold',
  heat: 'heat',
  sea_level: 'coastal',
});

const CHANGES = Object.freeze({
  ISSUED: 'issued',
  UPGRADED: 'upgraded',
  DOWNGRADED: 'downgraded',
  UPDATED: 'updated',
  LIFTED: 'lifted',
});

const EDGE_TOLERANCE_KM = 2;
const WARNINGS_MAX_AGE_MS = 30 * 60 * 1000;
const STALE_MAX_MS = 3 * 60 * 60 * 1000;
const THROTTLE_MS = 60 * 60 * 1000;
// After any other failure, readers wait this long before calling again: an
// unreachable alerts.fmi.fi must not cost 10 s to every weather request.
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

/**
 * @description Decode the XML entities of a text.
 * @param {string} text - The raw text.
 * @returns {string} The text.
 * @example
 * decode('Sun &amp; wind'); // -> 'Sun & wind'
 */
function decode(text) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const value =
        code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return entities[code.toLowerCase()] ?? match;
  });
}

/**
 * @description The text of the first element of a name, trimmed.
 * @param {string} xml - The XML.
 * @param {string} tag - The element name.
 * @returns {string|null} The text.
 * @example
 * textOf('<a>x</a>', 'a'); // -> 'x'
 */
function textOf(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match === null ? null : decode(match[1]).trim();
}

/**
 * @description An instant, or null.
 * @param {string|null} value - An ISO date.
 * @returns {number|null} The instant in ms.
 * @example
 * time('2026-10-25T08:00:00+02:00');
 */
function time(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @description Read a CAP polygon: "lat,lon lat,lon …".
 * @param {string} text - The polygon.
 * @returns {Array<[number, number]>} The vertices `[lat, lon]`.
 * @example
 * readPolygon('60,24 61,24 61,25 60,24');
 */
function readPolygon(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number))
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

/**
 * @description Parse the CAP feed into warnings: English texts, land
 * warnings, superseded and cancelled ones dropped (expired ones are dropped
 * at reading, see active()).
 * @param {string} feed - The Atom feed.
 * @returns {Array<object>} `[{ id, eventCode, type, level, rank (1-3), event,
 * headline, description, onset, expiry, areas: [{ name, polygons }] }]`.
 * @example
 * parseWarnings(feed);
 */
function parseWarnings(feed) {
  const alerts = [];
  const superseded = new Set();
  for (const [, entry] of String(feed ?? '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = textOf(entry, 'identifier');
    const references = textOf(entry, 'references') ?? '';
    for (const reference of references.split(/\s+/)) {
      const referenced = reference.split(',')[1];
      if (referenced) {
        superseded.add(referenced);
      }
    }
    if (textOf(entry, 'status') !== 'Actual' || textOf(entry, 'msgType') === 'Cancel') {
      continue;
    }
    // English first; FMI's profile promises no language, so another one
    // still gives the phenomenon, the level, the times and the areas.
    const infos = [...entry.matchAll(/<info>([\s\S]*?)<\/info>/g)].map((match) => match[1]);
    const info =
      infos.find((body) => textOf(body, 'language') === 'en-GB') ??
      infos.find((body) => textOf(body, 'language') === 'fi-FI') ??
      infos[0];
    if (info === undefined || id === null) {
      continue;
    }
    const eventCode = textOf(textOf(info, 'eventCode') ?? '', 'value') ?? '';
    const level = CAP_LEVELS[textOf(info, 'severity')];
    if (level === undefined || (eventCode.startsWith('sea') && eventCode !== 'seaWaterHeight')) {
      continue;
    }
    const areas = [...info.matchAll(/<area>([\s\S]*?)<\/area>/g)].map(([, area]) => ({
      name: textOf(area, 'areaDesc') ?? '',
      polygons: [...area.matchAll(/<polygon>([^<]*)<\/polygon>/g)]
        .map(([, polygon]) => readPolygon(polygon))
        .filter((polygon) => polygon.length >= 3),
    }));
    const event = textOf(info, 'event') ?? 'Weather warning';
    alerts.push({
      id,
      eventCode,
      type: EVENT_TYPES[eventCode] ?? 'other',
      level,
      rank: LEVELS.indexOf(level) + 1,
      event,
      headline: textOf(info, 'headline') ?? event,
      description: textOf(info, 'description') ?? '',
      onset: time(textOf(info, 'onset')),
      expiry: time(textOf(info, 'expires')),
      areas: areas.filter((area) => area.polygons.length > 0),
    });
  }
  return alerts.filter((alert) => !superseded.has(alert.id));
}

/**
 * @description The warnings not expired yet.
 * @param {Array<object>} warnings - Parsed warnings.
 * @param {number} now - The current time in ms.
 * @returns {Array<object>} The warnings.
 * @example
 * active(warnings, Date.now());
 */
function active(warnings, now) {
  return warnings.filter((warning) => warning.expiry === null || warning.expiry > now);
}

/**
 * @description Whether a point lies inside a polygon (ray casting).
 * @param {number} latitude - Degrees.
 * @param {number} longitude - Degrees.
 * @param {Array<[number, number]>} polygon - The vertices.
 * @returns {boolean} true inside.
 * @example
 * insidePolygon(60.5, 24.5, [[60, 24], [61, 24], [61, 25], [60, 25]]); // -> true
 */
function insidePolygon(latitude, longitude, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [latI, lonI] = polygon[i];
    const [latJ, lonJ] = polygon[j];
    if (
      latI > latitude !== latJ > latitude &&
      longitude < ((lonJ - lonI) * (latitude - latI)) / (latJ - latI) + lonI
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * @description The distance from a point to the edge of a polygon, on a
 * local flat projection (fine at a few kilometres).
 * @param {number} latitude - Degrees.
 * @param {number} longitude - Degrees.
 * @param {Array<[number, number]>} polygon - The vertices.
 * @returns {number} Kilometres.
 * @example
 * distanceToPolygonKm(60.5, 23.9, [[60, 24], [61, 24], [61, 25], [60, 25]]);
 */
function distanceToPolygonKm(latitude, longitude, polygon) {
  const kmPerLat = 111.2;
  const kmPerLon = 111.2 * Math.cos((latitude * Math.PI) / 180);
  const project = ([lat, lon]) => [(lon - longitude) * kmPerLon, (lat - latitude) * kmPerLat];
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [ax, ay] = project(polygon[j]);
    const [bx, by] = project(polygon[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/**
 * @description The area of a warning that covers a location, if any.
 * @param {object} warning - A parsed warning.
 * @param {number} latitude - Degrees.
 * @param {number} longitude - Degrees.
 * @returns {object|null} The area.
 * @example
 * areaAt(warning, 60.17, 24.94);
 */
function areaAt(warning, latitude, longitude) {
  const inside = warning.areas.find((area) =>
    area.polygons.some((polygon) => insidePolygon(latitude, longitude, polygon)),
  );
  if (inside !== undefined) {
    return inside;
  }
  return (
    warning.areas.find((area) =>
      area.polygons.some(
        (polygon) => distanceToPolygonKm(latitude, longitude, polygon) <= EDGE_TOLERANCE_KM,
      ),
    ) ?? null
  );
}

/**
 * @description The warnings of a location, one per phenomenon (the highest
 * level, the earliest onset, the latest end), the highest level first, then
 * the soonest.
 * @param {Array<object>|null} warnings - Active parsed warnings.
 * @param {object|null} location - `{ latitude, longitude }`.
 * @returns {Array<object>} `[{ id (the phenomenon), type, level, rank, event,
 * headline, description, onset, expiry, area }]`.
 * @example
 * warningsOf(warnings, { latitude: 60.17, longitude: 24.94 });
 */
function warningsOf(warnings, location) {
  if (!Array.isArray(warnings) || location === null || location === undefined) {
    return [];
  }
  const byType = new Map();
  for (const warning of warnings) {
    const area = areaAt(warning, location.latitude, location.longitude);
    if (area === null) {
      continue;
    }
    const id = warning.type === 'other' ? `other:${warning.eventCode}` : warning.type;
    const merged = byType.get(id);
    if (merged === undefined) {
      byType.set(id, {
        id,
        type: warning.type,
        level: warning.level,
        rank: warning.rank,
        event: warning.event,
        headline: warning.headline,
        description: warning.description,
        onset: warning.onset,
        expiry: warning.expiry,
        area: area.name,
        headlineOnset: warning.onset,
      });
      continue;
    }
    // The highest level wins; at the same level, the soonest alert, so that
    // the text does not depend on the order of the feed.
    if (
      warning.rank > merged.rank ||
      (warning.rank === merged.rank &&
        ((warning.onset ?? 0) < (merged.headlineOnset ?? 0) ||
          ((warning.onset ?? 0) === (merged.headlineOnset ?? 0) &&
            warning.headline < merged.headline)))
    ) {
      Object.assign(merged, {
        level: warning.level,
        rank: warning.rank,
        headline: warning.headline,
        description: warning.description,
        area: area.name,
        headlineOnset: warning.onset,
      });
    }
    merged.onset =
      merged.onset === null || warning.onset === null
        ? null
        : Math.min(merged.onset, warning.onset);
    merged.expiry =
      merged.expiry === null || warning.expiry === null
        ? null
        : Math.max(merged.expiry, warning.expiry);
  }
  return [...byType.values()]
    .map(({ headlineOnset: _headlineOnset, ...warning }) => warning)
    .sort((a, b) => b.rank - a.rank || (a.onset ?? 0) - (b.onset ?? 0) || a.id.localeCompare(b.id));
}

/**
 * @description The pivot alerts of the core (contract B.18) for warnings.
 * @param {Array<object>} warnings - The warnings of a house.
 * @returns {Array<object>} `[{ severity, event, description, start, end,
 * type? }]`, 10 at most.
 * @example
 * toAlerts(warningsOf(warnings, house));
 */
function toAlerts(warnings) {
  return warnings.slice(0, 10).map((warning) => {
    const alert = {
      severity: SEVERITIES[warning.level],
      event: warning.headline.replace(/:.*$/, '').slice(0, 100),
      description: [warning.headline, warning.description]
        .filter((text) => text !== '')
        .join('\n')
        .slice(0, 5000),
    };
    if (warning.onset !== null) {
      alert.start = new Date(warning.onset).toISOString();
    }
    if (warning.expiry !== null) {
      alert.end = new Date(warning.expiry).toISOString();
    }
    if (PIVOT_TYPES[warning.type] !== undefined) {
      alert.type = PIVOT_TYPES[warning.type];
    }
    return alert;
  });
}

/**
 * @description The changes between two readings of a house's warnings.
 * @param {Array<object>} previous - The warnings of the previous reading.
 * @param {Array<object>} current - The warnings now.
 * @returns {Array<{change: string, warning: object, previous?: object}>} The
 * changes: issued, upgraded, downgraded, updated (same level, new text or
 * times), lifted (gone or expired).
 * @example
 * diffWarnings(before, after);
 */
function diffWarnings(previous, current) {
  const before = new Map(previous.map((warning) => [warning.id, warning]));
  const changes = [];
  for (const warning of current) {
    const old = before.get(warning.id);
    before.delete(warning.id);
    if (old === undefined) {
      changes.push({ change: CHANGES.ISSUED, warning });
    } else if (warning.rank > old.rank) {
      changes.push({ change: CHANGES.UPGRADED, warning, previous: old });
    } else if (warning.rank < old.rank) {
      changes.push({ change: CHANGES.DOWNGRADED, warning, previous: old });
    } else if (
      // Not the identifiers nor the sending time: FMI reissues every warning
      // whenever one of them changes.
      warning.headline !== old.headline ||
      warning.onset !== old.onset ||
      warning.expiry !== old.expiry
    ) {
      changes.push({ change: CHANGES.UPDATED, warning, previous: old });
    }
  }
  for (const old of before.values()) {
    changes.push({ change: CHANGES.LIFTED, warning: old });
  }
  return changes;
}

/**
 * @description Create the warning store: the last parsed feed, read once
 * per refresh cycle at most every 30 minutes.
 * @param {object} [options] - Options.
 * @param {Function} [options.fetchImpl] - fetch, injectable for the tests.
 * @param {Function} [options.now] - `() => ms`.
 * @param {object} [options.logger] - Logger with info/warn/debug.
 * @returns {object} The store ({ refresh, load, current }).
 * @example
 * const warnings = createWarningStore();
 */
function createWarningStore({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger = console,
} = {}) {
  let entry = null; // { list, fetchedAt }
  let inflight = null;
  let blockedUntil = 0;
  let blockedKind = ERROR_KINDS.NETWORK;
  const failures = createFailureLog(logger);

  /**
   * @description Read the feed again, unless read less than 30 minutes ago.
   * @returns {Promise<object>} `{ list, fetchedAt }`, the list parsed but
   * not filtered on expiry.
   * @throws {FmiError} When the call fails or is paused.
   * @example
   * await warnings.refresh();
   */
  function refresh() {
    if (entry !== null && now() - entry.fetchedAt < WARNINGS_MAX_AGE_MS) {
      return Promise.resolve(entry);
    }
    if (inflight !== null) {
      return inflight;
    }
    if (blockedUntil > now()) {
      return Promise.reject(new FmiError(blockedKind, 'FMI warning calls paused'));
    }
    inflight = (async () => {
      try {
        const list = parseWarnings(await fetchWarnings({ fetchImpl, now }));
        entry = { list, fetchedAt: now() };
        failures.recover('warnings', 'The FMI warnings are readable again');
        return entry;
      } catch (err) {
        blockedKind = err.kind ?? ERROR_KINDS.NETWORK;
        blockedUntil =
          blockedKind === ERROR_KINDS.THROTTLED || blockedKind === ERROR_KINDS.FORBIDDEN
            ? now() + Math.max(err.retryAfterMs ?? 0, THROTTLE_MS)
            : now() + RETRY_AFTER_FAILURE_MS;
        failures.fail('warnings', `FMI warnings unavailable: ${err.message}`, {
          kind: err.kind,
        });
        throw err;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /**
   * @description The active warnings for a reader: the list in memory when
   * there is a recent one (the scheduler reads it every 30 minutes), else a
   * call, else a list up to 3 hours old, else null.
   * @returns {Promise<Array<object>|null>} The warnings, or null when unknown.
   * @example
   * await warnings.load();
   */
  async function load() {
    if (entry !== null && now() - entry.fetchedAt < WARNINGS_MAX_AGE_MS + 10 * 60 * 1000) {
      return active(entry.list, now());
    }
    try {
      return active((await refresh()).list, now());
    } catch {
      return current();
    }
  }

  /**
   * @description The active warnings of the last feed, without any call.
   * @returns {Array<object>|null} The warnings, or null when unknown or too old.
   * @example
   * warnings.current();
   */
  function current() {
    if (entry === null || now() - entry.fetchedAt > STALE_MAX_MS) {
      return null;
    }
    return active(entry.list, now());
  }

  return { refresh, load, current };
}

export {
  CHANGES,
  EDGE_TOLERANCE_KM,
  EVENT_TYPES,
  LEVELS,
  PIVOT_TYPES,
  RETRY_AFTER_FAILURE_MS,
  SEVERITIES,
  WARNINGS_MAX_AGE_MS,
  WARNING_TYPES,
  active,
  areaAt,
  createWarningStore,
  diffWarnings,
  distanceToPolygonKm,
  insidePolygon,
  parseWarnings,
  toAlerts,
  warningsOf,
};
