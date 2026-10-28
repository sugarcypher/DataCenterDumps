/* DataCenterDumps: map, tracker and land-share calculator. */
(async function () {
  'use strict';

  // ------------------------------------------------------------ constants
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const STATUS = {
    operating: { label: 'Operating', color: () => css('--operating') },
    construction: { label: 'Under construction', color: () => css('--construction') },
    planned: { label: 'Planned / proposed', color: () => css('--planned') },
    abandoned: { label: 'Abandoned / disused', color: () => css('--abandoned') },
  };
  const ORDER = Object.keys(STATUS);
  const CENTRAL_PARK_M2 = 3.41e6; // 843 acres
  const THIS_YEAR = new Date().getFullYear();
  const LAST_FULL_SEASON = new Date().getMonth() >= 9 ? THIS_YEAR : THIS_YEAR - 1;
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const NAME_RX = 'data ?cent(er|re)|datacent(er|re)|rechenzentrum|centre de donn|centro de datos|data campus|hyperscale';
  const OVERPASS_STATEMENTS = [
    'nwr["telecom"="data_center"]', 'nwr["telecom"="data_centre"]', 'nwr["building"="data_center"]', 'nwr["building"="data_centre"]',
    'nwr["industrial"~"^data_cent(er|re)$"]', 'nwr["construction"="data_center"]', 'nwr["construction:telecom"="data_center"]',
    'nwr["construction:building"="data_center"]', 'nwr["proposed:telecom"="data_center"]', 'nwr["planned:telecom"="data_center"]',
    'nwr["proposed:building"="data_center"]', 'nwr["disused:telecom"="data_center"]', 'nwr["abandoned:telecom"="data_center"]',
    'nwr["was:telecom"="data_center"]', 'nwr["removed:telecom"="data_center"]', 'nwr["disused:building"="data_center"]',
    'nwr["abandoned:building"="data_center"]', 'nwr["demolished:building"="data_center"]', 'nwr["razed:building"="data_center"]',
    `nwr["landuse"="construction"]["name"~"${NAME_RX}",i]`, `nwr["building"="construction"]["name"~"${NAME_RX}",i]`,
    `nwr["landuse"="industrial"]["name"~"${NAME_RX}",i]`, `nwr["landuse"="brownfield"]["name"~"${NAME_RX}",i]`,
    `nwr["landuse"="greenfield"]["name"~"${NAME_RX}",i]`,
  ];

  // ------------------------------------------------------------ formatting
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (x, d = 0) => Number(x).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const km2 = m2 => (m2 > 0 && m2 < 5e4 ? nf(m2 / 1e4, 2) + ' ha' : (m2 >= 1e7 ? nf(m2 / 1e6, 0) : m2 >= 1e6 ? nf(m2 / 1e6, 1) : nf(m2 / 1e6, 2)) + ' km²');
  const ha = m2 => nf(m2 / 1e4, m2 < 1e5 ? 2 : 1) + ' ha';
  const acres = m2 => nf(m2 / 4046.856, m2 < 4e4 ? 1 : 0) + ' acres';
  function pct(x) {
    const p = x * 100;
    if (!isFinite(p) || p === 0) return '0%';
    if (p >= 1) return nf(p, 2) + '%';
    const d = Math.min(9, Math.ceil(-Math.log10(p)) + 2);
    return p.toFixed(d) + '%';
  }
  const ppm = x => nf(x * 1e6, x * 1e6 < 10 ? 2 : 1) + ' ppm';

  // ------------------------------------------------------------ data
  const getJSON = (u, optional) => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); })
    .catch(e => { if (optional) return null; throw e; });
  let sitesFC, regions, meta, satIndex;
  try {
    [sitesFC, regions, meta, satIndex] = await Promise.all([
      getJSON('data/sites.geojson'), getJSON('data/regions.json'), getJSON('data/meta.json', true), getJSON('data/satdump/index.json', true),
    ]);
  } catch (e) {
    $('#headline').textContent = 'Could not load data (' + e.message + '). Serve the web/ folder over HTTP, e.g. python3 -m http.server -d web';
    return;
  }
  const state = {
    sites: sitesFC.features,
    byId: new Map(sitesFC.features.map(f => [f.properties.id, f])),
    active: new Set(ORDER),
    selected: null,
    view: null,
    satdump: (satIndex && satIndex.passes) || [],
    satdumpDetail: new Map(),
    countriesGeo: null,
    admin1Geo: null,
  };

  // ------------------------------------------------------------ map
  const map = L.map('map', { preferCanvas: true, worldCopyJump: true, zoomControl: true }).setView([30, 0], 2);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
  const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
  const EOX_YEARS = [];
  for (let y = 2016; y <= 2025; y++) EOX_YEARS.push(y);
  function eox(year, pane) {
    const id = year === 2016 ? 's2cloudless_3857' : `s2cloudless-${year}_3857`;
    return L.tileLayer(`https://tiles.maps.eox.at/wmts/1.0.0/${id}/default/g/{z}/{y}/{x}.jpg`, {
      maxZoom: 19, maxNativeZoom: 15, pane: pane || 'tilePane',
      attribution: `<a href="https://s2maps.eu">Sentinel-2 cloudless ${year}</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data ${year})`,
    });
  }
  const basemaps = { 'Map (OpenStreetMap)': osm, 'Satellite, latest (Esri)': esri };
  EOX_YEARS.slice().reverse().forEach(y => { basemaps[`Sentinel-2 ${y}`] = eox(y); });
  osm.addTo(map);

  const cluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false, maxClusterRadius: 45, disableClusteringAtZoom: 13 });
  const footprints = L.geoJSON(null, { style: footprintStyle, onEachFeature: (f, l) => l.on('click', () => selectSite(f.properties.id)) });
  const regionOutline = L.geoJSON(null, { style: { color: css('--accent'), weight: 2, fill: false, dashArray: '6 4' }, interactive: false });
  map.addLayer(cluster); map.addLayer(footprints); map.addLayer(regionOutline);
  const overlays = { 'Data center sites': cluster, 'Footprints (zoom 11+)': footprints };
  state.satdump.forEach(p => {
    const [w, s, e, n] = p.bounds;
    overlays[`SatDump: ${p.label}${p.date ? ' ' + p.date : ''}`] = L.imageOverlay(`data/satdump/${p.slug}.png`, [[s, w], [n, e]], { opacity: 0.75, attribution: 'SatDump pass' });
  });
  L.control.layers(basemaps, overlays, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: true }).addTo(map);

  function footprintStyle(f) {
    const st = f.properties.status;
    return { color: STATUS[st].color(), weight: 1.5, fillOpacity: 0.25, dashArray: st === 'abandoned' ? '4 3' : st === 'planned' ? '2 4' : null };
  }
  function visible(p) { return state.active.has(p.status); }

  function rebuildMarkers() {
    cluster.clearLayers();
    const ms = [];
    for (const f of state.sites) {
      const p = f.properties;
      if (!visible(p) || p.nested_in) continue;
      const m = L.circleMarker([p.lat, p.lon], { radius: 6, weight: 1.5, color: 'rgba(0,0,0,.45)', fillColor: STATUS[p.status].color(), fillOpacity: 0.9 });
      m.bindTooltip(`${esc(p.name)}<br><span style="opacity:.75">${STATUS[p.status].label}${p.area_m2 ? ' · ' + ha(p.area_m2) : ''}</span>`);
      m.on('click', () => selectSite(p.id));
      ms.push(m);
    }
    cluster.addLayers(ms);
  }
  function refreshFootprints() {
    footprints.clearLayers();
    if (map.getZoom() < 11) return;
    const b = map.getBounds().pad(0.2);
    let n = 0;
    for (const f of state.sites) {
      const p = f.properties;
      if (!p.area_m2 || !visible(p) || !b.contains([p.lat, p.lon])) continue;
      footprints.addData(f);
      if (++n > 4000) break;
    }
  }
  map.on('moveend', () => { refreshFootprints(); writeHash(); if ($('#site-inview').checked) renderList(); });

  // legend
  $('#legend').innerHTML = ORDER.map(s => `<div><span class="dot" style="background:${STATUS[s].color()}"></span>${STATUS[s].label}</div>`).join('');

  // ------------------------------------------------------------ statistics
  function topLevel(p) { return !p.nested_in; }
  function medianAreas() {
    const by = {};
    for (const f of state.sites) {
      const p = f.properties;
      if (p.area_m2 > 0 && topLevel(p)) (by[p.status] = by[p.status] || []).push(p.area_m2);
    }
    const all = Object.values(by).flat().sort((a, b) => a - b);
    const med = a => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
    const out = { _all: med(all) };
    ORDER.forEach(s => { out[s] = (by[s] && by[s].length >= 5) ? med(by[s]) : out._all; });
    return out;
  }
  let MEDIANS = medianAreas();

  function aggregate(filterFn, opts = {}) {
    const statuses = opts.statuses || state.active;
    const r = { count: 0, mapped: 0, estimated: 0, pointOnly: 0, by: {} };
    ORDER.forEach(s => { r.by[s] = { count: 0, mapped: 0, estimated: 0 }; });
    for (const f of state.sites) {
      const p = f.properties;
      if (!statuses.has(p.status) || !topLevel(p) || !filterFn(p)) continue;
      const b = r.by[p.status];
      r.count++; b.count++;
      if (p.area_m2 > 0) { r.mapped += p.area_m2; b.mapped += p.area_m2; }
      else { r.pointOnly++; const e = MEDIANS[p.status] || 0; r.estimated += e; b.estimated += e; }
    }
    return r;
  }

  function renderHeadline() {
    const a = aggregate(() => true);
    const world = regions.world_land_km2 * 1e6;
    $('#headline').innerHTML = `<b>${nf(a.count)}</b> sites · <b>${km2(a.mapped)}</b> mapped · <b>${pct(a.mapped / world)}</b> of land` +
      (meta && meta.osm_base_utc ? ` <span class="hint">· OpenStreetMap ${esc(meta.osm_base_utc.slice(0, 10))}</span>` : '');
  }

  function renderStatusChips() {
    const counts = {};
    state.sites.forEach(f => { if (topLevel(f.properties)) counts[f.properties.status] = (counts[f.properties.status] || 0) + 1; });
    $('#status-filters').innerHTML = ORDER.map(s => `<button class="chip" data-status="${s}" aria-pressed="${state.active.has(s)}"><span class="dot" style="background:${STATUS[s].color()}"></span>${STATUS[s].label} <b>${nf(counts[s] || 0)}</b></button>`).join('');
    document.querySelectorAll('#status-filters .chip').forEach(b => b.onclick = () => {
      const s = b.dataset.status;
      state.active.has(s) ? state.active.delete(s) : state.active.add(s);
      if (!state.active.size) state.active.add(s);
      refreshAll();
    });
  }

  function renderOverview() {
    const a = aggregate(() => true);
    const world = regions.world_land_km2 * 1e6;
    const con = a.by.construction, ab = a.by.abandoned;
    $('#kpis').innerHTML = `
      <div class="kpi"><div class="v">${nf(a.count)}</div><div class="l">sites shown (campus buildings merged)</div></div>
      <div class="kpi"><div class="v">${km2(a.mapped)}</div><div class="l">mapped footprint · ${nf(a.count - a.pointOnly)} sites with outlines</div></div>
      <div class="kpi wide"><div class="v">${pct(a.mapped / world)} <span class="hint">(${ppm(a.mapped / world)})</span></div><div class="l">of Earth's land area is mapped data-center footprint; ${pct((a.mapped + a.estimated) / world)} if the ${nf(a.pointOnly)} point-only sites are given a median footprint</div></div>
      <div class="kpi"><div class="v" style="color:${STATUS.construction.color()}">${nf(con.count)}</div><div class="l">under construction · ${km2(con.mapped)} mapped</div></div>
      <div class="kpi"><div class="v" style="color:${STATUS.abandoned.color()}">${nf(ab.count)}</div><div class="l">abandoned / disused · ${km2(ab.mapped)} mapped</div></div>`;

    // green space
    const g = state.sites.filter(f => visible(f.properties) && topLevel(f.properties) && f.properties.green && f.properties.green.change_m2 !== undefined);
    if (!g.length) {
      $('#green-summary').innerHTML = '<p class="hint">No sites measured yet in this filter.</p>';
    } else {
      let before = 0, after = 0, lostHalf = 0;
      g.forEach(f => { const x = f.properties.green; before += x.before.green_m2; after += x.after.green_m2; if (x.before.green_frac > 0.2 && x.after.green_frac < x.before.green_frac / 2) lostHalf++; });
      const worst = g.slice().sort((x, y) => x.properties.green.change_m2 - y.properties.green.change_m2).slice(0, 8);
      const delta = after - before;
      const span = k => { const ys = g.map(f => f.properties.green[k].year); const lo = Math.min(...ys), hi = Math.max(...ys); return lo === hi ? lo : `${lo}–${hi}`; };
      $('#green-summary').innerHTML = `
        <div class="green-compare">
          <div class="kpi"><div class="v">${km2(before)}</div><div class="l">green before (${span('before')})</div></div>
          <div class="kpi"><div class="v">${km2(after)}</div><div class="l">green after (${span('after')})</div></div>
        </div>
        <p><b class="${delta < 0 ? 'delta-loss' : 'delta-gain'}">${delta < 0 ? '−' : '+'}${km2(Math.abs(delta))}</b> net across ${nf(g.length)} measured sites; ${nf(lostHalf)} lost more than half their green cover.</p>
        <table><thead><tr><th>Largest losses</th><th class="n">before → after</th><th class="n">change</th></tr></thead><tbody>
        ${worst.map(f => { const x = f.properties.green; return `<tr class="click" data-id="${esc(f.properties.id)}"><td>${esc(f.properties.name)}</td><td class="n">${Math.round(x.before.green_frac * 100)}% → ${Math.round(x.after.green_frac * 100)}%</td><td class="n delta-loss">${ha(Math.abs(x.change_m2))}</td></tr>`; }).join('')}
        </tbody></table>`;
    }

    // countries
    const byC = {};
    for (const f of state.sites) {
      const p = f.properties;
      if (!visible(p) || !topLevel(p) || !p.country) continue;
      const c = byC[p.country] = byC[p.country] || { n: 0, m2: 0 };
      c.n++; c.m2 += p.area_m2 || 0;
    }
    const rows = Object.entries(byC).filter(([c]) => regions.countries[c]).map(([c, v]) => ({ c, ...v, share: v.m2 / (regions.countries[c].area_km2 * 1e6) }))
      .sort((a, b) => b.share - a.share).slice(0, 15);
    $('#top-countries').innerHTML = `<table><thead><tr><th>Country</th><th class="n">sites</th><th class="n">mapped</th><th class="n">share of land</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="click" data-country="${r.c}"><td>${esc(regions.countries[r.c].name)}</td><td class="n">${nf(r.n)}</td><td class="n">${km2(r.m2)}</td><td class="n">${pct(r.share)}</td></tr>`).join('')}</tbody></table>`;

    // satdump
    if (state.satdump.length) {
      $('#satdump-list').innerHTML = `<table><thead><tr><th>Pass</th><th>date</th><th class="n">mean index</th><th class="n">sites</th></tr></thead><tbody>
        ${state.satdump.map(p => `<tr class="click" data-pass="${esc(p.slug)}"><td>${esc(p.label)}</td><td>${esc(p.date || '')}</td><td class="n">${p.scene_ndvi_mean ?? '–'}</td><td class="n">${nf(p.site_count)}</td></tr>`).join('')}</tbody></table>
        <p class="hint">Toggle passes in the layer menu (top right of the map).</p>`;
    }
    bindRowClicks($('#pane-overview'));
  }

  function bindRowClicks(root) {
    root.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => selectSite(tr.dataset.id));
    root.querySelectorAll('tr[data-country]').forEach(tr => tr.onclick = () => { $('#calc-region').value = 'c:' + tr.dataset.country; showTab('calc'); renderCalc(true); });
    root.querySelectorAll('tr[data-pass]').forEach(tr => tr.onclick = () => {
      const p = state.satdump.find(x => x.slug === tr.dataset.pass);
      const [w, s, e, n] = p.bounds; map.fitBounds([[s, w], [n, e]]);
    });
  }

  // ------------------------------------------------------------ calculator
  function buildRegionSelect() {
    const present = new Set(state.sites.map(f => f.properties.country).filter(Boolean));
    const a1present = new Set(state.sites.map(f => f.properties.admin1).filter(Boolean));
    const countries = Object.entries(regions.countries).filter(([c]) => present.has(c)).sort((a, b) => a[1].name.localeCompare(b[1].name));
    const a1 = Object.entries(regions.admin1).filter(([c]) => a1present.has(c)).sort((a, b) => (a[1].country + a[1].name).localeCompare(b[1].country + b[1].name));
    const groups = {};
    a1.forEach(([code, r]) => (groups[r.country] = groups[r.country] || []).push([code, r]));
    $('#calc-region').innerHTML = `<option value="world">World (all land)</option><option value="view" ${state.view ? '' : 'disabled'}>Current map view${state.view ? '' : ' (press the button)'}</option>
      <optgroup label="Countries">${countries.map(([c, r]) => `<option value="c:${c}">${esc(r.name)}</option>`).join('')}</optgroup>
      ${Object.entries(groups).map(([cc, list]) => `<optgroup label="${esc((regions.countries[cc] || {}).name || cc)}: states / provinces">${list.map(([code, r]) => `<option value="a:${code}">${esc(r.name)}</option>`).join('')}</optgroup>`).join('')}`;
    $('#calc-status').innerHTML = ORDER.map(s => `<label class="check"><input type="checkbox" value="${s}" ${s !== 'abandoned' ? 'checked' : ''}> <span class="dot" style="background:${STATUS[s].color()}"></span>${STATUS[s].label}</label>`).join('');
    $('#calc-status').querySelectorAll('input').forEach(i => i.onchange = () => renderCalc());
  }

  async function regionOutlineFor(sel) {
    regionOutline.clearLayers();
    if (sel === 'world') return;
    if (sel === 'view' && state.view) { const [w, s, e, n] = state.view; regionOutline.addData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }); return; }
    const [kind, code] = sel.split(':');
    const key = kind === 'c' ? 'countriesGeo' : 'admin1Geo';
    if (!state[key]) state[key] = await getJSON(kind === 'c' ? 'data/countries.geojson' : 'data/admin1.geojson', true);
    const f = state[key] && state[key].features.find(x => x.properties.code === code);
    if (f) regionOutline.addData(f);
  }

  function renderCalc(fit) {
    const sel = $('#calc-region').value;
    const statuses = new Set([...$('#calc-status').querySelectorAll('input:checked')].map(i => i.value));
    const estimate = $('#calc-estimate').checked;
    const mult = Number($('#calc-mult').value);
    $('#calc-mult-out').textContent = mult.toFixed(1) + '×';
    let filterFn, landM2, label, bbox;
    if (sel === 'world') { filterFn = () => true; landM2 = regions.world_land_km2 * 1e6; label = 'Earth\'s land'; }
    else if (sel === 'view' && state.view) {
      const [w, s, e, n] = state.view;
      filterFn = p => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
      landM2 = Geo.bboxArea(w, s, e, n); label = 'the map-view rectangle (land and water)'; bbox = state.view;
    } else {
      const [kind, code] = sel.split(':');
      const r = kind === 'c' ? regions.countries[code] : regions.admin1[code];
      filterFn = kind === 'c' ? p => p.country === code : p => p.admin1 === code;
      landM2 = r.area_km2 * 1e6; label = r.name; bbox = r.bbox;
    }
    const a = aggregate(filterFn, { statuses });
    const fp = (a.mapped + (estimate ? a.estimated : 0)) * mult;
    const share = fp / landM2;
    $('#calc-out').innerHTML = `
      <div class="big">${pct(share)}</div>
      <div class="hint">${ppm(share)} of ${esc(label)} (${km2(landM2)})</div>
      <div class="bar" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0.5, Math.log10(1 + share * 1e6) / 6 * 100))}%;background:var(--accent)"></span></div>
      <p class="hint">Bar is logarithmic: full width = 100%.</p>
      <dl class="props">
        <dt>Land taken</dt><dd>${km2(fp)} · ${acres(fp)}</dd>
        <dt>Sites counted</dt><dd>${nf(a.count)} (${nf(a.count - a.pointOnly)} outlined, ${nf(a.pointOnly)} point-only)</dd>
        <dt>Mapped</dt><dd>${km2(a.mapped)}</dd>
        <dt>Estimated</dt><dd>${estimate ? km2(a.estimated) + ' for point-only sites' : 'off'}</dd>
        <dt>Multiplier</dt><dd>${mult.toFixed(1)}×</dd>
        <dt>Scale</dt><dd>≈ ${nf(fp / CENTRAL_PARK_M2, fp / CENTRAL_PARK_M2 < 10 ? 1 : 0)} Central Parks; one square metre in every ${nf(1 / share || 0)}</dd>
      </dl>
      <table><thead><tr><th>Status</th><th class="n">sites</th><th class="n">mapped</th><th class="n">est. extra</th></tr></thead><tbody>
      ${ORDER.filter(s => statuses.has(s)).map(s => `<tr><td><span class="dot" style="background:${STATUS[s].color()}"></span> ${STATUS[s].label}</td><td class="n">${nf(a.by[s].count)}</td><td class="n">${km2(a.by[s].mapped)}</td><td class="n">${estimate ? km2(a.by[s].estimated) : '–'}</td></tr>`).join('')}
      </tbody></table>`;
    regionOutlineFor(sel);
    if (fit && bbox) map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
  }
  $('#calc-region').onchange = () => renderCalc(true);
  $('#calc-estimate').onchange = () => renderCalc();
  $('#calc-mult').oninput = () => renderCalc();
  document.querySelectorAll('.presets button').forEach(b => b.onclick = () => { $('#calc-mult').value = b.dataset.mult; renderCalc(); });
  $('#calc-view').onclick = () => {
    const b = map.getBounds();
    state.view = [Math.max(b.getWest(), -180), Math.max(b.getSouth(), -85), Math.min(b.getEast(), 180), Math.min(b.getNorth(), 85)];
    buildRegionSelect(); $('#calc-region').value = 'view'; renderCalc();
  };

  // ------------------------------------------------------------ site list
  let listLimit = 100;
  function filteredList() {
    const q = $('#site-search').value.trim().toLowerCase();
    const inView = $('#site-inview').checked ? map.getBounds() : null;
    let arr = state.sites.filter(f => {
      const p = f.properties;
      if (!visible(p) || p.nested_in) return false;
      if (inView && !inView.contains([p.lat, p.lon])) return false;
      if (!q) return true;
      const t = p.tags || {};
      return [p.name, t.operator, t.owner, t['addr:city'], p.country_name, p.admin1_name, p.id].some(v => v && String(v).toLowerCase().includes(q));
    });
    const sort = $('#site-sort').value;
    if (sort === 'area') arr.sort((a, b) => (b.properties.area_m2 || 0) - (a.properties.area_m2 || 0));
    if (sort === 'name') arr.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    if (sort === 'green') arr = arr.filter(f => f.properties.green && f.properties.green.change_m2 !== undefined).sort((a, b) => a.properties.green.change_m2 - b.properties.green.change_m2);
    return arr;
  }
  function renderList() {
    const arr = filteredList();
    $('#site-count').textContent = `${nf(arr.length)} sites`;
    $('#site-list').innerHTML = arr.slice(0, listLimit).map(f => {
      const p = f.properties, g = p.green;
      const right = $('#site-sort').value === 'green' && g ? `<span class="delta-loss">${ha(Math.abs(g.change_m2))}</span>` : p.area_m2 ? ha(p.area_m2) : '<span class="hint">point</span>';
      return `<li data-id="${esc(p.id)}"><span class="dot" style="background:${STATUS[p.status].color()}"></span><div><div>${esc(p.name)}</div><div class="meta">${esc([p.tags && p.tags.operator, p.admin1_name, p.country_name].filter(Boolean).join(' · '))}</div></div><div class="num">${right}</div></li>`;
    }).join('');
    $('#site-more').hidden = arr.length <= listLimit;
    $('#site-list').querySelectorAll('li').forEach(li => li.onclick = () => selectSite(li.dataset.id));
  }
  let searchTimer;
  $('#site-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { listLimit = 100; renderList(); }, 150); };
  $('#site-sort').onchange = () => { listLimit = 100; renderList(); };
  $('#site-inview').onchange = () => renderList();
  $('#site-more').onclick = () => { listLimit += 200; renderList(); };

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $('#export-geojson').onclick = () => download('datacenterdumps.geojson', JSON.stringify({ type: 'FeatureCollection', features: filteredList() }), 'application/geo+json');
  $('#export-csv').onclick = () => {
    const cols = ['id', 'name', 'status', 'status_reason', 'area_m2', 'lat', 'lon', 'country', 'country_name', 'admin1_name', 'operator', 'nested_in',
      'green_before_year', 'green_before_frac', 'green_after_year', 'green_after_frac', 'green_change_m2', 'osm_url'];
    const q = v => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const lines = [cols.join(',')].concat(filteredList().map(f => {
      const p = f.properties, g = p.green || {};
      const row = { ...p, operator: p.tags && p.tags.operator, green_before_year: g.before && g.before.year, green_before_frac: g.before && g.before.green_frac,
        green_after_year: g.after && g.after.year, green_after_frac: g.after && g.after.green_frac, green_change_m2: g.change_m2, osm_url: osmUrl(p.id) };
      return cols.map(c => q(row[c])).join(',');
    }));
    download('datacenterdumps.csv', lines.join('\n'), 'text/csv');
  };
  const osmUrl = id => (id.startsWith('live/') ? '' : 'https://www.openstreetmap.org/' + id);

  // ------------------------------------------------------------ site detail
  function yearOptions(sel) { const out = []; for (let y = 2017; y <= LAST_FULL_SEASON; y++) out.push(`<option ${y === sel ? 'selected' : ''}>${y}</option>`); return out.join(''); }
  function greenBlock(g) {
    if (!g) return '<p class="hint">Not measured yet.</p>';
    const card = (x, label) => x.error
      ? `<div class="kpi"><div class="l">${label} ${x.year}</div><div class="hint">${esc(x.error)}</div></div>`
      : `<div class="kpi"><div class="v">${Math.round(x.green_frac * 100)}% green</div><div class="l">${label} ${x.year} · ${ha(x.green_m2)} · index ${x.ndvi_mean}<br>${esc((x.dates || []).join(', '))} · ${Math.round(x.valid_frac * 100)}% clear</div></div>`;
    return `<div class="green-compare">${card(g.before, 'Before')}${card(g.after, 'After')}</div>` +
      (g.change_m2 !== undefined ? `<p><b class="${g.change_m2 < 0 ? 'delta-loss' : 'delta-gain'}">${g.change_m2 < 0 ? '−' : '+'}${ha(Math.abs(g.change_m2))}</b> green space (${acres(Math.abs(g.change_m2))}) ${g.footprint_estimated ? 'within a 150 m circle (no mapped outline)' : 'inside the mapped footprint'}. Threshold: index ≥ ${g.threshold}. ${g.source === 'browser' ? 'Measured in this browser just now.' : 'Measured ' + esc((g.measured_utc || '').slice(0, 10)) + '.'}</p>` : '');
  }
  function satdumpBlock(p) {
    const hits = state.satdump.filter(x => { const [w, s, e, n] = x.bounds; return p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n; });
    if (!hits.length) return '';
    return `<h3>SatDump regional context</h3><div id="sd-rows" class="hint">Loading…</div>`;
  }
  async function fillSatdump(p) {
    const el = $('#sd-rows'); if (!el) return;
    const hits = state.satdump.filter(x => { const [w, s, e, n] = x.bounds; return p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n; });
    const rows = [];
    for (const h of hits) {
      if (!state.satdumpDetail.has(h.slug)) state.satdumpDetail.set(h.slug, await getJSON(`data/satdump/${h.slug}.json`, true));
      const d = state.satdumpDetail.get(h.slug);
      const v = d && d.sites && d.sites[p.id];
      rows.push(`<tr><td>${esc(h.label)}</td><td>${esc(h.date || '')}</td><td class="n">${v ? v.ndvi_mean : '–'}</td></tr>`);
    }
    el.outerHTML = `<table><thead><tr><th>Pass</th><th>date</th><th class="n">index within ${hits[0] ? (state.satdumpDetail.get(hits[0].slug) || {}).radius_km || 5 : 5} km</th></tr></thead><tbody>${rows.join('')}</tbody></table>
      <p class="hint">Received and decoded with SatDump at about 1 km per pixel: the surrounding area's vegetation, not the site itself.</p>`;
  }

  function selectSite(id, opts = {}) {
    const f = state.byId.get(id);
    if (!f) return;
    state.selected = id;
    const p = f.properties, t = p.tags || {};
    const parent = p.nested_in && state.byId.get(p.nested_in);
    $('#tab-site').hidden = false;
    $('#site-detail').innerHTML = `<div class="detail">
      <h2>${esc(p.name)}</h2>
      <span class="badge" style="background:${STATUS[p.status].color()}">${STATUS[p.status].label}</span>
      <span class="hint"> from <code>${esc(p.status_reason)}</code></span>
      ${parent ? `<p class="hint">Part of <a href="#" data-goto="${esc(parent.properties.id)}">${esc(parent.properties.name)}</a>; counted there, not here.</p>` : ''}
      <dl class="props">
        <dt>Footprint</dt><dd>${p.area_m2 ? `${ha(p.area_m2)} · ${acres(p.area_m2)}` : 'mapped as a point only'}</dd>
        ${t.operator ? `<dt>Operator</dt><dd>${esc(t.operator)}</dd>` : ''}
        ${t.owner ? `<dt>Owner</dt><dd>${esc(t.owner)}</dd>` : ''}
        <dt>Location</dt><dd>${esc([t['addr:city'], p.admin1_name, p.country_name].filter(Boolean).join(', ') || '–')}<br><span class="hint">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span></dd>
        ${t.start_date || t.opening_date ? `<dt>Opened</dt><dd>${esc(t.start_date || t.opening_date)}</dd>` : ''}
        ${t['construction:start_date'] ? `<dt>Construction from</dt><dd>${esc(t['construction:start_date'])}</dd>` : ''}
        ${t.end_date ? `<dt>Closed</dt><dd>${esc(t.end_date)}</dd>` : ''}
        ${t.capacity || t['data_center:power'] || t.power ? `<dt>Power / capacity</dt><dd>${esc(t['data_center:power'] || t.capacity || t.power)}</dd>` : ''}
        ${t.website ? `<dt>Website</dt><dd><a href="${esc(t.website)}" target="_blank" rel="noopener">${esc(t.website.replace(/^https?:\/\//, ''))}</a></dd>` : ''}
        <dt>Source</dt><dd>${osmUrl(p.id) ? `<a href="${osmUrl(p.id)}" target="_blank" rel="noopener">OpenStreetMap ${esc(p.id)}</a>` : 'live OpenStreetMap query'}${t.wikidata ? ` · <a href="https://www.wikidata.org/wiki/${esc(t.wikidata)}" target="_blank" rel="noopener">Wikidata</a>` : ''}</dd>
      </dl>
      <div class="row"><button class="ghost" id="btn-compare" type="button">Compare imagery before / after</button><button class="ghost" id="btn-zoom" type="button">Zoom to site</button></div>
      <h3>Green space before / after</h3>
      <div id="green-block">${greenBlock(p.green)}</div>
      <div class="row">
        <label class="small">Before <select id="g-before">${yearOptions(p.green ? p.green.before.year : 2017)}</select></label>
        <label class="small">After <select id="g-after">${yearOptions(p.green ? p.green.after.year : LAST_FULL_SEASON)}</select></label>
      </div>
      <button class="primary" id="btn-measure" type="button">${p.green ? 'Measure again' : 'Measure green space now'}</button>
      <div class="hint" id="measure-status"></div>
      ${satdumpBlock(p)}
    </div>`;
    const goto = $('#site-detail [data-goto]');
    if (goto) goto.onclick = e => { e.preventDefault(); selectSite(goto.dataset.goto); };
    $('#btn-zoom').onclick = () => zoomTo(f);
    $('#btn-compare').onclick = () => { zoomTo(f); openSwipe(2016, LAST_FULL_SEASON >= 2025 ? 2025 : LAST_FULL_SEASON); };
    $('#btn-measure').onclick = () => measure(f);
    fillSatdump(p);
    showTab('site');
    if (!opts.noZoom) zoomTo(f);
    writeHash();
  }
  function zoomTo(f) {
    const p = f.properties;
    if (p.area_m2 > 0) map.fitBounds(L.geoJSON(f).getBounds().pad(0.6), { maxZoom: 17 });
    else map.setView([p.lat, p.lon], 16);
  }
  async function measure(f) {
    const btn = $('#btn-measure'), st = $('#measure-status');
    btn.disabled = true;
    try {
      const res = await NDVI.measureGreen(f, { before: Number($('#g-before').value), after: Number($('#g-after').value), onStep: s => { st.textContent = s + '…'; } });
      f.properties.green = res;
      $('#green-block').innerHTML = greenBlock(res);
      st.textContent = 'Done. Exports now include this measurement.';
      renderOverview();
    } catch (e) {
      st.textContent = 'Measurement failed: ' + e.message;
    } finally { btn.disabled = false; }
  }

  // ------------------------------------------------------------ before/after swipe
  map.createPane('swipeA').style.zIndex = 210;
  map.createPane('swipeB').style.zIndex = 220;
  let swipeA = null, swipeB = null;
  const swipeOpts = () => [...EOX_YEARS.map(y => [String(y), `Sentinel-2 ${y}`]), ['esri', 'Esri latest (sub-metre)']];
  function swipeLayer(v, pane) {
    if (v === 'esri') return L.tileLayer(esri._url, Object.assign({}, esri.options, { pane }));
    return eox(Number(v), pane);
  }
  function openSwipe(a, b) {
    const opt = sel => swipeOpts().map(([v, l]) => `<option value="${v}" ${v === String(sel) ? 'selected' : ''}>${l}</option>`).join('');
    $('#swipe-a').innerHTML = opt(a); $('#swipe-b').innerHTML = opt(b);
    $('#swipe').hidden = false;
    setSwipeLayers();
  }
  function setSwipeLayers() {
    if (swipeA) map.removeLayer(swipeA);
    if (swipeB) map.removeLayer(swipeB);
    swipeA = swipeLayer($('#swipe-a').value, 'swipeA').addTo(map);
    swipeB = swipeLayer($('#swipe-b').value, 'swipeB').addTo(map);
    clipSwipe();
  }
  function clipSwipe() {
    if ($('#swipe').hidden) return;
    const size = map.getSize();
    const x = size.x * Number($('#swipe-range').value) / 100;
    const nw = map.containerPointToLayerPoint([0, 0]), se = map.containerPointToLayerPoint(size);
    const cx = map.containerPointToLayerPoint([x, 0]).x;
    map.getPane('swipeA').style.clip = `rect(${nw.y}px, ${cx}px, ${se.y}px, ${nw.x}px)`;
    map.getPane('swipeB').style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${cx}px)`;
    $('#swipe-line').style.left = x + 'px';
  }
  $('#swipe-range').oninput = clipSwipe;
  $('#swipe-a').onchange = setSwipeLayers;
  $('#swipe-b').onchange = setSwipeLayers;
  $('#swipe-close').onclick = () => { $('#swipe').hidden = true; if (swipeA) map.removeLayer(swipeA); if (swipeB) map.removeLayer(swipeB); swipeA = swipeB = null; };
  map.on('move resize zoomend', clipSwipe);

  // ------------------------------------------------------------ live OpenStreetMap refresh
  function elementToFeature(el) {
    const tags = el.tags || {};
    let geometry = null;
    if (el.type === 'node') geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
    else if (el.type === 'way' && el.geometry) {
      const pts = el.geometry.map(p => [p.lon, p.lat]);
      const closed = pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
      geometry = closed ? { type: 'Polygon', coordinates: [pts] } : { type: 'Point', coordinates: pts[Math.floor(pts.length / 2)] };
    } else if (el.type === 'relation' && el.members) {
      const rings = el.members.filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry).map(m => m.geometry.map(p => [p.lon, p.lat]))
        .filter(r => r.length >= 4 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]);
      if (rings.length) geometry = { type: 'MultiPolygon', coordinates: rings.map(r => [r]) };
      else if (el.bounds) geometry = { type: 'Point', coordinates: [(el.bounds.minlon + el.bounds.maxlon) / 2, (el.bounds.minlat + el.bounds.maxlat) / 2] };
    }
    if (!geometry) return null;
    const [status, reason] = Geo.classify(tags);
    const area = Geo.geometryArea(geometry);
    let lon, lat;
    if (geometry.type === 'Point') [lon, lat] = geometry.coordinates;
    else { const b = Geo.geomBounds(geometry); lon = (b[0] + b[2]) / 2; lat = (b[1] + b[3]) / 2; }
    const keep = ['name', 'operator', 'owner', 'brand', 'website', 'start_date', 'opening_date', 'construction:start_date', 'power', 'capacity', 'data_center:power', 'addr:city', 'wikidata', 'end_date'];
    return { type: 'Feature', geometry, properties: {
      id: `${el.type}/${el.id}`, name: tags.name || tags.operator || tags.brand || 'Unnamed data center', status, status_reason: reason,
      area_m2: Math.round(area * 10) / 10, lat, lon, country: null, country_name: null, admin1: null, admin1_name: null,
      tags: Object.fromEntries(keep.filter(k => tags[k]).map(k => [k, tags[k]])), live: true } };
  }
  async function locateRegions(features) {
    if (!state.countriesGeo) state.countriesGeo = await getJSON('data/countries.geojson', true);
    if (!state.admin1Geo) state.admin1Geo = await getJSON('data/admin1.geojson', true);
    for (const f of features) {
      const p = f.properties;
      const c = state.countriesGeo && state.countriesGeo.features.find(x => Geo.inGeometry(p.lon, p.lat, x.geometry));
      if (c) { p.country = c.properties.code; p.country_name = (regions.countries[c.properties.code] || {}).name || c.properties.name; }
      const a = state.admin1Geo && state.admin1Geo.features.find(x => x.properties.country === p.country && Geo.inGeometry(p.lon, p.lat, x.geometry));
      if (a) { p.admin1 = a.properties.code; p.admin1_name = a.properties.name; }
    }
  }
  function renest(bounds) {
    const polys = state.sites.filter(f => f.properties.area_m2 > 0 && bounds.contains([f.properties.lat, f.properties.lon]));
    for (const f of state.sites) {
      const p = f.properties;
      if (!bounds.contains([p.lat, p.lon])) continue;
      delete p.nested_in;
      for (const o of polys) {
        if (o === f || o.properties.area_m2 <= (p.area_m2 || 0)) continue;
        if (Geo.inGeometry(p.lon, p.lat, o.geometry)) { p.nested_in = o.properties.id; break; }
      }
    }
  }
  $('#live-refresh').onclick = async () => {
    const st = $('#live-status');
    if (map.getZoom() < 8) { st.textContent = 'Zoom in to level 8 or closer first.'; return; }
    const b = map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(x => x.toFixed(4)).join(',');
    const query = `[out:json][timeout:90];(${OVERPASS_STATEMENTS.map(s => `${s}(${bbox});`).join('')});out body geom qt;`;
    $('#live-refresh').disabled = true; st.textContent = 'Querying OpenStreetMap…';
    let data = null, err;
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: query }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        data = await r.json(); break;
      } catch (e) { err = e; }
    }
    $('#live-refresh').disabled = false;
    if (!data) { st.textContent = 'Overpass servers busy (' + err.message + '). Try again shortly.'; return; }
    const feats = data.elements.map(elementToFeature).filter(Boolean);
    await locateRegions(feats);
    let added = 0, updated = 0;
    for (const f of feats) {
      const old = state.byId.get(f.properties.id);
      if (old) { f.properties.green = old.properties.green; Object.assign(old, f); updated++; }
      else { state.sites.push(f); state.byId.set(f.properties.id, f); added++; }
    }
    renest(b);
    MEDIANS = medianAreas();
    st.textContent = `${feats.length} sites in view from OpenStreetMap: ${added} new, ${updated} refreshed (this session only).`;
    refreshAll();
  };

  // ------------------------------------------------------------ tabs, hash, refresh
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
    if (name === 'sites') renderList();
    if (name === 'calc') renderCalc();
  }
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

  function writeHash() {
    const c = map.getCenter();
    const h = `#map=${map.getZoom()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}` + (state.selected ? `&site=${state.selected}` : '');
    history.replaceState(null, '', h);
  }
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const m = (h.get('map') || '').split('/').map(Number);
    if (m.length === 3 && m.every(isFinite)) map.setView([m[1], m[2]], m[0]);
    if (h.get('site')) selectSite(h.get('site'), { noZoom: m.length === 3 });
  }

  function refreshAll() {
    renderHeadline(); renderStatusChips(); rebuildMarkers(); refreshFootprints(); renderOverview();
    if ($('#pane-sites').classList.contains('active')) renderList();
    if ($('#pane-calc').classList.contains('active')) renderCalc();
  }

  if (meta) $('#build-info').textContent = `Dataset built ${meta.built_utc} from OpenStreetMap as of ${meta.osm_base_utc || 'unknown'}: ${nf(meta.sites)} features, ${nf(meta.with_footprint)} with outlines, ${nf(meta.with_green)} with green-space measurements.`;
  buildRegionSelect();
  refreshAll();
  readHash();
  window.DCD = { state, map, renderCalc, selectSite }; // handy for console research
})();
