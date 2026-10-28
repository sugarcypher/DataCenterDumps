/* In-browser green-space measurement from Sentinel-2 Level-2A (Earth Search, AWS Open Data).
   Same method as pipeline/green_space.py, so browser and pipeline numbers are comparable. */
(function (global) {
  'use strict';
  const STAC = 'https://earth-search.aws.element84.com/v1/search';
  const INVALID_SCL = new Set([0, 1, 3, 8, 9, 10]);

  function season(year, lat) {
    if (Math.abs(lat) < 15) return `${year}-01-01T00:00:00Z/${year}-12-31T23:59:59Z`;
    if (lat >= 0) return `${year}-05-15T00:00:00Z/${year}-09-30T23:59:59Z`;
    return `${year - 1}-11-15T00:00:00Z/${year}-03-31T23:59:59Z`;
  }

  async function search(bbox, year, lat, n) {
    const body = {
      collections: ['sentinel-2-l2a'], bbox, datetime: season(year, lat),
      query: { 'eo:cloud_cover': { lt: 40 } },
      sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
      limit: Math.max(n * 3, 6),
    };
    const r = await fetch(STAC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('Sentinel-2 catalogue search failed (' + r.status + ')');
    const feats = (await r.json()).features || [];
    const out = [], days = new Set();
    for (const f of feats) {
      const day = f.properties.datetime.slice(0, 10);
      if (days.has(day) || !['red', 'nir', 'scl'].every(k => f.assets[k] && /^https:/.test(f.assets[k].href))) continue;
      days.add(day); out.push(f);
      if (out.length >= n) break;
    }
    return out;
  }

  function scaleOffset(asset) {
    const rb = (asset['raster:bands'] || [{}])[0];
    return [rb.scale ?? 0.0001, rb.offset ?? 0];
  }

  async function readWindow(href, b, pad = 20) {
    const tiff = await GeoTIFF.fromUrl(href, { allowFullFile: false });
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution(); // ry is negative (north-up)
    const W = img.getWidth(), H = img.getHeight();
    const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
    const x0 = clamp(Math.floor((b[0] - pad - ox) / rx), W), x1 = clamp(Math.ceil((b[2] + pad - ox) / rx), W);
    const y0 = clamp(Math.floor((b[3] + pad - oy) / ry), H), y1 = clamp(Math.ceil((b[1] - pad - oy) / ry), H);
    if (x1 <= x0 || y1 <= y0) throw new Error('site lies outside this scene');
    const [data] = await img.readRasters({ window: [x0, y0, x1, y1], samples: [0] });
    return { data, w: x1 - x0, h: y1 - y0, ox: ox + x0 * rx, oy: oy + y0 * ry, rx, ry };
  }

  function projectGeometry(g, proj) {
    const map = c => (typeof c[0] === 'number' ? proj(c[0], c[1]) : c.map(map));
    return { type: g.type, coordinates: map(g.coordinates) };
  }
  // Planar point-in-polygon works in UTM metres too.
  function inside(x, y, g) { return Geo.inGeometry(x, y, g); }

  async function measureScene(item, geomLL) {
    const epsg = item.properties['proj:epsg'] || item.properties['proj:code'];
    const g = projectGeometry(geomLL, Geo.utmProjector(epsg));
    const b = Geo.geomBounds(g);
    const [red, nir, scl] = await Promise.all([
      readWindow(item.assets.red.href, b), readWindow(item.assets.nir.href, b), readWindow(item.assets.scl.href, b),
    ]);
    const [rs, ro] = scaleOffset(item.assets.red), [ns, no] = scaleOffset(item.assets.nir);
    const ndvi = new Float32Array(red.w * red.h).fill(NaN);
    let pix = 0;
    for (let j = 0; j < red.h; j++) {
      const y = red.oy + (j + 0.5) * red.ry;
      for (let i = 0; i < red.w; i++) {
        const x = red.ox + (i + 0.5) * red.rx;
        if (!inside(x, y, g)) continue;
        pix++;
        const k = j * red.w + i;
        const sc = Math.floor((x - scl.ox) / scl.rx), sr = Math.floor((y - scl.oy) / scl.ry);
        const s = sc >= 0 && sr >= 0 && sc < scl.w && sr < scl.h ? scl.data[sr * scl.w + sc] : 0;
        const rdn = red.data[k], ndn = nir.data[k];
        if (INVALID_SCL.has(s) || rdn <= 0 || ndn <= 0) continue;
        const r = rdn * rs + ro, n = ndn * ns + no;
        if (r <= 0 || n <= 0) continue;
        ndvi[k] = Math.max(-1, Math.min(1, (n - r) / (n + r)));
      }
    }
    return { ndvi, w: red.w, h: red.h, pix };
  }

  async function measurePeriod(geomLL, lat, year, nScenes, threshold, onStep) {
    const bbox = Geo.geomBounds(geomLL);
    const items = await search(bbox, year, lat, nScenes);
    if (!items.length) return { year, error: 'no clear Sentinel-2 scene found' };
    const stack = [], dates = [];
    let pixMax = 0;
    for (const it of items) {
      onStep && onStep(`reading ${it.properties.datetime.slice(0, 10)} (${it.id.split('_')[1]})`);
      try {
        const s = await measureScene(it, geomLL);
        stack.push(s); dates.push(it.properties.datetime.slice(0, 10)); pixMax = Math.max(pixMax, s.pix);
      } catch (e) { console.warn('scene failed', it.id, e); }
    }
    if (!stack.length) return { year, error: 'all scene reads failed' };
    const ref = stack.reduce((a, s) => (s.w * s.h > a.w * a.h ? s : a));
    const same = stack.filter(s => s.w === ref.w && s.h === ref.h);
    const vals = [];
    for (let k = 0; k < ref.ndvi.length; k++) {
      const v = same.map(s => s.ndvi[k]).filter(Number.isFinite).sort((a, b) => a - b);
      if (!v.length) continue;
      const m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
      vals.push(m);
    }
    if (!vals.length) return { year, dates, error: 'no cloud-free pixels' };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const green = vals.filter(v => v >= threshold).length / vals.length;
    const r3 = x => Math.round(x * 1000) / 1000;
    return { year, dates, ndvi_mean: r3(mean), green_frac: r3(green), valid_frac: r3(Math.min(1, vals.length / Math.max(pixMax, 1))), pixels: vals.length };
  }

  function circle(lon, lat, radius) {
    const dlat = radius / 111320, dlon = radius / (111320 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
    const ring = [];
    for (let i = 0; i <= 64; i++) { const t = (i / 64) * 2 * Math.PI; ring.push([lon + dlon * Math.cos(t), lat + dlat * Math.sin(t)]); }
    return { type: 'Polygon', coordinates: [ring] };
  }

  /** feature: GeoJSON site feature. opts: {before, after, threshold, scenes, pointRadius, onStep} */
  async function measureGreen(feature, opts = {}) {
    const o = Object.assign({ before: 2017, after: 2025, threshold: 0.3, scenes: 2, pointRadius: 150 }, opts);
    const p = feature.properties;
    const est = !(p.area_m2 > 0);
    const geom = est ? circle(p.lon, p.lat, o.pointRadius) : feature.geometry;
    const area = est ? Math.PI * o.pointRadius ** 2 : p.area_m2;
    o.onStep && o.onStep(`searching ${o.before} scenes`);
    let before;
    for (let y = o.before; y < o.before + 3; y++) { // 2017 Level-2A is patchy outside Europe / North America
      before = await measurePeriod(geom, p.lat, y, o.scenes, o.threshold, o.onStep);
      if (!before.error || y >= o.after - 1) break;
    }
    o.onStep && o.onStep(`searching ${o.after} scenes`);
    const after = await measurePeriod(geom, p.lat, o.after, o.scenes, o.threshold, o.onStep);
    const out = { threshold: o.threshold, area_m2: Math.round(area), footprint_estimated: est, before, after, measured_utc: new Date().toISOString().slice(0, 19) + 'Z', source: 'browser' };
    if ('green_frac' in before) before.green_m2 = Math.round(before.green_frac * area);
    if ('green_frac' in after) after.green_m2 = Math.round(after.green_frac * area);
    if ('green_m2' in before && 'green_m2' in after) out.change_m2 = after.green_m2 - before.green_m2;
    return out;
  }

  global.NDVI = { measureGreen, season };
})(window);
