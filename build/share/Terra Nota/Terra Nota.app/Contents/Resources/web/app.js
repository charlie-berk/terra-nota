/*
 * Terra Nota: the map, the sidebar and the saved data.
 *
 * Saved data is plain JSON:
 *   { version: 1,
 *     countries: { NZL: { status: "lived", note: "..." } },
 *     states:    { USA: { "USA-california": "been" } } }
 *
 * Marking a state marks its country too: Been, or Lived for a Lived state. The
 * country keeps that mark if the state is later unmarked.
 */
(() => {
  'use strict';

  const WORLD = window.TN_WORLD;
  const STATES = window.TN_STATES;
  const { grid: GRID, cut: CUT } = WORLD;
  const PLACES = WORLD.countries;
  const CONTINENTS = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];

  const byId = new Map(PLACES.map(c => [c.id, c]));
  const stateById = new Map();
  for (const [countryId, group] of Object.entries(STATES)) {
    for (const s of group.list) {
      s.country = countryId;
      stateById.set(s.id, s);
    }
  }
  const selectable = PLACES.filter(c => c.kind !== 'land');
  const counted = PLACES.filter(c => c.kind === 'country');
  const labelled = selectable.slice().sort((a, b) => b.area - a.area);
  const landTotal = PLACES.reduce((sum, c) => sum + c.area, 0);

  const $ = selector => document.querySelector(selector);
  const esc = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const fold = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const byName = (a, b) => a.name.localeCompare(b.name, 'en');
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

  function flagOf(place) {
    if (!place.iso2) return '';
    return String.fromCodePoint(...[...place.iso2].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));
  }

  // ------------------------------------------------------------------ storage

  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tn;
  const STORAGE_KEY = 'terra-nota';

  function normalise(raw) {
    const clean = { version: 1, countries: {}, states: {} };
    if (!raw || typeof raw !== 'object' || typeof raw.countries !== 'object' || typeof raw.states !== 'object') {
      throw new Error('Not a Terra Nota file');
    }
    for (const [id, entry] of Object.entries(raw.countries || {})) {
      if (!entry || typeof entry !== 'object') continue;
      const kept = {};
      if (entry.status === 'been' || entry.status === 'lived') kept.status = entry.status;
      if (typeof entry.note === 'string' && entry.note) kept.note = entry.note;
      if (Object.keys(kept).length) clean.countries[id] = kept;
    }
    for (const [id, marks] of Object.entries(raw.states || {})) {
      if (!marks || typeof marks !== 'object') continue;
      const kept = {};
      for (const [stateId, status] of Object.entries(marks)) {
        if (status === 'been' || status === 'lived') kept[stateId] = status;
      }
      if (Object.keys(kept).length) clean.states[id] = kept;
    }
    // Files from before states marked their country.
    for (const [id, marks] of Object.entries(clean.states)) {
      for (const status of Object.values(marks)) raiseCountry(clean, id, status);
    }
    return clean;
  }

  const RANK = { been: 1, lived: 2 };

  // Brings a country's own mark up to at least `status`. Never lowers it.
  function raiseCountry(into, id, status) {
    const entry = into.countries[id] || {};
    if ((RANK[entry.status] || 0) >= RANK[status]) return;
    entry.status = status;
    into.countries[id] = entry;
  }

  function readSaved() {
    let text = null;
    if (bridge) text = window.__TN_SAVED__ || null;
    else {
      try { text = localStorage.getItem(STORAGE_KEY); } catch (_) { /* private window */ }
    }
    if (!text) return { version: 1, countries: {}, states: {} };
    try {
      return normalise(JSON.parse(text));
    } catch (_) {
      return { version: 1, countries: {}, states: {} };
    }
  }

  let data = readSaved();
  const undoStack = [];
  const redoStack = [];

  function persist() {
    const json = JSON.stringify(data, null, 2);
    if (bridge) bridge.postMessage({ op: 'save', json });
    else {
      try { localStorage.setItem(STORAGE_KEY, json); } catch (_) { /* private window */ }
    }
  }

  function change(mutate) {
    flushNote();
    undoStack.push(JSON.stringify(data));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    mutate();
    persist();
    refresh();
  }

  function travelInTime(from, to) {
    if (!from.length) return false;
    flushNote();
    to.push(JSON.stringify(data));
    data = JSON.parse(from.pop());
    persist();
    refresh();
    hideToast();
    return true;
  }

  const undo = () => travelInTime(undoStack, redoStack);
  const redo = () => travelInTime(redoStack, undoStack);

  // ----------------------------------------------------------------- statuses

  const marksIn = id => data.states[id] || {};
  const stateStatus = state => marksIn(state.country)[state.id] || null;

  function statusOf(id) {
    const own = data.countries[id] && data.countries[id].status;
    const marks = Object.values(marksIn(id));
    if (own === 'lived' || marks.includes('lived')) return 'lived';
    if (own === 'been' || marks.length) return 'been';
    return null;
  }

  function setOwnStatus(id, status) {
    const entry = data.countries[id] || {};
    if (status) entry.status = status;
    else delete entry.status;
    if (Object.keys(entry).length) data.countries[id] = entry;
    else delete data.countries[id];
  }

  function toggleCountry(id, status) {
    const place = byId.get(id);
    const before = fillOf(place);
    const clearing = statusOf(id) === status;
    const marks = Object.keys(marksIn(id)).length;
    change(() => {
      if (clearing) {
        setOwnStatus(id, null);
        delete data.states[id];
      } else {
        setOwnStatus(id, status);
        if (status === 'been') {
          for (const key of Object.keys(marksIn(id))) data.states[id][key] = 'been';
        }
      }
    });
    fades.set(id, { from: before, start: performance.now() });
    invalidate();
    if (clearing && marks) {
      const word = STATES[id].unit.split(' ')[0].toLowerCase();
      toast(`Cleared ${place.name} and ${marks} ${word}`, true);
    }
  }

  function toggleState(state, status) {
    const before = stateColor(state);
    const countryBefore = fillOf(byId.get(state.country));
    change(() => {
      const marks = data.states[state.country] || {};
      if (marks[state.id] === status) delete marks[state.id];
      else {
        marks[state.id] = status;
        raiseCountry(data, state.country, status);
      }
      if (Object.keys(marks).length) data.states[state.country] = marks;
      else delete data.states[state.country];
    });
    const start = performance.now();
    fades.set(state.id, { from: before, start });
    fades.set(state.country, { from: countryBefore, start });
    invalidate();
  }

  function tally() {
    const result = {
      countries: 0, territories: 0, lived: [], land: 0, states: 0,
      continents: new Set(), byContinent: Object.fromEntries(CONTINENTS.map(name => [name, { seen: 0, total: 0, extra: 0, extraSeen: 0 }])),
    };
    for (const place of selectable) {
      const status = statusOf(place.id);
      const bucket = result.byContinent[place.cont];
      if (place.kind === 'country') bucket.total++;
      else bucket.extra++;
      if (!status) continue;
      result.continents.add(place.cont);
      result.land += place.area;
      if (place.kind === 'country') {
        result.countries++;
        bucket.seen++;
        if (status === 'lived') result.lived.push(place);
      } else {
        result.territories++;
        bucket.extraSeen++;
      }
    }
    for (const marks of Object.values(data.states)) result.states += Object.keys(marks).length;
    return result;
  }

  // --------------------------------------------------------------- projection
  //
  // Equal Earth, centred on view.lam: the longitude in the middle of the screen.
  // Scrolling sideways changes view.lam, so the world turns under a fixed frame
  // and you can keep going round. Map units: one degree of longitude at the
  // equator. World space holds the whole map in [0, W] x [0, H], north up.

  const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
  const EE_M = Math.sqrt(3) / 2;
  const RAD = Math.PI / 180;
  const T_MAX = Math.PI / 3;

  function eeFactor(t) {
    const t2 = t * t, t6 = t2 * t2 * t2;
    return 2 * Math.sqrt(3) * Math.cos(t) / (3 * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  }

  function eeY(t) {
    const t2 = t * t, t6 = t2 * t2 * t2;
    return t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  }

  const F0 = eeFactor(0);
  const thetaOf = lat => Math.asin(EE_M * Math.sin(lat * RAD));
  const xScale = lat => eeFactor(thetaOf(lat)) / F0;      // map units per degree of longitude
  const yOf = lat => eeY(thetaOf(lat)) / RAD / F0;         // map units, north positive
  const W = 360;
  const H = 2 * yOf(90);
  const HALF_W = W / 2;
  const HALF_H = H / 2;
  const wyOf = lat => HALF_H - yOf(lat);
  // Equal-area, so one linear scale holds everywhere: map units per kilometre.
  const UNITS_PER_KM = Math.sqrt((yOf(.5) - yOf(-.5)) / 110.574 / 111.32);
  const HOME_LAM = 11;                                     // puts the edge in the Bering Strait
  const wrap = degrees => degrees - 360 * Math.floor((degrees + 180) / 360);

  function latOfWy(wy) {
    const target = clamp(HALF_H - wy, -HALF_H, HALF_H) * RAD * F0;
    let t = target / A1;
    for (let i = 0; i < 6; i++) {
      const t2 = t * t, t6 = t2 * t2 * t2;
      t -= (t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) - target) / (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2));
      t = clamp(t, -T_MAX, T_MAX);
    }
    return Math.asin(clamp(Math.sin(t) / EE_M, -1, 1)) / RAD;
  }

  // Stored points are on a 0.002 degree grid, so each grid row's scale and
  // height are worked out once.
  const ROWS = Math.round(180 / GRID);
  const ROW_SX = new Float32Array(ROWS + 1);
  const ROW_WY = new Float32Array(ROWS + 1);
  for (let row = 0; row <= ROWS; row++) {
    ROW_SX[row] = xScale(90 - row * GRID);
    ROW_WY[row] = wyOf(90 - row * GRID);
  }
  const POLE_WY = ROW_WY[ROWS - 5];

  // The map's edge: right side north to south, as [offset from centre, y].
  const EDGE = [];
  for (let lat = 90; lat >= -90; lat -= .5) EDGE.push([180 * xScale(lat), wyOf(lat)]);
  const OUTLINE = new Path2D();
  EDGE.forEach(([x, y], i) => (i ? OUTLINE.lineTo(HALF_W + x, y) : OUTLINE.moveTo(HALF_W + x, y)));
  for (let i = EDGE.length - 1; i >= 0; i--) OUTLINE.lineTo(HALF_W - EDGE[i][0], EDGE[i][1]);
  OUTLINE.closePath();

  // ------------------------------------------------------------------ geometry

  // "M12 34l5-6 7 8z..." on the grid -> typed arrays, ready to project.
  function decode(text) {
    const lon = [], sx = [], wy = [], rings = [];
    const n = text.length;
    let i = 0, x = 0, y = 0, relative = false, ring = null, first = null;
    while (i < n) {
      const ch = text.charCodeAt(i);
      if (ch === 77) {                       // M
        ring = { s: lon.length };
        relative = false;
        i++;
      } else if (ch === 108) {               // l
        relative = true;
        i++;
      } else if (ch === 122) {               // z
        ring.e = lon.length;
        if (ring.e - ring.s > 2) rings.push(ring);
        i++;
      } else if (ch === 32) {
        i++;
      } else {
        let sign = 1;
        if (ch === 45) {
          sign = -1;
          i++;
        }
        let value = 0, c;
        while (i < n && (c = text.charCodeAt(i)) >= 48 && c <= 57) {
          value = value * 10 + c - 48;
          i++;
        }
        value *= sign;
        if (first === null) {
          first = value;
          continue;
        }
        if (relative) {
          x += first;
          y += value;
        } else {
          x = first;
          y = value;
        }
        first = null;
        const row = clamp(y, 0, ROWS);
        lon.push(x * GRID + CUT);
        sx.push(ROW_SX[row]);
        wy.push(ROW_WY[row]);
      }
    }
    const geo = { lon: Float32Array.from(lon), sx: Float32Array.from(sx), wy: Float32Array.from(wy), rings, lam: NaN, path: null };
    for (const r of rings) {
      let lo = Infinity, hi = -Infinity, top = Infinity, bottom = -Infinity, sxLo = Infinity, sxHi = -Infinity;
      for (let j = r.s; j < r.e; j++) {
        const v = geo.lon[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        const w = geo.wy[j];
        if (w < top) top = w;
        if (w > bottom) bottom = w;
        const s = geo.sx[j];
        if (s < sxLo) sxLo = s;
        if (s > sxHi) sxHi = s;
      }
      Object.assign(r, { lo, hi, top, bottom, sxLo, sxHi });
      if (hi - lo >= 359) r.coast = polarCoast(geo, r);
    }
    return geo;
  }

  // Antarctica's ring runs once round the pole and closes along the pole line.
  // Keep its coast, in order of increasing longitude, so it can be re-cut
  // wherever the map's edge happens to be.
  function polarCoast(geo, ring) {
    const n = ring.e - ring.s;
    const onPole = j => geo.wy[ring.s + ((j % n) + n) % n] >= POLE_WY;
    let start = 0;
    for (let j = 0; j < n; j++) {
      if (onPole(j) && !onPole(j + 1)) {
        start = j + 1;
        break;
      }
    }
    const coast = [];
    for (let j = 0; j < n && !onPole(start + j); j++) coast.push(ring.s + (start + j) % n);
    if (coast.length > 1 && geo.lon[coast[0]] > geo.lon[coast[coast.length - 1]]) coast.reverse();
    return Int32Array.from(coast);
  }

  // Projects a shape for one centre longitude. A ring that runs over the edge is
  // split there, and the far part reappears on the other side.
  // Rings wholly outside `win` (a world-space box) are left out; geo.whole
  // records whether any were.
  function buildPath(geo, lam, win) {
    const path = new Path2D();
    geo.whole = true;
    for (const ring of geo.rings) {
      if (ring.coast) {
        addPolar(path, geo, ring, lam);
        continue;
      }
      const middle = (ring.lo + ring.hi) / 2;
      const off = wrap(middle - lam) - middle;
      const lo = ring.lo + off;
      const hi = ring.hi + off;
      if (lo >= -180 && hi <= 180) {
        const left = HALF_W + Math.min(lo * ring.sxLo, lo * ring.sxHi);
        const right = HALF_W + Math.max(hi * ring.sxLo, hi * ring.sxHi);
        if (ring.bottom < win[1] || ring.top > win[3] || right < win[0] || left > win[2]) {
          geo.whole = false;
          continue;
        }
        addRing(path, geo, ring, off);
      } else if (hi > 180) {
        addClipped(path, geo, ring, off, 180, false);
        addClipped(path, geo, ring, off - 360, -180, true);
      } else {
        addClipped(path, geo, ring, off, -180, true);
        addClipped(path, geo, ring, off + 360, 180, false);
      }
    }
    return path;
  }

  function addRing(path, geo, ring, off) {
    const { lon, sx, wy } = geo;
    path.moveTo(HALF_W + (lon[ring.s] + off) * sx[ring.s], wy[ring.s]);
    for (let i = ring.s + 1; i < ring.e; i++) path.lineTo(HALF_W + (lon[i] + off) * sx[i], wy[i]);
    path.closePath();
  }

  // Sutherland-Hodgman against one meridian, which is a straight line in
  // longitude, before projecting.
  function addClipped(path, geo, ring, off, edge, keepEast) {
    const { lon, sx, wy } = geo;
    let started = false;
    let p = ring.e - 1;
    let pr = lon[p] + off;
    let pin = keepEast ? pr >= edge : pr <= edge;
    for (let i = ring.s; i < ring.e; i++) {
      const r = lon[i] + off;
      const inside = keepEast ? r >= edge : r <= edge;
      if (inside !== pin) {
        const t = (edge - pr) / (r - pr);
        const x = HALF_W + edge * (sx[p] + t * (sx[i] - sx[p]));
        const y = wy[p] + t * (wy[i] - wy[p]);
        if (started) path.lineTo(x, y);
        else {
          path.moveTo(x, y);
          started = true;
        }
      }
      if (inside) {
        const x = HALF_W + r * sx[i];
        if (started) path.lineTo(x, wy[i]);
        else {
          path.moveTo(x, wy[i]);
          started = true;
        }
      }
      p = i;
      pr = r;
      pin = inside;
    }
    if (started) path.closePath();
  }

  function addPolar(path, geo, ring, lam) {
    const { lon, sx, wy } = geo;
    const coast = ring.coast;
    const n = coast.length;
    if (n < 2) return;
    const base = lon[coast[0]];
    const edge = base + (((lam + 180 - base) % 360) + 360) % 360;   // the antimeridian, in the coast's frame
    let j = -1, t = 0;
    for (let q = 0; q < n; q++) {
      const a = lon[coast[q]];
      const b = q + 1 < n ? lon[coast[q + 1]] : lon[coast[0]] + 360;
      if ((a <= edge && edge < b) || (b <= edge && edge < a)) {
        j = q;
        t = (edge - a) / (b - a);
        break;
      }
    }
    if (j < 0) return;
    const i1 = coast[j], i2 = coast[(j + 1) % n];
    const cy = wy[i1] + t * (wy[i2] - wy[i1]);
    const cs = sx[i1] + t * (sx[i2] - sx[i1]);
    const off = -edge - 180;
    path.moveTo(HALF_W - 180 * cs, cy);
    for (let q = j + 1; q < n; q++) path.lineTo(HALF_W + (lon[coast[q]] + off) * sx[coast[q]], wy[coast[q]]);
    for (let q = 0; q <= j; q++) path.lineTo(HALF_W + (lon[coast[q]] + off + 360) * sx[coast[q]], wy[coast[q]]);
    path.lineTo(HALF_W + 180 * cs, cy);
    // Down the right-hand edge, back along the pole line, up the left-hand edge.
    for (const [x, y] of EDGE) if (y > cy) path.lineTo(HALF_W + x, y);
    for (let i = EDGE.length - 1; i >= 0; i--) if (EDGE[i][1] > cy) path.lineTo(HALF_W - EDGE[i][0], EDGE[i][1]);
    path.closePath();
  }

  function geoOf(item, level) {
    item.geo = item.geo || [];
    if (item.geo[level] === undefined) item.geo[level] = item.paths[level] ? decode(item.paths[level]) : null;
    return item.geo[level];
  }

  // A shape's path for the current turn of the globe. Zoomed in, the parts
  // far off screen are skipped, which keeps turning smooth; the path is
  // rebuilt if the view later moves beyond what it covers.
  const onScreen = [0, 0, 0, 0];
  const onScreenFor = [NaN, NaN, NaN, NaN, NaN];

  function pathOf(item, level) {
    const geo = geoOf(item, level);
    if (!geo) return null;
    const { k, x, y } = view;
    if (k !== onScreenFor[0] || x !== onScreenFor[1] || y !== onScreenFor[2] || stageW !== onScreenFor[3] || stageH !== onScreenFor[4]) {
      onScreenFor[0] = k; onScreenFor[1] = x; onScreenFor[2] = y; onScreenFor[3] = stageW; onScreenFor[4] = stageH;
      onScreen[0] = -x / k; onScreen[1] = -y / k; onScreen[2] = (stageW - x) / k; onScreen[3] = (stageH - y) / k;
    }
    const stale = geo.lam !== view.lam || (!geo.whole &&
      (onScreen[0] < geo.win[0] || onScreen[1] < geo.win[1] || onScreen[2] > geo.win[2] || onScreen[3] > geo.win[3]));
    if (stale) {
      const padX = (onScreen[2] - onScreen[0]) * .6;
      const padY = (onScreen[3] - onScreen[1]) * .6;
      geo.win = [onScreen[0] - padX, onScreen[1] - padY, onScreen[2] + padX, onScreen[3] + padY];
      geo.path = buildPath(geo, view.lam, geo.win);
      geo.lam = view.lam;
    }
    return geo.path;
  }

  const statePath = (state, level) => pathOf(state, level === 2 ? 1 : 0);

  // A [west, south, east, north] box -> world-space box at the current centre.
  function boxOf(item) {
    if (item.boxLam === view.lam) return item.box;
    const [w, s, e, n] = item.bbox;
    const middle = (w + e) / 2;
    const off = wrap(middle - view.lam) - middle;
    const lo = w + off;
    const hi = e + off;
    const nearest = s > 0 ? s : n < 0 ? n : 0;
    const gHi = xScale(nearest);
    const gLo = xScale(Math.abs(s) > Math.abs(n) ? s : n);
    let x0, x1;
    if (lo < -180 || hi > 180) {
      x0 = -180 * gHi;
      x1 = 180 * gHi;
    } else {
      x0 = lo < 0 ? lo * gHi : lo * gLo;
      x1 = hi > 0 ? hi * gHi : hi * gLo;
    }
    item.box = [HALF_W + x0, wyOf(n), HALF_W + x1, wyOf(s)];
    item.boxLam = view.lam;
    return item.box;
  }

  // Where an item's name is anchored, in world space.
  function anchorOf(item) {
    if (item.anchorLam !== view.lam) {
      item.anchor = [HALF_W + wrap(item.lx - view.lam) * xScale(item.ly), wyOf(item.ly)];
      item.anchorLam = view.lam;
    }
    return item.anchor;
  }

  function lonLatAt(px, py) {
    const lat = latOfWy((py - view.y) / view.k);
    const rel = ((px - view.x) / view.k - HALF_W) / Math.max(xScale(lat), .01);
    return [wrap(rel + view.lam), lat];
  }

  function onMap(px, py) {
    const wy = (py - view.y) / view.k;
    if (wy < 0 || wy > H) return false;
    return Math.abs((px - view.x) / view.k - HALF_W) <= 180 * xScale(latOfWy(wy));
  }

  function screenOf(lon, lat) {
    return [(HALF_W + wrap(lon - view.lam) * xScale(lat)) * view.k + view.x, wyOf(lat) * view.k + view.y];
  }

  // ------------------------------------------------------------------- camera

  const canvas = $('#map');
  const stage = $('#stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const view = { k: 1, lam: HOME_LAM, x: 0, y: 0 };
  let stageW = 0;
  let stageH = 0;
  let dpr = 1;
  let flight = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const MARGIN = 18;

  const baseK = () => Math.min((stageW - MARGIN * 2) / W, (stageH - MARGIN * 2) / H);
  const maxK = () => baseK() * 500;

  // Sideways is the centre longitude, so there's nothing to clamp: it goes round.
  function settle() {
    view.k = clamp(view.k, baseK(), maxK());
    view.lam = wrap(view.lam);
    view.x = stageW / 2 - HALF_W * view.k;
    const mapH = H * view.k;
    // Zoomed in, the top and bottom edges may come a third of the way in, so
    // places near them (Russia, Antarctica) can still sit in the middle.
    const slack = Math.max(MARGIN, stageH * .36);
    view.y = mapH <= stageH - MARGIN * 2 ? (stageH - mapH) / 2 : clamp(view.y, stageH - mapH - slack, slack);
    noteMove();
  }

  // How many degrees of longitude one pixel is, at a screen height.
  function degreesPerPixel(py) {
    const lat = latOfWy((py - view.y) / view.k);
    return 1 / (view.k * Math.max(xScale(lat), .45));
  }

  function panBy(dx, dy, py = stageH / 2) {
    view.lam -= dx * degreesPerPixel(py);
    view.y += dy;
    settle();
    invalidate();
  }

  function zoomAt(px, py, k) {
    const next = clamp(k, baseK(), maxK());
    const perPixel = degreesPerPixel(py);
    view.lam += (px - stageW / 2) * perPixel * (1 - view.k / next);
    view.y = py - (py - view.y) * (next / view.k);
    view.k = next;
    settle();
    invalidate();
  }

  function flyTo(k, lam, cy, duration = 620) {
    flight = null;
    k = clamp(k, baseK(), maxK());
    if (reducedMotion.matches || duration === 0) {
      view.k = k;
      view.lam = lam;
      view.y = stageH / 2 - cy * k;
      settle();
      invalidate();
      return;
    }
    const from = { k: view.k, lam: view.lam, cy: (stageH / 2 - view.y) / view.k };
    flight = { from, to: { k, turn: wrap(lam - view.lam), cy }, start: performance.now(), duration };
    invalidate();
  }

  function flyToBox(box, padding = 56) {
    const [w, s, e, n] = box;
    const nearest = s > 0 ? s : n < 0 ? n : 0;
    const width = Math.max((e - w) * xScale(nearest), .01);
    const top = wyOf(n);
    const bottom = wyOf(s);
    const k = Math.min((stageW - padding * 2) / width, (stageH - padding * 2) / Math.max(bottom - top, .01));
    flyTo(clamp(k, baseK(), baseK() * 220), (w + e) / 2, (top + bottom) / 2);
  }

  const flyHome = (lam = view.lam) => flyTo(baseK(), lam, HALF_H);

  function stepFlight(now) {
    if (!flight) return;
    const t = clamp((now - flight.start) / flight.duration, 0, 1);
    const eased = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const { from, to } = flight;
    const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * eased);
    view.k = k;
    view.lam = from.lam + to.turn * eased;
    view.y = stageH / 2 - (from.cy + (to.cy - from.cy) * eased) * k;
    settle();
    if (t >= 1) flight = null;
  }

  // ------------------------------------------------------------------ drawing

  let palette = {};
  let scheduled = false;
  let focusId = null;
  let focusFade = 0;
  let lastFrame = 0;
  let hover = null;      // { type: 'country'|'state', id }
  let cardTarget = null; // { type, id, lon, lat }
  let dots = [];
  const fades = new Map();

  function readPalette() {
    const css = getComputedStyle(document.documentElement);
    const read = name => css.getPropertyValue(name).trim();
    palette = {
      sea: read('--sea'), seaLine: read('--sea-line'), coast: read('--coast'), land: read('--land'),
      border: read('--border'), inner: read('--inner'), label: read('--label'), seaLabel: read('--sea-label'),
      been: read('--been'), lived: read('--lived'), beenSoft: read('--been-soft'), livedSoft: read('--lived-soft'),
      onMark: read('--on-mark'), ink: read('--ink'), paper: read('--paper'), frame: read('--frame'),
    };
  }

  function invalidate() {
    if (scheduled) return;
    lastFrame = performance.now();
    scheduled = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    scheduled = false;
    stepFlight(now);
    const target = focusId ? 1 : 0;
    const step = Math.max(0, now - lastFrame) / 260;
    lastFrame = now;
    focusFade = target > focusFade ? Math.min(target, focusFade + step) : Math.max(target, focusFade - step);
    draw(now);
    const fadingIn = leaders && now - leaders.born < 240;
    if (flight || focusFade !== target || fades.size || fadingIn) invalidate();
  }

  // Which of the three baked levels of detail suits this zoom.
  function levelFor(k) {
    const devicePxPerDegree = k * dpr;
    if (devicePxPerDegree < 9) return 0;
    return devicePxPerDegree < 36 ? 1 : 2;
  }

  function fillOf(place) {
    const status = statusOf(place.id);
    return status ? palette[status] : palette.land;
  }

  function stateColor(state) {
    const own = stateStatus(state);
    if (own) return palette[own];
    const status = statusOf(state.country);
    if (!status) return palette.land;
    return status === 'lived' ? palette.livedSoft : palette.beenSoft;
  }

  function paint(path, key, color, now) {
    const fade = fades.get(key);
    if (fade) {
      const t = clamp((now - fade.start) / 240, 0, 1);
      ctx.fillStyle = fade.from;
      ctx.fill(path, 'evenodd');
      ctx.globalAlpha = t;
      if (t >= 1) fades.delete(key);
    }
    ctx.fillStyle = color;
    ctx.fill(path, 'evenodd');
    ctx.globalAlpha = 1;
  }

  const toWorldSpace = () => ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
  const toScreenSpace = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  function draw(now = performance.now()) {
    const { k, x, y } = view;
    const level = levelFor(k);
    const left = -x / k;
    const top = -y / k;
    const right = left + stageW / k;
    const bottom = top + stageH / k;
    const inView = box => box[2] >= left && box[0] <= right && box[3] >= top && box[1] <= bottom;
    const visible = PLACES.filter(place => inView(boxOf(place)));

    toScreenSpace();
    ctx.fillStyle = palette.paper;
    ctx.fillRect(0, 0, stageW, stageH);

    toWorldSpace();
    ctx.fillStyle = palette.sea;
    ctx.fill(OUTLINE);
    drawGraticule();
    ctx.save();
    ctx.clip(OUTLINE);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Old atlases shade the water along every coast. Two soft strokes under the land do the same.
    if (k < baseK() * 10) {
      ctx.strokeStyle = palette.coast;
      for (const [width, alpha] of [[6, .12], [3, .2]]) {
        ctx.lineWidth = width / k;
        ctx.globalAlpha = alpha;
        for (const place of visible) {
          const path = pathOf(place, level);
          if (path) ctx.stroke(path);
        }
      }
      ctx.globalAlpha = 1;
    }

    for (const place of visible) {
      const path = pathOf(place, level);
      if (path) paint(path, place.id, fillOf(place), now);
    }

    ctx.strokeStyle = palette.border;
    ctx.lineWidth = .6 / k;
    for (const place of visible) {
      const path = pathOf(place, level);
      if (path) ctx.stroke(path);
    }

    if (focusFade > 0) {
      ctx.globalAlpha = .46 * focusFade;
      ctx.fillStyle = palette.paper;
      ctx.fill(OUTLINE);
      ctx.globalAlpha = 1;
    }

    const focused = focusId && byId.get(focusId);
    if (focused) {
      const countryPath = pathOf(focused, 2);
      const group = STATES[focused.id];
      paint(countryPath, focused.id, group ? stateBase(focused) : fillOf(focused), now);
      if (group) {
        for (const state of group.list) {
          if (inView(boxOf(state))) paint(statePath(state, level), state.id, stateColor(state), now);
        }
        ctx.strokeStyle = palette.inner;
        ctx.lineWidth = .7 / k;
        for (const state of group.list) {
          if (inView(boxOf(state))) ctx.stroke(statePath(state, level));
        }
      }
      ctx.strokeStyle = palette.border;
      ctx.lineWidth = 1.1 / k;
      ctx.stroke(countryPath);
    }

    outline(hover, level, .9, true);
    if (cardTarget && !same(cardTarget, hover)) outline(cardTarget, level, 1, false);
    ctx.restore();

    ctx.strokeStyle = palette.frame;
    ctx.lineWidth = 1 / k;
    ctx.stroke(OUTLINE);

    toScreenSpace();
    drawDots(level, left, top, right, bottom);
    drawLabels(visible, level, now);
    placeCard();
  }

  function stateBase(place) {
    const status = statusOf(place.id);
    if (!status) return palette.land;
    return status === 'lived' ? palette.livedSoft : palette.beenSoft;
  }

  const same = (a, b) => !!a && !!b && a.type === b.type && a.id === b.id;

  function outline(target, level, width, tinted) {
    if (!target) return;
    const path = target.type === 'state'
      ? statePath(stateById.get(target.id), level)
      : pathOf(byId.get(target.id), level) || pathOf(byId.get(target.id), 2);
    if (!path) return;
    if (tinted) {
      ctx.globalAlpha = .1;
      ctx.fillStyle = palette.ink;
      ctx.fill(path, 'evenodd');
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = .75;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = width / view.k;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
  }

  const GRATICULE_LATS = [];
  for (let lat = -90; lat <= 90; lat += 2) GRATICULE_LATS.push([xScale(lat), wyOf(lat)]);

  function drawGraticule() {
    ctx.strokeStyle = palette.seaLine;
    ctx.lineWidth = 1 / view.k;
    ctx.beginPath();
    for (let meridian = -180; meridian < 180; meridian += 30) {
      const rel = wrap(meridian - view.lam);
      if (Math.abs(rel) > 179.5) continue;              // that one is the map's edge
      GRATICULE_LATS.forEach(([scale, y], i) => (i ? ctx.lineTo(HALF_W + rel * scale, y) : ctx.moveTo(HALF_W + rel * scale, y)));
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const half = 180 * xScale(lat);
      ctx.moveTo(HALF_W - half, wyOf(lat));
      ctx.lineTo(HALF_W + half, wyOf(lat));
    }
    ctx.stroke();
  }

  function drawDots(level, left, top, right, bottom) {
    const { k, x, y } = view;
    const pxPerKm = k * UNITS_PER_KM;
    dots = [];
    for (const place of selectable) {
      if (Math.sqrt(place.area) * pxPerKm >= 3 && place.paths[level]) continue;
      const [ax, ay] = anchorOf(place);
      if (ax < left || ax > right || ay < top || ay > bottom) continue;
      dots.push({ place, x: ax * k + x, y: ay * k + y, status: statusOf(place.id) });
    }
    dots.sort((a, b) => (a.status ? 1 : 0) - (b.status ? 1 : 0));
    for (const dot of dots) {
      const active = (hover && hover.id === dot.place.id) || (cardTarget && cardTarget.id === dot.place.id);
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, active ? 4.4 : dot.status ? 2.9 : 2, 0, Math.PI * 2);
      ctx.fillStyle = dot.status ? palette[dot.status] : palette.land;
      ctx.fill();
      ctx.lineWidth = active ? 1.3 : .9;
      ctx.strokeStyle = active ? palette.ink : dot.status ? palette.land : palette.border;
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------------- labels
  //
  // A name sits inside its shape when it fits there. When it doesn't, and the
  // map is still, it moves out to open water if it can, with a thin leader line
  // back to a dot on the shape. While the map moves only the inside names show.

  const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';
  const FONTS = {
    country: `600 9.5px ${SANS}`,
    state: `500 11px ${SANS}`,
    leaderCountry: `600 9px ${SANS}`,
    leaderState: `500 10.5px ${SANS}`,
    sea: 'italic 11.5px "Iowan Old Style", Palatino, Georgia, serif',
  };
  const tracked = (text, space) => [...text].join(space);
  const countryText = place => tracked(place.name.toUpperCase(), ' ');
  const IDLE_MS = 160;
  const textWidths = new Map();
  let leaders = null;       // { items, born } once the map has been still a moment
  let lastMove = 0;
  let idleTimer = null;
  let maskCanvas = null;

  function noteMove() {
    lastMove = performance.now();
    leaders = null;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(invalidate, IDLE_MS + 20);
  }

  function textWidth(text, font) {
    const key = `${font}\n${text}`;
    let width = textWidths.get(key);
    if (width === undefined) {
      ctx.font = font;
      width = ctx.measureText(text).width;
      textWidths.set(key, width);
    }
    return width;
  }

  function writeLabel(text, cx, cy, font, fill, halo) {
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (halo) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = halo;
      ctx.strokeText(text, cx, cy);
    }
    ctx.fillStyle = fill;
    ctx.fillText(text, cx, cy);
  }

  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

  function lineCrosses(x1, y1, x2, y2, r) {
    for (let t = .2; t <= 1.001; t += .1) {
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      if (x > r[0] && x < r[2] && y > r[1] && y < r[3]) return true;
    }
    return false;
  }

  // Does a label's box sit inside the shape? Its middle and the middle of each
  // side must; a corner or two may poke out, since the text's halo keeps it
  // readable. Checked in world space.
  function fitsInside(path, cx, cy, w, h) {
    const hw = w / 2 + 2;
    const hh = h / 2 + 1;
    const inside = (dx, dy) => ctx.isPointInPath(path, (cx + dx) * dpr, (cy + dy) * dpr, 'evenodd');
    for (const [dx, dy] of [[0, 0], [-hw, 0], [hw, 0], [0, -hh], [0, hh]]) if (!inside(dx, dy)) return false;
    let corners = 0;
    for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) if (inside(dx, dy)) corners++;
    return corners >= 2;
  }

  function statesByArea(countryId) {
    const group = STATES[countryId];
    group.byArea = group.byArea || group.list.slice().sort((a, b) => b.area - a.area);
    return group.byArea;
  }

  // Small shifts to try, as fractions of the label's width and height, before
  // deciding a name doesn't fit and needs a leader line.
  const NUDGES = [[0, 0], [-.2, 0], [.2, 0], [0, -.7], [0, .7], [-.35, 0], [.35, 0], [-.2, -.7], [.2, -.7], [-.2, .7], [.2, .7]];
  let labelLayout = null;

  function layoutInside(visible, level, thorough, key) {
    const { k, x, y } = view;
    const group = focusId && STATES[focusId];
    const shown = new Set(visible);
    const pxPerKm = k * UNITS_PER_KM;
    const placed = [];
    const inside = [];
    const misses = [];
    const candidates = [];
    if (group) for (const state of statesByArea(focusId)) candidates.push([state, 'state']);
    for (const place of labelled) {
      if (shown.has(place) && !(group && place.id === focusId)) candidates.push([place, 'country']);
    }
    toWorldSpace();
    for (const [item, type] of candidates) {
      if (inside.length >= 90) break;
      const [wx, wy] = anchorOf(item);
      const ax = wx * k + x;
      const ay = wy * k + y;
      if (ax < -60 || ax > stageW + 60 || ay < -20 || ay > stageH + 20) continue;
      const text = type === 'state' ? item.name : countryText(item);
      const font = type === 'state' ? FONTS.state : FONTS.country;
      const w = textWidth(text, font);
      const h = type === 'state' ? 12 : 11;
      const r = item.room * pxPerKm;
      const path = type === 'state' ? statePath(item, level) : pathOf(item, level);
      if (!path || r * 2 < h * .8) {
        misses.push({ item, type, ax, ay, r });
        continue;
      }
      const roomy = r * r >= (w / 2 + 2) ** 2 + (h / 2 + 1) ** 2;
      let fitsSomewhere = false;
      let spot = null;
      for (const [fx, fy] of thorough ? NUDGES : [[0, 0]]) {
        const cx = ax + fx * w;
        const cy = ay + fy * h;
        if (!(roomy && !fx && !fy) && !fitsInside(path, cx, cy, w, h)) continue;
        fitsSomewhere = true;
        const rect = [cx - w / 2 - 2, cy - h / 2 - 1, cx + w / 2 + 2, cy + h / 2 + 1];
        if (rect[0] < 0 || rect[2] > stageW || rect[1] < 0 || rect[3] > stageH) continue;
        if (placed.some(o => overlaps(rect, o))) continue;
        spot = { rect, cx, cy };
        break;
      }
      if (spot) {
        placed.push(spot.rect);
        inside.push({ item, type, text, font, ax: spot.cx, ay: spot.cy });
      } else if (!fitsSomewhere || type === 'state') {
        misses.push({ item, type, ax, ay, r });     // a state crowded out by a neighbour's name tries a leader
      }
    }
    return { key, inside, misses, placed };
  }

  function drawLabels(visible, level, now) {
    const idle = !flight && !(press && press.moved) && now - lastMove >= IDLE_MS;
    const key = [view.k, view.lam, view.y, focusId, stageW, stageH, idle].join('|');
    if (!labelLayout || labelLayout.key !== key) labelLayout = layoutInside(visible, level, idle, key);
    const placed = labelLayout.placed.slice();
    if (idle && !leaders) leaders = layoutLeaders(labelLayout.misses, placed, visible, level, now);
    else if (leaders) for (const item of leaders.items) placed.push(item.rect, item.dot);

    toScreenSpace();
    for (const label of labelLayout.inside) {
      const { item, type } = label;
      let fill = palette.label;
      let halo = palette.land;
      if (type === 'state') {
        const own = stateStatus(item);
        if (own) {
          fill = palette.onMark;
          halo = palette[own];
        } else halo = stateColor(item);
      } else {
        const status = statusOf(item.id);
        if (status) {
          fill = palette.onMark;
          halo = palette[status];
        }
      }
      ctx.globalAlpha = type === 'country' && focusId && item.id !== focusId ? .55 : 1;
      writeLabel(label.text, label.ax, label.ay, label.font, fill, halo);
    }
    ctx.globalAlpha = 1;
    if (leaders) drawLeaders(leaders.items, clamp((now - leaders.born) / 200, 0, 1));
    drawSeaLabels(placed);
  }

  function uiRects() {
    const base = stage.getBoundingClientRect();
    return ['#zoom', '#legend', '#card'].map(selector => $(selector)).filter(el => el && !el.hidden).map(el => {
      const r = el.getBoundingClientRect();
      return [r.left - base.left - 6, r.top - base.top - 6, r.right - base.left + 6, r.bottom - base.top + 6];
    });
  }

  // Land, and anywhere off the map, drawn small so open water can be looked up.
  function landMask(visible, level) {
    const scale = 1 / 3;
    const w = Math.max(1, Math.ceil(stageW * scale));
    const h = Math.max(1, Math.ceil(stageH * scale));
    maskCanvas = maskCanvas || document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    const m = maskCanvas.getContext('2d', { willReadFrequently: true });
    m.fillStyle = '#f00';                 // off the map
    m.fillRect(0, 0, w, h);
    m.setTransform(view.k * scale, 0, 0, view.k * scale, view.x * scale, view.y * scale);
    m.globalCompositeOperation = 'destination-out';
    m.fill(OUTLINE);
    m.globalCompositeOperation = 'source-over';
    m.fillStyle = '#00f';                 // land
    const own = focusId && STATES[focusId] ? byId.get(focusId) : null;
    for (const place of visible) {
      const path = place !== own && pathOf(place, level);
      if (path) m.fill(path, 'evenodd');
    }
    m.fillStyle = '#0f0';                 // the open country, whose states the names belong to
    if (own) m.fill(pathOf(own, level), 'evenodd');
    return { w, h, scale, data: m.getImageData(0, 0, w, h).data };
  }

  // [share of a box that's land, share that's the open country], or null if
  // any of it is off the map.
  function landShare(mask, rect) {
    let land = 0;
    let own = 0;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        const mx = ((rect[0] + (rect[2] - rect[0]) * (i + .5) / 6) * mask.scale) | 0;
        const my = ((rect[1] + (rect[3] - rect[1]) * (j + .5) / 3) * mask.scale) | 0;
        if (mx < 0 || my < 0 || mx >= mask.w || my >= mask.h) return null;
        const at = (my * mask.w + mx) * 4;
        if (mask.data[at] > 128) return null;
        if (mask.data[at + 1] > 128) own++;
        else if (mask.data[at + 2] > 128) land++;
      }
    }
    return [(land + own) / 18, own / 18];
  }

  function segmentsCross(a, b) {
    const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return side(a[0], a[1], b[0]) !== side(a[0], a[1], b[1]) && side(b[0], b[1], a[0]) !== side(b[0], b[1], a[1]);
  }

  // [dx, dy, cost]: sideways first, then slanting, then the diagonals, then
  // straight up or down.
  const DIRECTIONS = [
    [1, 0, 0], [-1, 0, .15], [.95, -.3, .2], [.95, .3, .2], [-.95, -.3, .3], [-.95, .3, .3],
    [.8, -.6, .3], [.8, .6, .3], [-.8, -.6, .4], [-.8, .6, .4], [0, -1, .7], [0, 1, .7],
  ];

  // Out in open water if possible. In a country's view, over a neighbour will
  // do, but never on top of the country's own states, where a name would read
  // as belonging to the wrong one.
  function findSpot(miss, w, h, placed, blocked, lines, mask, inCountry, home) {
    const reach = Math.max(miss.r, 1.5);
    const maxLand = inCountry ? 1 : .25;
    let best = null;
    for (const gap of inCountry ? [8, 16, 28, 44, 64, 88] : [8, 16, 28, 44]) {
      for (const [dx, dy, cost] of DIRECTIONS) {
        const ex = miss.ax + dx * (reach + gap);
        const ey = miss.ay + dy * (reach + gap);
        const left = dx > .3 ? ex + 3 : dx < -.3 ? ex - 3 - w : ex - w / 2;
        const top = dy > .3 ? ey + 1 : dy < -.3 ? ey - 1 - h : ey - h / 2;
        const rect = [left - 2, top - 1, left + w + 2, top + h + 1];
        if (rect[0] < 4 || rect[1] < 4 || rect[2] > stageW - 4 || rect[3] > stageH - 4) continue;
        if (placed.some(o => overlaps(rect, o)) || blocked.some(o => overlaps(rect, o))) continue;
        if (placed.some(o => lineCrosses(miss.ax, miss.ay, ex, ey, o))) continue;
        const line = [[miss.ax, miss.ay], [ex, ey]];
        if (lines.some(o => segmentsCross(line, o))) continue;
        const share = landShare(mask, rect);
        if (!share) continue;
        const [land, own] = share;
        if (land > maxLand || own > .06) continue;
        const across = home ? crossesNeighbours(mask, home, miss.ax, miss.ay, ex, ey) : 0;
        if (across > .2) continue;
        const score = land * (inCountry ? .6 : 3) + own * 6 + across * 8 + gap / 30 + cost;
        if (!best || score < best.score) best = { score, land, rect, line, ex, ey, tx: left + w / 2, ty: top + h / 2 };
      }
      if (best && best.land < .1) break;
    }
    return best;
  }

  // How much of a leader line runs over the open country's other states.
  function crossesNeighbours(mask, home, x1, y1, x2, y2) {
    let over = 0;
    for (let i = 1; i <= 10; i++) {
      const x = x1 + (x2 - x1) * i / 10;
      const y = y1 + (y2 - y1) * i / 10;
      const at = (((y * mask.scale) | 0) * mask.w + ((x * mask.scale) | 0)) * 4;
      if (mask.data[at + 1] > 128 && !ctx.isPointInPath(home, x * dpr, y * dpr, 'evenodd')) over++;
    }
    return over / 10;
  }

  // A state boxed in by its neighbours, such as Berlin or Delhi, can't reach
  // open space. It gets a dot with its name beside it, the way a map names a
  // city.
  function enclosed(mask, miss) {
    let own = 0;
    for (const radius of [miss.r + 6, miss.r + 14]) {
      for (let i = 0; i < 12; i++) {
        const x = miss.ax + Math.cos(i * Math.PI / 6) * radius;
        const y = miss.ay + Math.sin(i * Math.PI / 6) * radius;
        const mx = (x * mask.scale) | 0;
        const my = (y * mask.scale) | 0;
        if (mx >= 0 && my >= 0 && mx < mask.w && my < mask.h && mask.data[(my * mask.w + mx) * 4 + 1] > 128) own++;
      }
    }
    return own >= 23;
  }

  function pointSpot(miss, w, h, placed, blocked, lines, level) {
    const { ax, ay } = miss;
    for (const [left, top] of [[ax + 5, ay - h / 2], [ax - 5 - w, ay - h / 2], [ax - w / 2, ay - 5 - h], [ax - w / 2, ay + 5]]) {
      const rect = [left - 2, top - 1, left + w + 2, top + h + 1];
      if (rect[0] < 4 || rect[1] < 4 || rect[2] > stageW - 4 || rect[3] > stageH - 4) continue;
      if (placed.some(o => overlaps(rect, o)) || blocked.some(o => overlaps(rect, o))) continue;
      if (lines.some(([a, b]) => lineCrosses(a[0], a[1], b[0], b[1], rect))) continue;
      const tx = left + w / 2;
      const ty = top + h / 2;
      const spot = { point: true, land: 1, rect, line: [[ax, ay], [ax, ay]], ex: ax, ey: ay, tx, ty };
      const under = STATES[focusId].list.find(state => state !== miss.item && ctx.isPointInPath(statePath(state, level), tx * dpr, ty * dpr, 'evenodd'));
      if (under) {
        const status = stateStatus(under);
        spot.halo = status ? palette[status] : stateColor(under);
        spot.fill = status ? palette.onMark : palette.label;
      }
      return spot;
    }
    return null;
  }

  // How big the open country's main part is on screen, in pixels.
  function focusSpan() {
    const [w, s, e, n] = byId.get(focusId).focus;
    return Math.max((e - w) * xScale((s + n) / 2), wyOf(s) - wyOf(n)) * view.k;
  }

  function layoutLeaders(misses, placed, visible, level, now) {
    const inCountry = !!(focusId && STATES[focusId]);
    if (inCountry && focusSpan() < 280) return { items: [], born: now };   // zoomed too far out for state names
    const cap = inCountry ? 40 : 22;
    const minSize = inCountry ? 2 : 6;
    const blocked = uiRects();
    const items = [];
    const lines = [];
    let mask = null;
    // A country's smallest states have the fewest places to put a name, so
    // they choose first. On the world map the biggest countries go first.
    if (inCountry) misses = misses.slice().sort((a, b) => a.item.area - b.item.area);
    toWorldSpace();
    const add = (miss, spot, text, font) => {
      const dot = [miss.ax - 3, miss.ay - 3, miss.ax + 3, miss.ay + 3];
      placed.push(spot.rect, dot);
      lines.push(spot.line);
      items.push({ ...miss, ...spot, text, font, dot });
    };
    const boxedIn = [];
    for (const miss of misses) {
      if (items.length >= cap) break;
      if (focusId && miss.type === 'country') continue;      // neighbours only get names that fit
      if (miss.ax < 0 || miss.ax > stageW || miss.ay < 0 || miss.ay > stageH) continue;
      const box = boxOf(miss.item);
      if (Math.max(box[2] - box[0], box[3] - box[1]) * view.k < minSize) continue;
      mask = mask || landMask(visible, level);
      const text = miss.type === 'state' ? miss.item.name : countryText(miss.item);
      const font = miss.type === 'state' ? FONTS.leaderState : FONTS.leaderCountry;
      const home = inCountry && miss.type === 'state' ? statePath(miss.item, level) : null;
      const w = textWidth(text, font);
      const spot = findSpot(miss, w, 11, placed, blocked, lines, mask, inCountry, home);
      if (spot) add(miss, spot, text, font);
      else if (home && miss.r < 14) boxedIn.push([miss, w, text, font]);
    }
    // Leaders choose first, so a dot label never takes a coastal state's spot.
    for (const [miss, w, text, font] of boxedIn) {
      if (items.length >= cap) break;
      const spot = enclosed(mask, miss) && pointSpot(miss, w, 11, placed, blocked, lines, level);
      if (spot) add(miss, spot, text, font);
    }
    return { items, born: now };
  }

  function drawLeaders(items, alpha) {
    ctx.lineWidth = .8;
    ctx.strokeStyle = palette.label;
    ctx.globalAlpha = alpha * .65;
    ctx.beginPath();
    for (const item of items) {
      ctx.moveTo(item.ax, item.ay);
      ctx.lineTo(item.ex, item.ey);
    }
    ctx.stroke();
    ctx.globalAlpha = alpha;
    for (const item of items) {
      const status = item.type === 'state' ? stateStatus(item.item) : statusOf(item.item.id);
      ctx.beginPath();
      ctx.arc(item.ax, item.ay, item.point ? 2.4 : 1.8, 0, Math.PI * 2);
      ctx.fillStyle = status ? palette[status] : palette.label;
      ctx.fill();
      if (item.point) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = palette.land;
        ctx.stroke();
      }
      writeLabel(item.text, item.tx, item.ty, item.font,
        item.fill || (status ? palette.ink : palette.label),
        item.halo || (item.land > .5 ? palette.land : palette.sea));
    }
    ctx.globalAlpha = 1;
  }

  const SEAS = [
    ['PACIFIC OCEAN', -140, 4], ['PACIFIC OCEAN', 168, 24], ['ATLANTIC OCEAN', -36, 26],
    ['INDIAN OCEAN', 79, -22], ['SOUTHERN OCEAN', 14, -60, true], ['ARCTIC OCEAN', 0, 82, true],
  ];                                      // true: placed relative to the middle of the map

  function drawSeaLabels(placed) {
    if (view.k >= baseK() * 3) return;
    let pacific = null;
    for (const [name, lon, lat, middle] of SEAS) {
      const [sx, sy] = screenOf(middle ? view.lam + lon : lon, lat);
      if (name === 'PACIFIC OCEAN') {
        if (pacific !== null && Math.abs(pacific - sx) < stageW * .35) continue;
        pacific = sx;
      }
      const text = tracked(name, ' ');
      const w = textWidth(text, FONTS.sea);
      const rect = [sx - w / 2, sy - 7, sx + w / 2, sy + 7];
      if (rect[0] < 0 || rect[2] > stageW || rect[1] < 0 || rect[3] > stageH) continue;
      if (![[rect[0], rect[1]], [rect[2], rect[1]], [rect[0], rect[3]], [rect[2], rect[3]]].every(([px, py]) => onMap(px, py))) continue;
      if (placed.some(o => overlaps(rect, o))) continue;
      placed.push(rect);
      writeLabel(text, sx, sy, FONTS.sea, palette.seaLabel, null);
    }
  }

  // ------------------------------------------------------------------ picking

  function pick(px, py) {
    let best = null;
    let bestDistance = 8 * 8;
    for (const dot of dots) {
      const distance = (dot.x - px) ** 2 + (dot.y - py) ** 2;
      if (distance < bestDistance) {
        best = dot.place;
        bestDistance = distance;
      }
    }
    if (best) return { type: 'country', id: best.id };

    const wx = (px - view.x) / view.k;
    const wy = (py - view.y) / view.k;
    const level = levelFor(view.k);
    const contains = box => wx >= box[0] && wx <= box[2] && wy >= box[1] && wy <= box[3];
    toWorldSpace();
    if (!ctx.isPointInPath(OUTLINE, px * dpr, py * dpr)) return null;
    const hit = path => path && ctx.isPointInPath(path, px * dpr, py * dpr, 'evenodd');

    const group = focusId && STATES[focusId];
    if (group) {
      for (const state of group.list) {
        if (contains(boxOf(state)) && hit(statePath(state, level))) return { type: 'state', id: state.id };
      }
    }
    for (const place of selectable) {
      if (contains(boxOf(place)) && hit(pathOf(place, level))) return { type: 'country', id: place.id };
    }
    return null;
  }

  // -------------------------------------------------------------------- input

  let press = null;
  let pinchStart = 1;

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    flight = null;
    press = { x: event.offsetX, y: event.offsetY, lam: view.lam, vy: view.y, perPixel: degreesPerPixel(event.offsetY), moved: false };
  });

  canvas.addEventListener('pointermove', event => {
    if (press) {
      const dx = event.offsetX - press.x;
      const dy = event.offsetY - press.y;
      if (!press.moved && Math.hypot(dx, dy) < 4) return;
      press.moved = true;
      canvas.classList.add('dragging');
      setHover(null);
      view.lam = press.lam - dx * press.perPixel;
      view.y = press.vy + dy;
      settle();
      invalidate();
      return;
    }
    const target = pick(event.offsetX, event.offsetY);
    setHover(target, event.offsetX, event.offsetY);
  });

  canvas.addEventListener('pointerup', event => {
    if (!press) return;
    const wasClick = !press.moved;
    press = null;
    canvas.classList.remove('dragging');
    if (!wasClick) invalidate();      // so names that need leader lines come back
    if (wasClick) {
      const target = pick(event.offsetX, event.offsetY);
      // A country goes straight to its own page and states. States, and the
      // country you're already in, get the Been/Lived card.
      if (target && target.type === 'country' && target.id !== focusId) {
        closeCard();
        openCountry(target.id);
      } else if (target) openCard(target, event.offsetX, event.offsetY);
      else closeCard();
    }
  });

  canvas.addEventListener('pointerleave', () => setHover(null));
  canvas.addEventListener('dblclick', event => zoomAt(event.offsetX, event.offsetY, view.k * 2.2));

  stage.addEventListener('wheel', event => {
    event.preventDefault();
    flight = null;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const notchedWheel = event.wheelDeltaY && Math.abs(event.wheelDeltaY) >= 120 && event.wheelDeltaY % 120 === 0;
    if (event.ctrlKey || notchedWheel) {
      zoomAt(px, py, view.k * Math.exp(-event.deltaY * (event.ctrlKey ? .012 : .0022)));
    } else {
      panBy(-event.deltaX, -event.deltaY, py);
    }
    setHover(null);
  }, { passive: false });

  // Safari's pinch. In the Mac app, native code calls TN.pinch() instead.
  stage.addEventListener('gesturestart', event => {
    event.preventDefault();
    pinchStart = view.k;
  });
  stage.addEventListener('gesturechange', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, pinchStart * event.scale);
  });

  function setHover(target, px, py) {
    const changed = !same(target, hover) && (target || hover);
    hover = target;
    canvas.classList.toggle('pointing', !!target);
    const tip = $('#tip');
    if (!target || same(target, cardTarget)) tip.hidden = true;
    else {
      tip.hidden = false;
      tip.textContent = displayName(target);
      if (px !== undefined) {
        const width = tip.offsetWidth;
        const flipped = px + 14 + width > stageW;
        tip.style.transform = `translate(${flipped ? px - width - 10 : px + 14}px, ${py + 14}px)`;
      }
    }
    if (changed) invalidate();
  }

  function displayName(target) {
    if (target.type === 'state') return stateById.get(target.id).name;
    const place = byId.get(target.id);
    return `${flagOf(place)} ${place.name}`.trim();
  }

  // --------------------------------------------------------------------- card

  const card = $('#card');

  function openCard(target, px, py) {
    const [lon, lat] = lonLatAt(px, py);
    cardTarget = { ...target, lon, lat };
    $('#tip').hidden = true;
    renderCard();
    invalidate();
  }

  function closeCard() {
    if (!cardTarget) return;
    cardTarget = null;
    card.hidden = true;
    invalidate();
  }

  function markButtons(status) {
    return `<div class="seg">
      <button class="mark been" data-set="been" aria-pressed="${status === 'been'}">${icon('been')}Been</button>
      <button class="mark lived" data-set="lived" aria-pressed="${status === 'lived'}">${icon('lived')}Lived</button>
    </div>`;
  }

  function placeMeta(place) {
    if (place.kind === 'territory' && place.sov) return `Territory of ${place.sov}`;
    if (place.kind === 'territory' && place.id !== 'ATA') return `Territory · ${place.cont}`;
    return place.cont;
  }

  function renderCard() {
    if (!cardTarget) return;
    if (cardTarget.type === 'state') {
      const state = stateById.get(cardTarget.id);
      const place = byId.get(state.country);
      card.innerHTML = `
        <div class="title"><h3>${esc(state.name)}</h3></div>
        <p class="meta">${esc(place.name)}</p>
        ${markButtons(stateStatus(state))}`;
    } else {
      const place = byId.get(cardTarget.id);
      card.innerHTML = `
        <div class="title"><span class="flag">${flagOf(place)}</span><h3>${esc(place.name)}</h3></div>
        <p class="meta">${esc(placeMeta(place))}</p>
        ${markButtons(statusOf(place.id))}`;
    }
    card.hidden = false;
    placeCard();
  }

  function placeCard() {
    if (!cardTarget || card.hidden) return;
    const [sx, sy] = screenOf(cardTarget.lon, cardTarget.lat);
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    let left = sx + 16;
    if (left + width > stageW - 12) left = sx - width - 16;
    const top = clamp(sy - height / 2, 44, Math.max(44, stageH - height - 12));
    card.style.transform = `translate(${clamp(left, 12, Math.max(12, stageW - width - 12))}px, ${top}px)`;
  }

  card.addEventListener('click', event => {
    const set = event.target.closest('[data-set]');
    if (set) applyToCard(set.dataset.set);
  });

  // The card's place, or with no card open, the country you're in.
  function applyToCard(status) {
    if (cardTarget && cardTarget.type === 'state') toggleState(stateById.get(cardTarget.id), status);
    else if (cardTarget) toggleCountry(cardTarget.id, status);
    else if (focusId) toggleCountry(focusId, status);
  }

  // ------------------------------------------------------------------ sidebar

  const overview = $('#overview');
  const sheet = $('#sheet');
  const lists = $('#lists');
  const search = $('#q');
  const expanded = new Set();

  function pills(status) {
    return `<span class="pills">
      <button class="pill been" data-set="been" title="Been" aria-label="Been" aria-pressed="${status === 'been'}">${icon('been')}</button>
      <button class="pill lived" data-set="lived" title="Lived" aria-label="Lived" aria-pressed="${status === 'lived'}">${icon('lived')}</button>
    </span>`;
  }

  function countryRow(place) {
    const group = STATES[place.id];
    const seen = Object.keys(marksIn(place.id)).length;
    const progress = group && seen ? `<span class="sub">${seen}/${group.list.length}</span>` : '';
    const tag = place.kind === 'territory' ? '<span class="tag">territory</span>' : '';
    return `<div class="row" data-country="${place.id}">
      <button class="open"><span class="flag">${flagOf(place)}</span><span class="nm">${esc(place.name)}</span>${tag}${progress}</button>
      ${pills(statusOf(place.id))}
    </div>`;
  }

  function stateRow(state, withCountry) {
    const sub = withCountry ? `<span class="tag">${esc(byId.get(state.country).name)}</span>` : '';
    return `<div class="row" data-state="${state.id}">
      <button class="open"><span class="nm">${esc(state.name)}</span>${sub}</button>
      ${pills(stateStatus(state))}
    </div>`;
  }

  function renderScore(sums) {
    const share = sums.countries / counted.length * 100;
    const livedShare = sums.lived.length / counted.length * 100;
    const land = sums.land / landTotal * 100;
    const left = counted.length - sums.countries;
    $('#score').innerHTML = `
      <div class="headline"><span class="num">${sums.countries}</span><span class="of">of ${counted.length} countries</span></div>
      <div class="meter" role="img" aria-label="${share.toFixed(1)}% of countries">
        <i class="lived" style="width:${livedShare}%"></i><i style="width:${share - livedShare}%"></i>
      </div>
      <dl class="facts">
        <div><dt>Continents</dt><dd>${sums.continents.size}<small> of 7</small></dd></div>
        <div><dt>Earth’s land</dt><dd>${land < 10 && land > 0 ? land.toFixed(1) : Math.round(land)}%</dd></div>
        <div><dt>Lived in</dt><dd>${sums.lived.length}</dd></div>
        <div><dt>States</dt><dd>${sums.states}</dd></div>
      </dl>
      <p class="incognita">${left === 0 ? 'Nothing left unknown.' : `${left} ${left === 1 ? 'country' : 'countries'} still <em>terra incognita</em>`}</p>`;
  }

  function renderLists(sums) {
    const query = fold(search.value.trim());
    if (query) {
      const countries = selectable.filter(place => fold(place.name).includes(query)).sort(byName);
      const states = [...stateById.values()].filter(state => fold(state.name).includes(query)).sort(byName);
      const rows = countries.slice(0, 40).map(countryRow).concat(states.slice(0, 60).map(state => stateRow(state, true)));
      lists.innerHTML = rows.length
        ? `<div class="rows">${rows.join('')}</div>`
        : `<p class="empty">Nothing called “${esc(search.value.trim())}”.</p>`;
      return;
    }

    let html = '<h3 class="group-title">Continents</h3>';
    for (const name of CONTINENTS) {
      const bucket = sums.byContinent[name];
      const open = expanded.has(name);
      const total = bucket.total || bucket.extra;
      const seen = bucket.total ? bucket.seen : bucket.extraSeen;
      html += `<button class="cont" data-continent="${name}" aria-expanded="${open}">
          ${icon('chevron')}<span class="nm">${name}</span><span class="ct">${seen} / ${total}</span>
        </button>
        <div class="thin"><i style="width:${total ? seen / total * 100 : 0}%"></i></div>`;
      if (open) {
        const inContinent = selectable.filter(place => place.cont === name);
        const rows = inContinent.filter(p => p.kind === 'country').sort(byName)
          .concat(inContinent.filter(p => p.kind !== 'country').sort(byName));
        html += `<div class="rows">${rows.map(countryRow).join('')}</div>`;
      }
    }

    if (sums.lived.length) {
      html += '<h3 class="group-title">Lived in</h3><div class="chips">';
      for (const place of sums.lived.slice().sort(byName)) {
        html += `<button class="chip" data-open="${place.id}">${flagOf(place)} ${esc(place.name)}</button>`;
      }
      html += '</div>';
    }

    const exploring = Object.keys(data.states).filter(id => STATES[id] && byId.has(id))
      .map(id => byId.get(id))
      .sort((a, b) => Object.keys(marksIn(b.id)).length - Object.keys(marksIn(a.id)).length);
    if (exploring.length) {
      html += `<h3 class="group-title">States &amp; regions</h3>`;
      for (const place of exploring) {
        const seen = Object.keys(marksIn(place.id)).length;
        const total = STATES[place.id].list.length;
        html += `<button class="cont" data-open="${place.id}" style="grid-template-columns:18px 1fr auto">
            <span class="flag">${flagOf(place)}</span><span class="nm">${esc(place.name)}</span><span class="ct">${seen} / ${total}</span>
          </button>
          <div class="thin"><i style="width:${seen / total * 100}%"></i></div>`;
      }
    }

    if (sums.territories) {
      html += `<p class="empty">Plus ${sums.territories} ${sums.territories === 1 ? 'territory' : 'territories'} that don’t count as countries.</p>`;
    }
    lists.innerHTML = html;
  }

  function renderSheet() {
    const place = byId.get(focusId);
    const group = STATES[focusId];
    const note = (data.countries[focusId] && data.countries[focusId].note) || '';
    const filterValue = sheet.querySelector('.filter') ? sheet.querySelector('.filter').value : '';
    const noteEl = sheet.querySelector('.note');
    const keepNote = noteEl && noteEl.dataset.country === focusId ? noteEl.value : note;
    const seen = Object.keys(marksIn(focusId)).length;
    const needle = fold(filterValue.trim());
    const rows = group ? group.list.filter(state => fold(state.name).includes(needle)).map(state => stateRow(state, false)).join('') : '';
    const scroll = sheet.scrollTop;
    sheet.innerHTML = `
      <button class="back" data-act="world">${icon('chevron')}World</button>
      <div class="sheet-head">
        <span class="flag">${flagOf(place)}</span>
        <div><h2>${esc(place.name)}</h2><p>${esc(placeMeta(place))}</p></div>
      </div>
      <div data-country="${place.id}">${markButtons(statusOf(place.id))}</div>
      <textarea class="note" data-country="${place.id}" placeholder="Notes: when you went, who with, what to go back for" aria-label="Notes about ${esc(place.name)}">${esc(keepNote)}</textarea>
      ${group ? `<div class="state-head"><h3>${esc(group.unit)}</h3><span>${seen} of ${group.list.length}</span></div>
        <div class="meter" style="margin:0 0 8px"><i style="width:${seen / group.list.length * 100}%"></i></div>
        ${group.list.length > 12 ? `<input class="filter" type="search" placeholder="Filter" aria-label="Filter ${esc(group.unit)}" value="${esc(filterValue)}">` : ''}
        <div class="rows" id="state-rows">${rows}</div>` : ''}`;
    sheet.scrollTop = scroll;
  }

  // Rebuilding the lists is cheap, but it mustn't cost anyone their keyboard focus.
  function refresh() {
    const active = document.activeElement;
    const row = active && active.closest && active.closest('[data-country],[data-state]');
    const remembered = row && active.dataset.set
      ? { country: row.dataset.country, state: row.dataset.state, set: active.dataset.set }
      : null;

    const sums = tally();
    renderScore(sums);
    if (focusId) {
      if (!active || !active.classList || !active.classList.contains('filter')) renderSheet();
      else updateStateRows();
    }
    renderLists(sums);
    if (cardTarget) renderCard();

    const anything = sums.countries + sums.territories > 0;
    $('#hint').hidden = anything;

    if (remembered) {
      const selector = remembered.state ? `[data-state="${remembered.state}"]` : `[data-country="${remembered.country}"]`;
      const button = document.querySelector(`${selector} [data-set="${remembered.set}"]`);
      if (button) button.focus();
    }
    invalidate();
  }

  function updateStateRows() {
    const box = $('#state-rows');
    const input = sheet.querySelector('.filter');
    if (!box || !input) return;
    const needle = fold(input.value.trim());
    box.innerHTML = STATES[focusId].list.filter(state => fold(state.name).includes(needle)).map(state => stateRow(state, false)).join('');
  }

  function openCountry(id, focusState) {
    flushNote();
    if (focusId !== id) {
      sheet.innerHTML = '';
      sheet.scrollTop = 0;
    }
    focusId = id;
    overview.hidden = true;
    sheet.hidden = false;
    renderSheet();
    const place = byId.get(id);
    flyToBox(focusState ? focusState.bbox : place.focus, focusState ? 120 : 56);
    if (cardTarget && !(cardTarget.type === 'state' && stateById.get(cardTarget.id).country === id)) closeCard();
    invalidate();
  }

  function leaveCountry() {
    flushNote();
    focusId = null;
    sheet.hidden = true;
    overview.hidden = false;
    closeCard();
    flyHome();
    refresh();
  }

  document.querySelector('#panel').addEventListener('click', event => {
    const set = event.target.closest('[data-set]');
    if (set) {
      const holder = set.closest('[data-state],[data-country]');
      if (holder && holder.dataset.state) toggleState(stateById.get(holder.dataset.state), set.dataset.set);
      else if (holder) toggleCountry(holder.dataset.country, set.dataset.set);
      return;
    }
    const continent = event.target.closest('[data-continent]');
    if (continent) {
      const name = continent.dataset.continent;
      if (expanded.has(name)) expanded.delete(name);
      else expanded.add(name);
      renderLists(tally());
      const button = lists.querySelector(`[data-continent="${name}"]`);
      if (button) button.focus();
      return;
    }
    const open = event.target.closest('[data-open]');
    if (open) {
      openCountry(open.dataset.open);
      return;
    }
    const opener = event.target.closest('.open');
    if (opener) {
      const holder = opener.closest('[data-state],[data-country]');
      if (holder.dataset.state) showState(stateById.get(holder.dataset.state));
      else openCountry(holder.dataset.country);
    }
  });

  function showState(state) {
    openCountry(state.country, state);
    cardTarget = { type: 'state', id: state.id, lon: state.lx, lat: state.ly };
    renderCard();
  }

  // Hovering a row lights the place up on the map.
  document.querySelector('#panel').addEventListener('mouseover', event => {
    const row = event.target.closest('[data-state],[data-country]');
    const target = !row || row.tagName === 'TEXTAREA' ? null
      : row.dataset.state ? { type: 'state', id: row.dataset.state }
        : row.classList.contains('row') ? { type: 'country', id: row.dataset.country } : null;
    if (!same(target, hover) && (target || hover)) {
      hover = target;
      invalidate();
    }
  });
  document.querySelector('#panel').addEventListener('mouseleave', () => {
    hover = null;
    invalidate();
  });

  search.addEventListener('input', () => {
    lists.scrollTop = 0;
    renderLists(tally());
  });

  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const first = lists.querySelector('.row');
      if (!first) return;
      if (first.dataset.state) showState(stateById.get(first.dataset.state));
      else openCountry(first.dataset.country);
    }
  });

  // Notes save as you pause, not on every keystroke, and never enter undo history.
  let noteTimer = null;
  let pendingNote = null;

  function flushNote() {
    clearTimeout(noteTimer);
    if (!pendingNote) return;
    const { id, text } = pendingNote;
    pendingNote = null;
    const entry = data.countries[id] || {};
    if (text) entry.note = text;
    else delete entry.note;
    if (Object.keys(entry).length) data.countries[id] = entry;
    else delete data.countries[id];
    persist();
  }

  sheet.addEventListener('input', event => {
    if (event.target.classList.contains('note')) {
      pendingNote = { id: event.target.dataset.country, text: event.target.value };
      clearTimeout(noteTimer);
      noteTimer = setTimeout(flushNote, 400);
    } else if (event.target.classList.contains('filter')) {
      updateStateRows();
    }
  });
  sheet.addEventListener('focusout', event => {
    if (event.target.classList.contains('note')) flushNote();
  });

  // -------------------------------------------------------------------- toast

  const toastEl = $('#toast');
  let toastTimer = null;

  function toast(message, canUndo) {
    toastEl.innerHTML = `<span>${esc(message)}</span>${canUndo ? '<button data-act="undo">Undo</button>' : ''}`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  function hideToast() {
    toastEl.hidden = true;
  }

  // -------------------------------------------------------------- import/export

  function backupName() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `terra-nota-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
  }

  function exportData() {
    flushNote();
    const json = JSON.stringify(data, null, 2);
    if (bridge) {
      bridge.postMessage({ op: 'export', json, name: backupName() });
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    link.download = backupName();
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function receiveImport(text) {
    let incoming;
    try {
      incoming = normalise(JSON.parse(text));
    } catch (_) {
      toast('That file isn’t a Terra Nota backup. Nothing changed.', false);
      return false;
    }
    change(() => { data = incoming; });
    toast('Backup imported', true);
    return true;
  }

  $('#file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) receiveImport(await file.text());
  });

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const centreY = (stageH / 2 - view.y) / view.k;
    switch (button.dataset.act) {
      case 'zoom-in': flyTo(view.k * 2, view.lam, centreY, 240); break;
      case 'zoom-out': flyTo(view.k / 2, view.lam, centreY, 240); break;
      case 'home': focusId ? leaveCountry() : (closeCard(), flyHome(HOME_LAM)); break;
      case 'world': leaveCountry(); break;
      case 'undo': undo(); break;
      case 'export': exportData(); break;
      case 'import':
        if (bridge) bridge.postMessage({ op: 'import' });
        else $('#file').click();
        break;
      case 'reveal': bridge.postMessage({ op: 'reveal' }); break;
      default:
    }
  });

  // ----------------------------------------------------------------- keyboard

  const typing = () => {
    const active = document.activeElement;
    return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  };

  function nativeUndo(redoing) {
    if (typing()) document.execCommand(redoing ? 'redo' : 'undo');
    else if (redoing) redo();
    else undo();
  }

  document.addEventListener('keydown', event => {
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'z' && !typing()) {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (focusId) leaveCountry();
      search.focus();
      search.select();
      return;
    }
    if (event.key === 'Escape') {
      if (typing()) {
        if (document.activeElement === search && search.value) {
          search.value = '';
          renderLists(tally());
        } else document.activeElement.blur();
      } else if (cardTarget) closeCard();
      else if (focusId) leaveCountry();
      return;
    }
    if (typing() || command) return;
    const key = event.key.toLowerCase();
    if (key === 'b' && (cardTarget || focusId)) applyToCard('been');
    else if (key === 'l' && (cardTarget || focusId)) applyToCard('lived');
    else if (key === '/') {
      event.preventDefault();
      if (focusId) leaveCountry();
      search.focus();
    } else if (key === '=' || key === '+') zoomAt(stageW / 2, stageH / 2, view.k * 1.6);
    else if (key === '-') zoomAt(stageW / 2, stageH / 2, view.k / 1.6);
    else if (event.key.startsWith('Arrow') && (document.activeElement === document.body || document.activeElement === canvas)) {
      event.preventDefault();
      const step = { ArrowLeft: [140, 0], ArrowRight: [-140, 0], ArrowUp: [0, 100], ArrowDown: [0, -100] }[event.key];
      if (step) panBy(step[0], step[1]);
    }
  });

  // --------------------------------------------------------------------- boot

  function resize() {
    const rect = stage.getBoundingClientRect();
    const centreY = stageH ? (stageH / 2 - view.y) / view.k : HALF_H;
    const wasBase = !stageW || view.k <= baseK() * 1.001;
    stageW = rect.width;
    stageH = rect.height;
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(stageW * dpr);
    canvas.height = Math.round(stageH * dpr);
    if (wasBase) view.k = baseK();
    view.y = stageH / 2 - centreY * view.k;
    settle();
    draw();
  }

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    readPalette();
    invalidate();
  });

  readPalette();
  new ResizeObserver(resize).observe(stage);
  resize();
  if (bridge) {
    document.documentElement.classList.add('native');
    $('#reveal').hidden = false;
  }
  refresh();

  // What the Mac app (and its smoke test) reaches in for.
  window.TN = {
    undo: () => nativeUndo(false),
    redo: () => nativeUndo(true),
    flush: flushNote,
    exportData,
    receiveImport,
    pinch(amount, px, py) {
      flight = null;
      zoomAt(px - canvas.getBoundingClientRect().left, py, view.k * (1 + amount));
    },
    mark(id, status) {
      if (statusOf(id) !== status) toggleCountry(id, status);
    },
    markState(id, status) {
      const state = stateById.get(id);
      if (stateStatus(state) !== status) toggleState(state, status);
    },
    open: openCountry,
    home: leaveCountry,
    redraw: () => draw(performance.now()),
    // Lands any flight and fade at once, labels and all. A window the smoke test
    // opens may never get animation frames, so its snapshot calls this first.
    finish() {
      if (flight) {
        flight.start = -Infinity;
        stepFlight(performance.now());
      }
      focusFade = focusId ? 1 : 0;
      fades.clear();
      lastMove = -Infinity;
      draw(performance.now());
      if (leaders) leaders.born = -Infinity;
      draw(performance.now());
    },
    turn(degrees) {
      view.lam += degrees;
      settle();
      invalidate();
    },
    view: () => ({ k: view.k / baseK(), lam: view.lam, y: view.y }),
    leaderNames: () => (leaders ? leaders.items.map(item => item.item.name) : []),
    summary() {
      const sums = tally();
      return {
        countries: sums.countries, territories: sums.territories, continents: sums.continents.size,
        lived: sums.lived.map(place => place.id), states: sums.states,
        land: +(sums.land / landTotal * 100).toFixed(2),
      };
    },
  };
})();
