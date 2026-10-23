// -----------------------------------------------------------------------------
// Read an FMI WFS `multipointcoverage` answer (forecasts and observations).
//
// Its shape, measured on the answers of 2026-10-24 (test/fixtures/):
//   - `<swe:field name="Temperature" …/>`: the parameters, in table order;
//   - `<gmlcov:positions>`: one line per row, "lat lon epoch-seconds";
//   - `<gml:doubleOrNilReasonTupleList>`: one line per row, the values in
//     field order, "NaN" for a missing one;
//   - `<target:Location>`: the places (a station: `fmisid` identifier and
//     name), each pointing to a `<gml:Point>` holding its position.
// Rows and positions go together line by line; a row belongs to the place at
// its position.
//
// Plain parsing on purpose: the format is generated and stable, and a regular
// expression per element keeps the image free of an XML dependency.
// -----------------------------------------------------------------------------

/**
 * @description Read a finite number, null otherwise ("NaN" included).
 * @param {any} value - The raw value.
 * @returns {number|null} The number.
 * @example
 * num('8.3'); // -> 8.3
 */
function num(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    return num(Number(value));
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @description The key of a position, to match rows and places.
 * @param {number} latitude - Degrees.
 * @param {number} longitude - Degrees.
 * @returns {string} The key.
 * @example
 * positionKey(60.17, 24.94); // -> '60.17000,24.94000'
 */
function positionKey(latitude, longitude) {
  return `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
}

/**
 * @description The whitespace-separated lines of an element.
 * @param {string} xml - The answer.
 * @param {string} tag - The element name, with its prefix.
 * @returns {Array<Array<string>>} The lines, split.
 * @example
 * lines(xml, 'gmlcov:positions');
 */
function lines(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (match === null) {
    return [];
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length > 0 && parts[0] !== '');
}

/**
 * @description Parse a multipointcoverage answer.
 * @param {string} xml - The answer.
 * @returns {{fields: Array<string>, places: Array<object>, rows: Array<object>}}
 * The parameters; the places `{ id, name, region, latitude, longitude }`;
 * the rows `{ latitude, longitude, time (ms), values: { name: number|null },
 * place }`, in the order of the answer.
 * @throws {Error} When the body is not a feature collection.
 * @example
 * const { rows } = parseCoverage(xml);
 */
function parseCoverage(xml) {
  if (typeof xml !== 'string' || !/<wfs:FeatureCollection\b/.test(xml)) {
    throw new Error('The FMI response is not a feature collection');
  }
  const fields = [...xml.matchAll(/<swe:field\s+name="([^"]+)"/g)].map((match) => match[1]);

  const points = new Map();
  for (const [, id, body] of xml.matchAll(
    /<gml:Point\b[^>]*gml:id="([^"]+)"[^>]*>([\s\S]*?)<\/gml:Point>/g,
  )) {
    const pos = /<gml:pos>([^<]*)<\/gml:pos>/.exec(body)?.[1].trim().split(/\s+/) ?? [];
    points.set(id, { latitude: num(pos[0]), longitude: num(pos[1]) });
  }
  const places = [];
  const placeAt = new Map();
  for (const [, body] of xml.matchAll(/<target:Location\b[^>]*>([\s\S]*?)<\/target:Location>/g)) {
    const point = points.get(/representativePoint xlink:href="#([^"]+)"/.exec(body)?.[1]);
    if (point === undefined || point.latitude === null || point.longitude === null) {
      continue;
    }
    const place = {
      id: /<gml:identifier[^>]*>([^<]*)</.exec(body)?.[1].trim() ?? null,
      name: /<gml:name[^>]*locationcode\/name">([^<]*)</.exec(body)?.[1].trim() ?? null,
      region: /<target:region[^>]*>([^<]*)</.exec(body)?.[1].trim() ?? null,
      ...point,
    };
    places.push(place);
    placeAt.set(positionKey(place.latitude, place.longitude), place);
  }

  const positions = lines(xml, 'gmlcov:positions');
  const values = lines(xml, 'gml:doubleOrNilReasonTupleList');
  const rows = [];
  for (let index = 0; index < Math.min(positions.length, values.length); index += 1) {
    const [lat, lon, epoch] = positions[index].map(num);
    if (lat === null || lon === null || epoch === null) {
      continue;
    }
    const row = { latitude: lat, longitude: lon, time: epoch * 1000, values: {} };
    fields.forEach((field, column) => {
      row.values[field] = num(values[index][column]);
    });
    row.place = placeAt.get(positionKey(lat, lon)) ?? null;
    rows.push(row);
  }
  return { fields, places, rows };
}

export { num, parseCoverage, positionKey };
