// node tests/geo.test.mjs — checks the browser geometry helpers against known values.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const window = {};
new Function('window', fs.readFileSync(new URL('../web/js/geo.js', import.meta.url), 'utf8'))(window);
const G = window.Geo;

// UTM against pyproj reference values (millimetre agreement expected; allow 0.05 m)
for (const [code, lon, lat, E, N] of [
  ['EPSG:32618', -77.0353, 38.8895, 323478.0634, 4306483.2418],   // Washington, DC
  ['EPSG:32733', 18.4241, -33.9249, 816557.7956, 6240887.9956],   // Cape Town (south)
  ['EPSG:32654', 139.6917, 35.6895, 381622.2300, 3950298.9079],   // Tokyo
]) {
  const [e, n] = G.utmProjector(code)(lon, lat);
  assert.ok(Math.abs(e - E) < 0.05 && Math.abs(n - N) < 0.05, `${code}: ${e} ${n}`);
}

// area of the same 0.01 x 0.009 degree box as the Python test (~0.863 km², sphere vs ellipsoid < 0.5%)
const ring = [[-77.5, 39], [-77.49, 39], [-77.49, 39.009], [-77.5, 39.009], [-77.5, 39]];
const a = G.geometryArea({ type: 'Polygon', coordinates: [ring] });
assert.ok(a > 0.855e6 && a < 0.875e6, 'area ' + a);
assert.ok(G.inGeometry(-77.495, 39.004, { type: 'Polygon', coordinates: [ring] }));
assert.ok(!G.inGeometry(-77.48, 39.004, { type: 'Polygon', coordinates: [ring] }));

assert.equal(G.classify({ telecom: 'data_center' })[0], 'operating');
assert.equal(G.classify({ 'construction:telecom': 'data_center' })[0], 'construction');
assert.equal(G.classify({ 'abandoned:building': 'data_center' })[0], 'abandoned');
assert.equal(G.classify({ 'proposed:telecom': 'data_center' })[0], 'planned');
console.log('geo.js: all tests passed');
