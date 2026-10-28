/* Geometry helpers: spherical area, point-in-polygon, UTM projection, OSM status rules. */
(function (global) {
  'use strict';
  const R = 6371008.8;
  const rad = d => d * Math.PI / 180;

  function ringArea(ring) {
    let total = 0;
    const n = ring.length;
    if (n < 3) return 0;
    for (let i = 0; i < n; i++) {
      const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n];
      total += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
    }
    return Math.abs(total * R * R / 2);
  }

  function geometryArea(g) {
    if (!g) return 0;
    if (g.type === 'Polygon') return polyArea(g.coordinates);
    if (g.type === 'MultiPolygon') return g.coordinates.reduce((s, p) => s + polyArea(p), 0);
    return 0;
  }
  function polyArea(rings) {
    if (!rings.length) return 0;
    let a = ringArea(rings[0]);
    for (let i = 1; i < rings.length; i++) a -= ringArea(rings[i]);
    return Math.max(a, 0);
  }

  /** Area of a lon/lat rectangle on the sphere, m². */
  function bboxArea(w, s, e, n) {
    return R * R * Math.abs(rad(e) - rad(w)) * Math.abs(Math.sin(rad(n)) - Math.sin(rad(s)));
  }

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inPolygon(x, y, rings) {
    if (!inRing(x, y, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) if (inRing(x, y, rings[i])) return false;
    return true;
  }
  function inGeometry(x, y, g) {
    if (g.type === 'Polygon') return inPolygon(x, y, g.coordinates);
    if (g.type === 'MultiPolygon') return g.coordinates.some(p => inPolygon(x, y, p));
    return false;
  }

  function geomBounds(g) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const walk = c => {
      if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
      else c.forEach(walk);
    };
    walk(g.coordinates);
    return [w, s, e, n];
  }

  /** WGS84 -> UTM (Snyder, USGS PP 1395). Returns [easting, northing]. */
  function utmForward(lon, lat, zone, south) {
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
    const e2 = f * (2 - f), e4 = e2 * e2, e6 = e4 * e2, ep2 = e2 / (1 - e2);
    const phi = rad(lat), lam = rad(lon), lam0 = rad((zone - 1) * 6 - 180 + 3);
    const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
    const N = a / Math.sqrt(1 - e2 * sin * sin), T = tan * tan, C = ep2 * cos * cos, A = cos * (lam - lam0);
    const M = a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
      - (35 * e6 / 3072) * Math.sin(6 * phi));
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    let y = k0 * (M + N * tan * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    if (south) y += 10000000;
    return [x, y];
  }
  /** Projector for an EPSG code of the form 326zz / 327zz. */
  function utmProjector(epsg) {
    const code = Number(String(epsg).replace(/\D/g, ''));
    if (code < 32601 || code > 32760) throw new Error('Not a WGS84 UTM code: ' + epsg);
    const south = code > 32700, zone = code % 100;
    return (lon, lat) => utmForward(lon, lat, zone, south);
  }

  /* Status rules, same as pipeline/build_sites.py:classify */
  const DC = new Set(['data_center', 'data_centre']);
  const PAST = ['disused:', 'abandoned:', 'was:', 'removed:', 'demolished:', 'razed:'];
  function classify(tags) {
    for (const [k, v] of Object.entries(tags)) {
      if (!DC.has(v)) continue;
      if (k === 'construction' || k.startsWith('construction:')) return ['construction', `${k}=${v}`];
      if (k.startsWith('proposed:') || k.startsWith('planned:')) return ['planned', `${k}=${v}`];
      if (PAST.some(p => k.startsWith(p))) return ['abandoned', `${k}=${v}`];
    }
    const dcHit = Object.entries(tags).find(([, v]) => DC.has(v));
    if (tags.landuse === 'construction' || tags.building === 'construction')
      return ['construction', `${tags.landuse === 'construction' ? 'landuse' : 'building'}=construction + ${dcHit ? dcHit.join('=') : 'data-center name'}`];
    if (tags.disused === 'yes' || tags.abandoned === 'yes') return ['abandoned', 'disused/abandoned=yes'];
    if (tags.landuse === 'brownfield' || tags.landuse === 'greenfield') return ['planned', `landuse=${tags.landuse} + data-center name`];
    const od = tags.opening_date;
    if (od && /^\d{4}/.test(od) && Number(od.slice(0, 4)) > new Date().getFullYear()) return ['construction', 'opening_date in the future'];
    const hit = Object.entries(tags).find(([, v]) => DC.has(v));
    return ['operating', hit ? `${hit[0]}=${hit[1]}` : 'named data-center land use'];
  }

  global.Geo = { ringArea, geometryArea, bboxArea, inGeometry, geomBounds, utmForward, utmProjector, classify };
})(window);
