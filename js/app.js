/* Погода — статичний сайт. Усі дані беруться напряму з Open-Meteo (CORS дозволений), сервер не потрібен. */
(() => {
  'use strict';

  const I = window.I18N;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lite = matchMedia('(max-width: 700px)').matches || (navigator.hardwareConcurrency || 8) <= 4;
  root.classList.toggle('lite', lite);

  const el = {
    app: $('#app'), form: $('#searchForm'), input: $('#cityInput'), searchBtn: $('#searchBtn'),
    geo: $('#geoBtn'), langBtn: $('#langBtn'), langMenu: $('#langMenu'), langWrap: $('#langWrap'), gate: $('#langGate'),
    suggest: $('#suggest'), sgList: $('#sgList'), more: $('#moreBtn'), moreText: $('#moreText'),
    chips: $('#chips'), toast: $('#toast'), toastText: $('#toastText'), hero: $('#hero'),
    when: $('#when'), city: $('#cityName'), sub: $('#citySub'), temp: $('#temp'), desc: $('#desc'),
    hi: $('#hi'), lo: $('#lo'), icon: $('#icon'), save: $('#saveBtn'), saveText: $('#saveText'), next: $('#nextPrecip'),
    wind: $('#wind'), windNote: $('#windNote'), arrow: $('#arrow'),
    hum: $('#hum'), humBar: $('#humBar'), humNote: $('#humNote'),
    pres: $('#pres'), presDot: $('#presDot'), presNote: $('#presNote'),
    feels: $('#feels'), feelsBar: $('#feelsBar'), feelsNote: $('#feelsNote'),
    uv: $('#uv'), uvDot: $('#uvDot'), uvNote: $('#uvNote'),
    sunVal: $('#sunVal'), sunLbl: $('#sunLbl'), sunBar: $('#sunBar'), sunNote: $('#sunNote'),
    hoursTitle: $('#hoursTitle'), pchips: $('#pchips'), hscroll: $('#hscroll'), days: $('#days'),
    chart: $('#chart'), readout: $('#readout'), stars: $('#stars'), clouds: $('#clouds'), precip: $('#precip'),
    shooting: $('#shooting'), updated: $('#updated'), sky: $('.sky'),
    sheet: $('#sheet'), sheetCard: $('.sheet-card'), sheetTitle: $('#sheetTitle'), sheetViz: $('#sheetViz'),
    sheetBig: $('#sheetBig'), sheetRows: $('#sheetRows'), sheetText: $('#sheetText'), sheetX: $('#sheetX'),
  };

  const MIN_SUG = 3, MAX_SUG = 6, REFRESH = 10 * 60 * 1000;
  const LS = { lang: 'weather.lang', saved: 'weather.saved.v2', last: 'weather.last.v1', wx: 'weather.wx.v2', geo: 'weather.geo.v1' };
  const state = {
    lang: 'uk', city: null, wx: null, model: null, day: 0, saved: [], shown: {}, reqId: 0, sugId: 0,
    iconKey: '', precipKind: null, items: [], query: '', expanded: false, loadedAt: 0, sheetTrigger: null,
  };
  let COUNTRIES = [];

  const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
  const WX_URL = 'https://api.open-meteo.com/v1/forecast';
  const CURRENT_SHORT = 'temperature_2m,weather_code,is_day';
  const CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,is_day,precipitation,cloud_cover,dew_point_2m,visibility';
  const HOURLY = 'temperature_2m,weather_code,precipitation_probability,precipitation,pressure_msl,is_day';
  const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max';

  /* ───────── Хелпери ───────── */
  const L = () => I[state.lang] || I.uk;
  const t = (key, vars) => {
    let v = L()[key] ?? I.uk[key] ?? key;
    if (vars) for (const k in vars) v = v.replace(`{${k}}`, vars[k]);
    return v;
  };
  const fmt = (n) => { const r = Math.round(n); return (r < 0 ? '−' : '') + Math.abs(r); };
  const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1);
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const same = (a, b) => a && b && Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;
  const toMin = (s) => Date.parse(s + ':00Z') / 60000;
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватний режим чи переповнення */ } },
  };

  function tween(node, key, to, format = fmt) {
    const from = state.shown[key] ?? to;
    state.shown[key] = to;
    if (reduceMotion || from === to) { node.textContent = format(to); return; }
    const t0 = performance.now(), dur = 900;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      node.textContent = format(from + (to - from) * ease(p));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function animate(dur, fn) {
    if (reduceMotion) { fn(1); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      fn(ease(p));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  let toastTimer;
  function showToast(text) {
    clearTimeout(toastTimer);
    el.toastText.textContent = text;
    el.toast.hidden = false;
    el.toast.classList.remove('hide'); void el.toast.offsetWidth; el.toast.classList.add('show');
    toastTimer = setTimeout(() => {
      el.toast.classList.replace('show', 'hide');
      setTimeout(() => { el.toast.hidden = true; }, 360);
    }, 4200);
  }

  async function getJSON(url, ms = 10000, retries = 1) {
    for (let n = 0; ; n++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) {
        if (n >= retries) throw e;
        await new Promise((r) => setTimeout(r, 400));
      } finally { clearTimeout(timer); }
    }
  }

  // Короткий кеш у пам'яті: повторні запити за 10 хвилин не б'ють по API
  const memo = new Map();
  async function cached(url, force = false) {
    const hit = memo.get(url);
    if (!force && hit && Date.now() - hit.t < REFRESH) return hit.d;
    const d = await getJSON(url);
    memo.set(url, { t: Date.now(), d });
    if (memo.size > 60) memo.delete(memo.keys().next().value);
    return d;
  }

  /* ───────── Коди погоди (WMO) ───────── */
  const WMO = {
    0: ['clear', 'clear'], 1: ['mainly', 'clear'], 2: ['partly', 'partly'], 3: ['overcast', 'cloud'],
    45: ['fog', 'fog'], 48: ['fog', 'fog'],
    51: ['drizzle', 'rain'], 53: ['drizzle', 'rain'], 55: ['drizzle', 'rain'],
    56: ['freezing', 'rain'], 57: ['freezing', 'rain'],
    61: ['rainLight', 'rain'], 63: ['rain', 'rain'], 65: ['rainHeavy', 'rain'],
    66: ['freezing', 'rain'], 67: ['freezing', 'rain'],
    71: ['snowLight', 'snow'], 73: ['snow', 'snow'], 75: ['snowHeavy', 'snow'], 77: ['grains', 'snow'],
    80: ['showers', 'rain'], 81: ['showers', 'rain'], 82: ['showers', 'rain'],
    85: ['snowShowers', 'snow'], 86: ['snowShowers', 'snow'],
  };
  function describe(code, isDay) {
    const [key, icon] = WMO[code] || (code >= 95 ? ['storm', 'storm'] : ['unknown', 'cloud']);
    let sky;
    if (icon === 'clear') sky = isDay ? 'clear-day' : 'clear-night';
    else if (icon === 'partly' || icon === 'cloud') sky = isDay ? 'cloud-day' : 'cloud-night';
    else sky = icon;
    return { key, icon, sky };
  }
  const wmoLabel = (key) => L().wmo[key] || key;
  const RAIN = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], SNOW = [71, 73, 75, 77, 85, 86];
  const precipKind = (code) => (code >= 95 ? 'storm' : SNOW.includes(code) ? 'snow' : RAIN.includes(code) ? 'rain' : null);

  /* ───────── Анімовані іконки (градієнти — у index.html, анімації — у CSS) ───────── */
  const CLOUD = (fill = 'url(#cg)') => `<path d="M34 92h54a20 20 0 0 0 3-39.8A28 28 0 0 0 37 50a21 21 0 0 0-3 42z" fill="${fill}"/>`;
  const SUN = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><g class="rays">${
    Array.from({ length: 8 }, (_, i) => `<rect x="57.5" y="8" width="5" height="16" rx="2.5" fill="#ffd25e" transform="rotate(${i * 45} 60 60)"/>`).join('')
  }</g><circle cx="60" cy="60" r="26" fill="url(#sg)"/></g>`;
  const MOON = `<g class="moonb"><path d="M80 82A34 34 0 1 1 52 26a28 28 0 0 0 28 56z" fill="#f3f0dc"/>
    <circle cx="48" cy="56" r="4" fill="#d9d4b4"/><circle cx="60" cy="74" r="3" fill="#d9d4b4"/><circle cx="42" cy="72" r="2.2" fill="#d9d4b4"/>
    <path class="tw" d="M92 30l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#fff"/></g>`;

  function iconSVG(kind, isDay, mini) {
    const rain = [34, 54, 74].map((x, i) => `<line class="drop" x1="${x + 8}" y1="92" x2="${x + 4}" y2="104" stroke="#9fd0ff" stroke-width="4" stroke-linecap="round" style="animation-delay:${i * .28}s"/>`).join('');
    const snow = [36, 56, 76].map((x, i) => `<circle class="flake" cx="${x + 8}" cy="98" r="3.5" fill="#fff" style="animation-delay:${i * .6}s"/>`).join('');
    let body = '';
    switch (kind) {
      case 'clear': body = isDay ? SUN(0, 0, 1) : MOON; break;
      case 'partly':
        body = (isDay ? SUN(-12, -18, .8) : `<g transform="translate(-8 -14) scale(.8)">${MOON}</g>`) + `<g class="clf">${CLOUD()}</g>`; break;
      case 'cloud':
        body = `<g transform="translate(-6 -6)"><g class="clf">${CLOUD('url(#cd)')}</g></g><g transform="translate(10 6)"><g class="clf2">${CLOUD()}</g></g>`; break;
      case 'rain': body = `<g transform="translate(0 -10)">${CLOUD('url(#cd)')}${rain}</g>`; break;
      case 'snow': body = `<g transform="translate(0 -10)">${CLOUD()}${snow}</g>`; break;
      case 'storm':
        body = `<g transform="translate(0 -12)">${CLOUD('url(#cd)')}<polygon class="bolt" points="62,78 48,100 60,100 54,118 76,92 64,92 72,78" fill="#ffd25e"/></g>`; break;
      case 'fog':
        body = `<g transform="translate(0 -8)">${CLOUD('url(#cd)')}</g>` +
          [86, 98, 110].map((y, i) => `<line class="mist" x1="26" y1="${y}" x2="94" y2="${y}" stroke="#fff" stroke-opacity=".8" stroke-width="5" stroke-linecap="round" style="animation-duration:${5 + i}s;animation-direction:${i % 2 ? 'reverse' : 'normal'}"/>`).join(''); break;
    }
    return `<svg class="ico${mini ? ' mini' : ''}" viewBox="0 0 120 120" aria-hidden="true">${body}</svg>`;
  }

  /* ───────── Небо: зірки, хмари, падаючі зірки, опади ───────── */
  const rnd = (a, b) => a + Math.random() * (b - a);

  (function makeSky() {
    const nStars = lite ? 36 : 70, nClouds = lite ? 4 : 7;
    el.stars.innerHTML = Array.from({ length: nStars }, () => {
      const s = rnd(1, 3).toFixed(1);
      return `<i style="left:${rnd(0, 100).toFixed(1)}%;top:${rnd(0, 65).toFixed(1)}%;width:${s}px;height:${s}px;animation-delay:${rnd(0, 4).toFixed(1)}s;animation-duration:${rnd(3, 6).toFixed(1)}s"></i>`;
    }).join('');
    el.clouds.innerHTML = Array.from({ length: nClouds }, (_, i) => {
      const d = rnd(70, 150);
      return `<i style="--w:${rnd(26, 52).toFixed(0)}vw;--d:${d.toFixed(0)}s;top:${(i / nClouds * 85 + rnd(0, 8)).toFixed(0)}%;animation-delay:-${rnd(0, d).toFixed(0)}s;opacity:${rnd(.55, 1).toFixed(2)}"></i>`;
    }).join('');
  })();

  function shootingStar() {
    const next = rnd(5000, 11000);
    if (!document.hidden && !reduceMotion && document.body.dataset.sky === 'clear-night') {
      const s = document.createElement('i');
      s.style.cssText = `left:${rnd(15, 75).toFixed(0)}%;top:${rnd(4, 38).toFixed(0)}%;--rot:${rnd(22, 34).toFixed(0)}deg`;
      s.addEventListener('animationend', () => s.remove());
      el.shooting.append(s);
    }
    setTimeout(shootingStar, next);
  }
  if (!reduceMotion) setTimeout(shootingStar, 3000);

  function setPrecip(kind) {
    const type = kind === 'snow' ? 'snow' : (kind === 'rain' || kind === 'storm') ? 'rain' : '';
    if (type === state.precipKind) return;
    state.precipKind = type;
    el.precip.className = 'precip ' + type;
    if (!type) { el.precip.innerHTML = ''; return; }
    const n = type === 'rain' ? (lite ? 38 : 70) : (lite ? 26 : 45);
    el.precip.innerHTML = Array.from({ length: n }, () => {
      const dur = type === 'rain' ? rnd(.7, 1.3) : rnd(6, 12);
      return `<i style="left:${rnd(-5, 105).toFixed(1)}%;--fd:${dur.toFixed(2)}s;animation-duration:${dur.toFixed(2)}s;animation-delay:-${rnd(0, dur).toFixed(2)}s;--dx:${type === 'rain' ? -40 : rnd(-30, 30).toFixed(0)}px"></i>`;
    }).join('');
  }

  /* ───────── Модель даних ───────── */
  function buildModel(wx) {
    const c = wx.current, H = wx.hourly, D = wx.daily;
    const nowKey = c.time.slice(0, 13) + ':00';
    let nowIdx = H.time.findIndex((tm) => tm >= nowKey);
    if (nowIdx < 0) nowIdx = 0;
    return { c, H, D, nowIdx };
  }

  // Години для обраного дня: сьогодні — наступні 24 години від поточної, інші дні — доба повністю
  function hoursFor(m, day) {
    const { H, D, nowIdx } = m;
    let start, end;
    if (day === 0) { start = nowIdx; end = nowIdx + 24; }
    else {
      start = H.time.findIndex((tm) => tm.startsWith(D.time[day]));
      if (start < 0) return [];
      end = start + 24;
    }
    const out = [];
    for (let i = start; i < end && i < H.time.length; i++) {
      out.push({
        i, t: H.time[i].slice(11, 16), v: H.temperature_2m[i], code: H.weather_code[i],
        pop: H.precipitation_probability[i] ?? 0, pr: H.precipitation[i] ?? 0, day: !!H.is_day[i],
      });
    }
    return out;
  }

  function precipBlocks(hours) {
    const blocks = [];
    let cur = null;
    hours.forEach((h, k) => {
      const kind = precipKind(h.code);
      if (kind && cur && cur.kind === kind) { cur.end = k; cur.pop = Math.max(cur.pop, h.pop); cur.pr += h.pr; }
      else {
        if (cur) blocks.push(cur);
        cur = kind ? { kind, start: k, end: k, pop: h.pop, pr: h.pr } : null;
      }
    });
    if (cur) blocks.push(cur);
    return blocks;
  }
  const addHour = (hhmm) => String((+hhmm.slice(0, 2) + 1) % 24).padStart(2, '0') + ':00';
  const endTime = (hours, b) => hours[b.end + 1]?.t || addHour(hours[b.end].t);

  const windLvl = (ws) => (ws < 0.5 ? 0 : ws < 3.4 ? 1 : ws < 8 ? 2 : ws < 14 ? 3 : 4);
  const BFT = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const bft = (ws) => { const i = BFT.findIndex((x) => ws < x); return i < 0 ? 12 : i; };
  const humLvl = (h) => (h < 30 ? 0 : h < 60 ? 1 : h < 80 ? 2 : 3);
  const presLvl = (mm) => (mm < 745 ? 0 : mm > 765 ? 2 : 1);
  const uvLvl = (u) => (u < 3 ? 0 : u < 6 ? 1 : u < 8 ? 2 : u < 11 ? 3 : 4);
  // Кольори шкали температур: мороз — синій, 0° — блакитний, тепло — жовтий, спека — червоний
  const TSTOPS = [[-15, 220], [0, 195], [12, 140], [20, 50], [32, 8]];
  const tcol = (v) => {
    let h = TSTOPS.at(-1)[1];
    if (v <= TSTOPS[0][0]) h = TSTOPS[0][1];
    else for (let i = 1; i < TSTOPS.length; i++) {
      if (v <= TSTOPS[i][0]) { const [a, ha] = TSTOPS[i - 1], [b, hb] = TSTOPS[i]; h = ha + (hb - ha) * (v - a) / (b - a); break; }
    }
    return `hsl(${Math.round(h)} 85% 62%)`;
  };
  const fmtDur = (min) => `${Math.floor(min / 60)} ${t('hShort')} ${Math.round(min % 60)} ${t('mShort')}`;

  function pressureTrend(m) {
    const p = m.H.pressure_msl, a = p[m.nowIdx], b = p[Math.min(p.length - 1, m.nowIdx + 3)];
    const d = (b ?? a) - a;
    return { d, lvl: d < -1 ? 0 : d > 1 ? 2 : 1 };
  }

  function sunInfo(m) {
    const D = m.D, now = toMin(m.c.time), sr = toMin(D.sunrise[0]), ss = toMin(D.sunset[0]);
    let label, next, until, kind;
    if (now < sr) { label = 'sunrise'; next = D.sunrise[0]; until = sr - now; kind = 'sunUntil'; }
    else if (now < ss) { label = 'sunset'; next = D.sunset[0]; until = ss - now; kind = 'sunLeft'; }
    else { label = 'sunrise'; next = D.sunrise[1] || D.sunrise[0]; until = toMin(next) - now; kind = 'sunUntil'; if (!D.sunrise[1]) until += 1440; }
    return { label, kind, next: next.slice(11, 16), until, progress: clamp((now - sr) / (ss - sr), 0, 1), isDay: now >= sr && now <= ss, len: ss - sr, sr: D.sunrise[0].slice(11, 16), ss: D.sunset[0].slice(11, 16) };
  }

  /* ───────── Відображення ───────── */
  function render(city, wx, { keepDay = false } = {}) {
    const m = state.model = buildModel(wx);
    const c = m.c, isDay = !!c.is_day, info = describe(c.weather_code, isDay);
    if (!keepDay || state.day >= m.D.time.length) state.day = 0;

    document.body.dataset.sky = info.sky;
    setPrecip(info.icon);

    el.when.textContent = `${new Date(c.time).toLocaleDateString(L().locale, { weekday: 'long' })}, ${c.time.slice(11, 16)}`;
    el.city.textContent = city.name;
    el.sub.textContent = city.sub || '';
    el.desc.textContent = wmoLabel(info.key);
    tween(el.temp, 'temp', c.temperature_2m);
    tween(el.hi, 'hi', m.D.temperature_2m_max[0]);
    tween(el.lo, 'lo', m.D.temperature_2m_min[0]);

    const key = info.icon + (isDay ? 'd' : 'n');
    if (key !== state.iconKey) {
      el.icon.innerHTML = iconSVG(info.icon, isDay);
      el.icon.classList.remove('swap'); void el.icon.offsetWidth; el.icon.classList.add('swap');
      state.iconKey = key;
    }

    renderNext(m);
    renderStats(m);
    renderWeek(m);
    renderDay(m);

    el.updated.textContent = t('updated', { t: new Date().toLocaleTimeString(L().locale, { hour: '2-digit', minute: '2-digit' }) });
    el.app.classList.remove('is-loading');
    refreshSaveUI();
  }

  function renderNext(m) {
    const hrs = hoursFor(m, 0), blocks = precipBlocks(hrs), name = (k) => L().precipKinds[k];
    let txt;
    if (!blocks.length) txt = t('nextNone');
    else {
      const b = blocks[0];
      txt = b.start === 0 ? t('nextNow', { kind: name(b.kind), to: endTime(hrs, b) }) : t('nextAt', { kind: name(b.kind), at: hrs[b.start].t });
    }
    if (el.next.textContent !== txt || el.next.hidden) {
      el.next.hidden = false; el.next.textContent = txt;
      el.next.style.animation = 'none'; void el.next.offsetWidth; el.next.style.animation = '';
    }
  }

  function renderStats(m) {
    const c = m.c, D = m.D, T = L();

    const ws = c.wind_speed_10m;
    tween(el.wind, 'wind', ws, (v) => v.toFixed(1));
    el.arrow.style.transform = `rotate(${(c.wind_direction_10m + 180) % 360}deg)`;
    el.windNote.textContent = `${T.windLevels[windLvl(ws)]}, ${T.dirs[Math.round(c.wind_direction_10m / 45) % 8]}`;

    const h = c.relative_humidity_2m;
    tween(el.hum, 'hum', h);
    requestAnimationFrame(() => { el.humBar.style.width = clamp(h, 0, 100) + '%'; });
    el.humNote.textContent = T.humLevels[humLvl(h)];

    const mm = c.pressure_msl * 0.750062;
    tween(el.pres, 'pres', mm);
    requestAnimationFrame(() => { el.presDot.style.left = clamp((mm - 720) / 60 * 100, 4, 96) + '%'; });
    el.presNote.textContent = T.presLevels[presLvl(mm)];

    const f = c.apparent_temperature, diff = f - c.temperature_2m;
    tween(el.feels, 'feels', f);
    requestAnimationFrame(() => { el.feelsBar.style.width = clamp((f + 30) / 70 * 100, 4, 100) + '%'; });
    el.feelsNote.textContent = T.feelLevels[Math.abs(diff) < 1.5 ? 0 : diff < 0 ? 1 : 2];

    const uv = D.uv_index_max[0] ?? 0;
    tween(el.uv, 'uv', uv, (v) => v.toFixed(1));
    requestAnimationFrame(() => { el.uvDot.style.left = clamp(uv / 12 * 100, 3, 97) + '%'; });
    el.uvNote.textContent = T.uvLevels[uvLvl(uv)];

    const s = sunInfo(m);
    el.sunVal.textContent = s.next;
    el.sunLbl.textContent = t(s.label);
    requestAnimationFrame(() => { el.sunBar.style.width = (s.progress * 100).toFixed(0) + '%'; });
    el.sunNote.textContent = `${t(s.kind)} ${fmtDur(s.until)}`;
  }

  const dayName = (m, i) => (i === 0 ? t('today') : i === 1 ? t('tomorrow') : cap(new Date(m.D.time[i] + 'T12:00').toLocaleDateString(L().locale, { weekday: 'long' })));
  const dayShort = (m, i) => (i === 0 ? t('today') : i === 1 ? t('tomorrow') : cap(new Date(m.D.time[i] + 'T12:00').toLocaleDateString(L().locale, { weekday: 'short' })));

  function renderWeek(m) {
    const D = m.D, n = D.time.length;
    const gmin = Math.min(...D.temperature_2m_min), gmax = Math.max(...D.temperature_2m_max), span = (gmax - gmin) || 1;
    el.days.textContent = '';
    for (let i = 0; i < n; i++) {
      const info = describe(D.weather_code[i], true);
      const lo = D.temperature_2m_min[i], hi = D.temperature_2m_max[i], pop = D.precipitation_probability_max[i] ?? 0;
      const left = (lo - gmin) / span * 100, width = Math.max(8, (hi - lo) / span * 100);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'day'; b.dataset.day = i; b.style.setProperty('--i', i);
      b.setAttribute('aria-pressed', String(i === state.day));
      b.innerHTML = `<span class="day-n"><b>${dayShort(m, i)}</b><small>${wmoLabel(info.key)}</small></span>
        ${iconSVG(info.icon, true, true)}
        <span class="day-p">${pop >= 10 ? '💧' + pop + '%' : ''}</span>
        <span class="day-lo">${fmt(lo)}°</span>
        <span class="day-bar"><i style="left:${left.toFixed(1)}%;width:${Math.min(width, 100 - left).toFixed(1)}%;background:linear-gradient(90deg,${tcol(lo)},${tcol(hi)})"></i></span>
        <span class="day-hi">${fmt(hi)}°</span>`;
      el.days.append(b);
    }
  }

  function renderDay(m) {
    const hours = hoursFor(m, state.day), isToday = state.day === 0;
    el.hoursTitle.textContent = isToday ? t('hoursNext') : dayName(m, state.day);

    // Коли будуть опади
    const blocks = precipBlocks(hours);
    el.pchips.textContent = '';
    if (!blocks.length) {
      const d = document.createElement('div');
      d.className = 'pchip none';
      d.innerHTML = `${iconSVG('clear', true)}<span><b>${t('noPrecip')}</b></span>`;
      el.pchips.append(d);
    } else {
      blocks.forEach((b, k) => {
        const from = isToday && b.start === 0 ? t('nowLow') : hours[b.start].t;
        const mmTxt = b.pr >= 0.1 ? ` · ${b.pr.toFixed(1)} ${t('unitMm')}` : '';
        const d = document.createElement('div');
        d.className = 'pchip'; d.dataset.kind = b.kind; d.style.setProperty('--i', k);
        d.innerHTML = `${iconSVG(b.kind, true)}<span><b>${L().precipKinds[b.kind]} ${from}–${endTime(hours, b)}</b><small>${b.pop}%${mmTxt}</small></span>`;
        d.title = `${b.pop}% ${t('chance')}${mmTxt}`;
        el.pchips.append(d);
      });
    }

    // Стрічка по годинах
    const frag = document.createDocumentFragment();
    hours.forEach((h, k) => {
      const info = describe(h.code, h.day), kind = precipKind(h.code);
      const d = document.createElement('div');
      d.className = 'hr' + (isToday && k === 0 ? ' now' : '');
      d.setAttribute('role', 'listitem');
      d.style.setProperty('--i', k);
      if (kind) d.dataset.kind = kind;
      d.title = wmoLabel(info.key);
      d.innerHTML = `<span class="hr-t">${isToday && k === 0 ? t('now') : h.t}</span>${iconSVG(info.icon, h.day, true)}<b class="hr-v">${fmt(h.v)}°</b><span class="hr-p">${h.pop >= 10 ? h.pop + '%' : ''}</span>`;
      frag.append(d);
    });
    el.hscroll.textContent = '';
    el.hscroll.append(frag);
    el.hscroll.scrollLeft = 0;

    $$('.day', el.days).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.day === state.day)));
    renderChart(hours, isToday);
  }

  /* ───────── Графік ───────── */
  function smoothPath(p) {
    let d = `M${p[0].x} ${p[0].y}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
      d += ` C${(p1.x + (p2.x - p0.x) / 6).toFixed(1)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(1)}, ${(p2.x - (p3.x - p1.x) / 6).toFixed(1)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(1)}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  function renderChart(hours, isToday) {
    if (hours.length < 2) { el.chart.innerHTML = ''; return; }
    const W = 800, H = 260, Lp = 28, R = 28, T = 46, B = 38;
    const vals = hours.map((h) => h.v);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const pad = Math.max(1.5, (mx - mn) * 0.18);
    const lo = mn - pad, hi = mx + pad;
    const step = (W - Lp - R) / (hours.length - 1);
    const pts = hours.map((h, i) => ({ x: +(Lp + i * step).toFixed(1), y: +(T + (hi - h.v) / (hi - lo) * (H - T - B)).toFixed(1) }));
    const line = smoothPath(pts);
    const area = `${line} L${pts.at(-1).x} ${H - B} L${pts[0].x} ${H - B} Z`;
    const labelIdx = hours.map((_, i) => i).filter((i) => i % 3 === 0);

    const bars = hours.map((h, i) => {
      if (h.pop < 5) return '';
      const bh = h.pop / 100 * 36;
      return `<rect class="pbar" style="--k:${i}" x="${(pts[i].x - step * .32).toFixed(1)}" y="${(H - B - bh).toFixed(1)}" width="${(step * .64).toFixed(1)}" height="${bh.toFixed(1)}" rx="3"/>`;
    }).join('');

    const labels = labelIdx.map((i, k) => `
      <circle class="dot" style="--k:${k}" cx="${pts[i].x}" cy="${pts[i].y}" r="4.5"/>
      <text class="t-val" x="${pts[i].x}" y="${pts[i].y - 14}">${fmt(hours[i].v)}°</text>
      <text class="t-hour" x="${pts[i].x}" y="${H - 12}">${isToday && i === 0 ? t('now') : hours[i].t}</text>`).join('');

    el.chart.setAttribute('aria-label', t('chartAria'));
    el.chart.innerHTML = `
      <line class="grid" x1="${Lp}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
      ${bars}
      <path class="area" d="${area}" fill="url(#ag)"/>
      <path class="line" d="${line}" pathLength="1"/>
      ${labels}
      <g class="hover"><line id="hLine" x1="0" x2="0" y1="${T - 12}" y2="${H - B}"/><circle id="hDot" r="5" cx="0" cy="0"/></g>`;

    const base = `${t('from')} ${fmt(mn)}° ${t('to')} ${fmt(mx)}°`;
    el.readout.textContent = base;

    const hLine = $('#hLine'), hDot = $('#hDot');
    const move = (e) => {
      const r = el.chart.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * W;
      const i = clamp(Math.round((x - Lp) / step), 0, hours.length - 1);
      hLine.setAttribute('x1', pts[i].x); hLine.setAttribute('x2', pts[i].x);
      hDot.setAttribute('cx', pts[i].x); hDot.setAttribute('cy', pts[i].y);
      el.readout.textContent = `${isToday && i === 0 ? t('now') : hours[i].t}: ${fmt(hours[i].v)}°${hours[i].pop >= 5 ? ` · ${hours[i].pop}%` : ''}`;
    };
    el.chart.onpointermove = (e) => { if (e.pointerType !== 'mouse') el.chart.classList.add('touch'); move(e); };
    el.chart.onpointerleave = () => { el.chart.classList.remove('touch'); el.readout.textContent = base; };
  }

  /* ───────── Деталі картки (bottom sheet) ───────── */
  function sheetData(key) {
    const m = state.model;
    if (!m) return null;
    const c = m.c, D = m.D, T = L();
    const d = { title: t(key), viz: '', big: '', rows: [], text: '', after: null };

    if (key === 'wind') {
      const ws = c.wind_speed_10m, deg = c.wind_direction_10m, lvl = windLvl(ws);
      const dir = T.dirs[Math.round(deg / 45) % 8], rot = (deg + 180) % 360;
      const ticks = Array.from({ length: 16 }, (_, i) => `<line x1="80" y1="12" x2="80" y2="${i % 4 ? 17 : 22}" stroke="currentColor" stroke-opacity="${i % 4 ? .35 : .8}" stroke-width="2" transform="rotate(${i * 22.5} 80 80)"/>`).join('');
      d.viz = `<svg viewBox="0 0 160 160"><circle cx="80" cy="80" r="70" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="2"/>${ticks}
        <text x="80" y="42" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">${T.dirs[0]}</text>
        <text x="130" y="85" text-anchor="middle" font-size="12" fill="currentColor" fill-opacity=".7">${T.dirs[2]}</text>
        <text x="80" y="128" text-anchor="middle" font-size="12" fill="currentColor" fill-opacity=".7">${T.dirs[4]}</text>
        <text x="30" y="85" text-anchor="middle" font-size="12" fill="currentColor" fill-opacity=".7">${T.dirs[6]}</text>
        <g class="needle" id="needle" style="transform:rotate(0deg)"><path d="M80 52l11 30H69z" fill="currentColor"/><path d="M80 110l-8-18h16z" fill="currentColor" fill-opacity=".35"/></g></svg>`;
      d.big = `${ws.toFixed(1)}<small>${t('unitWind')}</small>`;
      d.rows = [
        [t('gusts'), `${(c.wind_gusts_10m ?? ws).toFixed(1)} ${t('unitWind')}`],
        [t('direction'), `${dir} · ${Math.round(deg)}°`],
        [t('bft'), `${bft(ws)} / 12`],
        [t('windMax'), `${(D.wind_speed_10m_max[0] ?? ws).toFixed(1)} ${t('unitWind')}`],
        [t('kmh'), (ws * 3.6).toFixed(0)],
      ];
      d.text = T.windAdvice[lvl];
      d.after = () => { $('#needle').style.transform = `rotate(${rot}deg)`; };
    }

    if (key === 'hum') {
      const h = c.relative_humidity_2m;
      const wave = (a) => `M0 0 Q15 ${-a} 30 0 T60 0 T90 0 T120 0 T150 0 T180 0 T210 0 T240 0 V130 H0Z`;
      d.viz = `<svg viewBox="0 0 120 120"><defs><clipPath id="hc"><circle cx="60" cy="60" r="54"/></clipPath></defs>
        <circle cx="60" cy="60" r="56" fill="rgba(255,255,255,.08)" stroke="currentColor" stroke-opacity=".5" stroke-width="2"/>
        <g clip-path="url(#hc)"><g class="water" id="water" style="transform:translateY(120px)">
          <path class="wave w2" d="${wave(7)}" fill="#8fd0ff"/><path class="wave" d="${wave(5)}" fill="#bfe3ff" fill-opacity=".85"/></g></g></svg>`;
      d.big = `${h}<small>%</small>`;
      d.rows = [
        [t('dewPoint'), `${fmt(c.dew_point_2m)}°`],
        [t('cloud'), `${c.cloud_cover ?? '–'}%`],
        [t('visibility'), c.visibility == null ? '–' : `${c.visibility >= 10000 ? (c.visibility / 1000).toFixed(0) : (c.visibility / 1000).toFixed(1)} ${t('unitKm')}`],
        [t('precipNow'), `${(c.precipitation ?? 0).toFixed(1)} ${t('unitMm')}`],
      ];
      d.text = T.humAdvice[humLvl(h)];
      d.after = () => { $('#water').style.transform = `translateY(${(116 - h * 1.12).toFixed(1)}px)`; };
    }

    if (key === 'pres') {
      const mm = c.pressure_msl * 0.750062, tr = pressureTrend(m);
      const ang = clamp((mm - 720) / 60, 0, 1) * 180 - 90;
      d.viz = `<svg viewBox="0 0 160 100"><defs><linearGradient id="pg" x1="0" x2="1"><stop offset="0" stop-color="#7cc4ff"/><stop offset=".5" stop-color="#6fe0a0"/><stop offset="1" stop-color="#ffb35c"/></linearGradient></defs>
        <path d="M15 85A65 65 0 0 1 145 85" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="12" stroke-linecap="round"/>
        <path d="M15 85A65 65 0 0 1 145 85" fill="none" stroke="url(#pg)" stroke-width="12" stroke-linecap="round"/>
        <g class="pneedle" id="pneedle" style="transform:rotate(-90deg)"><line x1="80" y1="85" x2="80" y2="32" stroke="#fff" stroke-width="4" stroke-linecap="round"/></g>
        <circle cx="80" cy="85" r="8" fill="#fff"/>
        <text x="15" y="100" font-size="10" fill="currentColor" fill-opacity=".7">720</text><text x="145" y="100" text-anchor="end" font-size="10" fill="currentColor" fill-opacity=".7">780</text></svg>`;
      d.big = `${mm.toFixed(0)}<small>${t('unitPres')}</small>`;
      d.rows = [
        [t('hpa'), c.pressure_msl.toFixed(0)],
        [t('trend'), `${['↘', '→', '↗'][tr.lvl]} ${T.trendLevels[tr.lvl]} (${sign(tr.d)})`],
      ];
      d.text = T.presAdvice[presLvl(mm)];
      d.after = () => { $('#pneedle').style.transform = `rotate(${ang}deg)`; };
    }

    if (key === 'feels') {
      const f = c.apparent_temperature, a = c.temperature_2m, diff = f - a;
      const w = (v) => clamp((v + 30) / 70 * 100, 4, 100).toFixed(0);
      d.viz = `<div class="dual"><div><span>${t('actual')}</span><b>${fmt(a)}°</b><span class="bar"><i class="warm" data-w="${w(a)}"></i></span></div>
        <div><span>${t('feels')}</span><b>${fmt(f)}°</b><span class="bar"><i class="warm" data-w="${w(f)}"></i></span></div></div>`;
      d.big = `${fmt(f)}°`;
      d.rows = [
        [t('actual'), `${fmt(a)}°`], [t('diff'), `${sign(diff)}°`],
        [t('wind'), `${c.wind_speed_10m.toFixed(1)} ${t('unitWind')}`], [t('hum'), `${c.relative_humidity_2m}%`],
      ];
      d.text = T.feelAdvice[Math.abs(diff) < 1.5 ? 0 : diff < 0 ? 1 : 2];
      d.after = () => { $$('.dual i', el.sheetViz).forEach((i) => { i.style.width = i.dataset.w + '%'; }); };
    }

    if (key === 'uv') {
      const uv = D.uv_index_max[0] ?? 0, lvl = uvLvl(uv);
      d.viz = `<div class="uvscale"><i id="uvm"></i></div>`;
      d.big = `${uv.toFixed(1)}<small>${T.uvLevels[lvl]}</small>`;
      d.rows = [[t('uv'), T.uvLevels[lvl]], [t('uvMax'), uv.toFixed(1)]];
      d.text = T.uvAdvice[lvl];
      d.after = () => { $('#uvm').style.left = clamp(uv / 12 * 100, 3, 97) + '%'; };
    }

    if (key === 'sun') {
      const s = sunInfo(m);
      d.viz = `<svg viewBox="0 0 160 100"><path class="sunpath" d="M20 80A60 60 0 0 1 140 80" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="2"/>
        <line x1="6" y1="80" x2="154" y2="80" stroke="currentColor" stroke-opacity=".5" stroke-width="2"/>
        <circle class="sun-dot" id="sdot" r="9" cx="20" cy="80" fill="${s.isDay ? '#ffd25e' : '#dfe3f0'}"/></svg>`;
      d.big = `${s.next}<small>${t(s.label)}</small>`;
      d.rows = [[t('sunrise'), s.sr], [t('sunset'), s.ss], [t('daylight'), fmtDur(s.len)], [t(s.kind), fmtDur(s.until)]];
      d.after = () => animate(1400, (p) => {
        const th = Math.PI * (1 - s.progress * p);
        const dot = $('#sdot');
        if (dot) { dot.setAttribute('cx', (80 + 60 * Math.cos(th)).toFixed(1)); dot.setAttribute('cy', (80 - 60 * Math.sin(th)).toFixed(1)); }
      });
    }
    return d;
  }

  function openSheet(key, trigger) {
    const d = sheetData(key);
    if (!d) return;
    state.sheetTrigger = trigger;
    el.sheetTitle.textContent = d.title;
    el.sheetViz.innerHTML = d.viz;
    el.sheetBig.innerHTML = d.big;
    el.sheetRows.textContent = '';
    d.rows.forEach(([k, v], i) => {
      const row = document.createElement('div');
      row.style.setProperty('--i', i);
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = k; dd.textContent = v;
      row.append(dt, dd);
      el.sheetRows.append(row);
    });
    el.sheetText.textContent = d.text;
    el.sheetX.setAttribute('aria-label', t('close'));
    el.sheet.classList.remove('closing');
    el.sheet.hidden = false;
    el.sheetCard.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    el.sheetCard.focus({ preventScroll: true });
    if (d.after) requestAnimationFrame(() => requestAnimationFrame(d.after));
  }

  function closeSheet() {
    if (el.sheet.hidden || el.sheet.classList.contains('closing')) return;
    el.sheet.classList.add('closing');
    setTimeout(() => {
      el.sheet.hidden = true; el.sheet.classList.remove('closing');
      document.body.style.overflow = '';
      state.sheetTrigger?.focus?.({ preventScroll: true });
    }, reduceMotion ? 0 : 300);
  }

  /* ───────── Дані: пошук ───────── */
  const wxKey = (c) => `${(+c.lat).toFixed(2)},${(+c.lon).toFixed(2)}`;
  const wxURL = (lat, lon) => `${WX_URL}?${new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: 7, wind_speed_unit: 'ms',
    current: CURRENT, hourly: HOURLY, daily: DAILY,
  })}`;

  const norm = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ё/g, 'е').replace(/[ії]/g, 'и').replace(/є/g, 'е').replace(/ґ/g, 'г')
    .replace(/[\s\-'’ʼ`.]+/g, ' ').trim();

  function matchCountries(text) {
    const q = norm(text);
    if (q.length < 2) return [];
    const exact = [], prefix = [];
    for (const c of COUNTRIES) {
      const keys = c._keys || (c._keys = [...Object.values(c.names), ...(c.aliases || [])].map(norm));
      if (keys.includes(q)) exact.push(c);
      else if (keys.some((k) => k.startsWith(q))) prefix.push(c);
    }
    return [...exact, ...prefix];
  }

  const countryItem = (c) => ({
    kind: 'country', name: c.names[state.lang], sub: c.capital.names[state.lang],
    lat: c.capital.lat, lon: c.capital.lon, cc: c.cc,
  });

  function rankPlaces(places, query) {
    const q = norm(query);
    const starts = places.filter((p) => norm(p.name).startsWith(q));
    return [...(starts.length ? starts : places)]
      .sort((a, b) => (b.population || 0) - (a.population || 0))
      .map((p) => ({
        kind: 'city', name: p.name, sub: [p.admin1, p.country].filter(Boolean).join(', '),
        lat: p.latitude, lon: p.longitude, cc: p.country_code || '',
      }));
  }

  async function geocode(name) {
    const j = await cached(`${GEO_URL}?${new URLSearchParams({ name, count: 10, language: state.lang, format: 'json' })}`);
    return j.results || [];
  }

  async function attachCurrent(items) {
    if (!items.length) return items;
    const j = await cached(`${WX_URL}?${new URLSearchParams({
      latitude: items.map((i) => i.lat.toFixed(4)).join(','),
      longitude: items.map((i) => i.lon.toFixed(4)).join(','),
      current: CURRENT_SHORT, timezone: 'auto',
    })}`);
    const rows = Array.isArray(j) ? j : [j];
    items.forEach((it, i) => {
      const c = rows[i]?.current || {};
      it.temp = c.temperature_2m; it.code = c.weather_code; it.is_day = c.is_day ?? 1;
    });
    return items;
  }

  // Формати: «Кре», «Україна», «Україна, Київ», «США, Нью-Йорк»
  async function apiSearch(query) {
    const raw = query.trim().slice(0, 80);
    if (!raw) return [];
    let countryPart = null, cityPart = raw;
    const comma = raw.indexOf(',');
    if (comma >= 0) { countryPart = raw.slice(0, comma).trim(); cityPart = raw.slice(comma + 1).trim(); }

    if (countryPart !== null) {
      const m = matchCountries(countryPart);
      if (!m.length) return [];
      const country = m[0];
      if (!cityPart) return attachCurrent([countryItem(country)]);
      const places = (await geocode(cityPart)).filter((p) => p.country_code === country.cc);
      return attachCurrent(rankPlaces(places, cityPart).slice(0, MAX_SUG));
    }
    const items = matchCountries(raw).slice(0, 2).map(countryItem);
    items.push(...rankPlaces(await geocode(raw), raw));
    return attachCurrent(items.slice(0, MAX_SUG));
  }

  /* ───────── Потік: завантаження, пошук, підказки ───────── */
  const tzName = (tz) => (tz || '').split('/').pop().replace(/_/g, ' ');

  async function loadCity(city, { silent = false, force = false, keepDay = false } = {}) {
    const id = ++state.reqId;
    if (!silent) el.app.classList.toggle('is-loading', !state.city);
    try {
      const wx = await cached(wxURL(city.lat, city.lon), force);
      if (id !== state.reqId) return false;
      if (!city.sub && city.geo) city = { ...city, sub: tzName(wx.timezone) };
      const sameCity = same(state.city, city);
      state.city = city; state.wx = wx; state.loadedAt = Date.now();
      render(city, wx, { keepDay: keepDay && sameCity });
      closeSuggest();
      store.set(LS.last, { name: city.name, sub: city.sub || '', lat: city.lat, lon: city.lon, cc: city.cc || '' });
      store.set(LS.wx, { key: wxKey(city), data: wx });
      return true;
    } catch {
      if (id !== state.reqId) return false;
      if (!silent) {
        const saved = store.get(LS.wx, null);
        if (saved && saved.key === wxKey(city)) {
          state.city = city; state.wx = saved.data;
          render(city, saved.data);
          showToast(t('errNet'));
          return true;
        }
        showToast(state.city ? t('errNet') : t('errLoad'));
      }
      el.app.classList.remove('is-loading');
      return false;
    }
  }

  function pick(it) {
    state.manual = true;
    el.input.value = '';
    el.input.blur();
    closeSuggest();
    loadCity({ name: it.name, sub: it.sub, lat: it.lat, lon: it.lon, cc: it.cc });
  }

  function showSkeleton() {
    el.sgList.textContent = '';
    for (let i = 0; i < MIN_SUG; i++) {
      const li = document.createElement('li');
      li.className = 'sg sg-skel';
      el.sgList.append(li);
    }
    el.more.hidden = true;
    el.suggest.classList.add('is-open');
  }

  function renderSuggest() {
    const items = state.items;
    el.sgList.textContent = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'sg-empty';
      li.textContent = t('noResults');
      el.sgList.append(li);
      el.more.hidden = true;
      el.suggest.classList.add('is-open');
      return;
    }
    const limit = state.expanded ? MAX_SUG : MIN_SUG;
    items.slice(0, limit).forEach((it, i) => {
      const d = describe(it.code ?? 3, !!it.is_day);
      const li = document.createElement('li');
      li.className = 'sg';
      li.dataset.sky = d.sky;
      li.style.setProperty('--i', i);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sg-btn';

      const text = document.createElement('span');
      text.className = 'sg-text';
      const name = document.createElement('span'); name.className = 'sg-name'; name.textContent = it.name;
      const sub = document.createElement('span'); sub.className = 'sg-sub'; sub.textContent = it.sub || '';
      const lbl = document.createElement('span'); lbl.className = 'sg-label'; lbl.textContent = wmoLabel(d.key);
      text.append(name, sub, lbl);

      const temp = document.createElement('span');
      temp.className = 'sg-temp';
      temp.textContent = it.temp == null ? '–' : fmt(it.temp) + '°';

      btn.append(text, temp);
      btn.addEventListener('click', () => pick(it));
      li.append(btn);
      el.sgList.append(li);
    });
    updateMore();
    el.suggest.classList.add('is-open');
  }

  function updateMore() {
    const extra = Math.min(state.items.length, MAX_SUG) - MIN_SUG;
    el.more.hidden = state.items.length <= MIN_SUG;
    el.moreText.textContent = state.expanded ? t('less') : t('more', { n: extra });
    el.more.classList.toggle('open', state.expanded);
    el.more.setAttribute('aria-expanded', String(state.expanded));
  }

  function closeSuggest() { el.suggest.classList.remove('is-open'); }

  async function runSearch(q) {
    const id = ++state.sugId;
    state.query = q;
    if (!q.trim()) { state.items = []; closeSuggest(); return; }
    showSkeleton();
    try {
      const items = await apiSearch(q);
      if (id !== state.sugId) return;
      state.items = items;
      state.expanded = false;
      renderSuggest();
    } catch {
      if (id !== state.sugId) return;
      closeSuggest();
      showToast(t('errNet'));
    }
  }

  /* ───────── Збережені місця ───────── */
  function persist() { store.set(LS.saved, state.saved); }

  function refreshSaveUI() {
    const on = state.saved.some((s) => same(s, state.city));
    el.save.setAttribute('aria-pressed', String(on));
    el.saveText.textContent = t(on ? 'saved' : 'save');
    el.save.setAttribute('aria-label', t(on ? 'removeSaved' : 'savePlace'));
    renderChips();
  }

  function renderChips() {
    el.chips.textContent = '';
    if (!state.saved.length) {
      const s = document.createElement('span');
      s.className = 'empty';
      s.textContent = t('chipsEmpty');
      el.chips.append(s);
      return;
    }
    state.saved.forEach((s, i) => {
      const wrap = document.createElement('span');
      wrap.className = 'chip';
      wrap.dataset.active = String(same(s, state.city));
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'chip-go rip'; go.textContent = s.name;
      go.addEventListener('click', () => { state.manual = true; loadCity(s); });
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'chip-x'; x.textContent = '×';
      x.setAttribute('aria-label', t('removeChip', { name: s.name }));
      x.addEventListener('click', () => { state.saved.splice(i, 1); persist(); refreshSaveUI(); });
      wrap.append(go, x);
      el.chips.append(wrap);
    });
  }

  el.save.addEventListener('click', () => {
    if (!state.city) return;
    const i = state.saved.findIndex((s) => same(s, state.city));
    if (i >= 0) state.saved.splice(i, 1);
    else state.saved.push({ name: state.city.name, sub: state.city.sub || '', lat: state.city.lat, lon: state.city.lon, cc: state.city.cc || '' });
    persist();
    refreshSaveUI();
  });

  /* ───────── Мова ───────── */
  function applyLang() {
    document.documentElement.lang = state.lang;
    document.title = t('title');
    $$('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
    $$('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
    $$('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAria)); n.title = t(n.dataset.i18nAria); });
    el.langBtn.textContent = state.lang.toUpperCase();
    $$('[data-lang]', el.langMenu).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === state.lang)));
    if (state.wx && state.city) render(state.city, state.wx, { keepDay: true });
    if (!el.sheet.hidden) closeSheet();
    if (state.query && state.items.length) runSearch(state.query);
    updateMore();
  }

  function setLang(lang) {
    state.lang = lang;
    store.set(LS.lang, lang);
    applyLang();
  }

  /* ───────── Події ───────── */
  const closeLangMenu = () => { el.langMenu.hidden = true; el.langBtn.setAttribute('aria-expanded', 'false'); };

  el.gate.querySelectorAll('[data-lang]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setLang(btn.dataset.lang);
      el.gate.hidden = true;
      const last = store.get(LS.last, null);
      loadCity(last && typeof last.lat === 'number' && typeof last.lon === 'number' ? last : defaultCity());
    });
  });

  el.langBtn.addEventListener('click', () => {
    const open = el.langMenu.hidden;
    el.langMenu.hidden = !open;
    el.langBtn.setAttribute('aria-expanded', String(open));
    if (open) $('[aria-checked="true"]', el.langMenu)?.focus();
  });
  el.langMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b) return;
    setLang(b.dataset.lang);
    closeLangMenu();
    el.langBtn.focus();
  });

  let debounce;
  el.input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(el.input.value), 320);
  });
  el.input.addEventListener('focus', () => {
    if (state.items.length && el.input.value.trim()) renderSuggest();
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    const b = $('.sg-btn', el.sgList);
    if (b) { e.preventDefault(); b.focus(); }
  });
  el.sgList.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = $$('.sg-btn', el.sgList), i = btns.indexOf(document.activeElement), n = e.key === 'ArrowDown' ? i + 1 : i - 1;
    if (n < 0) el.input.focus(); else btns[Math.min(n, btns.length - 1)]?.focus();
  });

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = el.input.value.trim();
    if (!q) { showToast(t('errEmpty')); el.input.focus(); return; }
    clearTimeout(debounce);
    const id = ++state.sugId;
    el.searchBtn.disabled = true;
    try {
      const items = (q === state.query && state.items.length) ? state.items : await apiSearch(q);
      if (id !== state.sugId) return;
      if (!items.length) { showToast(t('errNotFound')); return; }
      pick(items[0]);
    } catch {
      showToast(t('errNet'));
    } finally {
      el.searchBtn.disabled = false;
    }
  });

  el.more.addEventListener('click', () => {
    state.expanded = !state.expanded;
    renderSuggest();
  });

  el.geo.addEventListener('click', () => {
    if (!navigator.geolocation) { showToast(t('errGeoNone')); return; }
    el.geo.classList.add('busy');
    state.manual = true;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        el.geo.classList.remove('busy');
        store.set(LS.geo, true);
        loadCity(geoCity(p));
      },
      (err) => { el.geo.classList.remove('busy'); showToast(err.code === 1 ? t('errGeo') : t('errGeoFail')); },
      { timeout: 10000, maximumAge: 300000 }
    );
  });

  // Клік по дню тижня — показати його по годинах
  el.days.addEventListener('click', (e) => {
    const b = e.target.closest('.day');
    if (!b || !state.model) return;
    state.day = +b.dataset.day;
    renderDay(state.model);
    el.hoursTitle.closest('.hours').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
  });

  // Клікабельні картки
  $('#stats').addEventListener('click', (e) => {
    const card = e.target.closest('.stat');
    if (card) openSheet(card.dataset.card, card);
  });
  $('#stats').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.stat');
    if (card) { e.preventDefault(); openSheet(card.dataset.card, card); }
  });
  el.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.top')) closeSuggest();
    if (!e.target.closest('.lang-wrap')) closeLangMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.sheet.hidden) { closeSheet(); return; }
    closeSuggest(); closeLangMenu(); el.input.blur();
  });

  // Ефект хвилі на кнопках
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.rip');
    if (!b || reduceMotion) return;
    const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height) * 2;
    const sp = document.createElement('span');
    sp.className = 'ripple';
    sp.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
    sp.addEventListener('animationend', () => sp.remove());
    b.append(sp);
  });

  // Перетягування стрічки годин мишею
  let drag = null;
  el.hscroll.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') drag = { x: e.clientX, left: el.hscroll.scrollLeft };
  });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) el.hscroll.classList.add('drag');
    el.hscroll.scrollLeft = drag.left - dx;
  });
  addEventListener('pointerup', () => { drag = null; el.hscroll.classList.remove('drag'); });

  // З'яви блоків під час прокрутки
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.05 })
    : null;
  $$('[data-in]').forEach((n) => (io ? io.observe(n) : n.classList.add('in')));

  // Ефекти за курсором (тільки ПК з мишею): паралакс неба, нахил іконки й карток
  if (matchMedia('(hover: hover)').matches && !reduceMotion) {
    let raf = 0, mx = 0, my = 0;
    addEventListener('pointermove', (e) => {
      mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el.sky.style.setProperty('--px', (mx * 4).toFixed(3));
        el.sky.style.setProperty('--py', (my * 4).toFixed(3));
      });
    }, { passive: true });

    el.hero.addEventListener('pointermove', (e) => {
      const r = el.hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.icon.style.transform = `translate(${x * 18}px, ${y * 14}px)`;
    });
    el.hero.addEventListener('pointerleave', () => { el.icon.style.transform = ''; });

    $('#stats').addEventListener('pointermove', (e) => {
      const card = e.target.closest('.stat');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--ry', (((e.clientX - r.left) / r.width - 0.5) * 8).toFixed(1) + 'deg');
      card.style.setProperty('--rx', ((0.5 - (e.clientY - r.top) / r.height) * 8).toFixed(1) + 'deg');
    });
    $('#stats').addEventListener('pointerout', (e) => {
      const card = e.target.closest('.stat');
      if (card && !card.contains(e.relatedTarget)) { card.style.removeProperty('--rx'); card.style.removeProperty('--ry'); }
    });
  }

  // Автооновлення, пауза анімацій у фоновій вкладці
  const stale = () => state.city && Date.now() - state.loadedAt > REFRESH;
  const refresh = () => loadCity(state.city, { silent: true, force: true, keepDay: true });
  setInterval(() => { if (!document.hidden && stale()) refresh(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    root.classList.toggle('paused', document.hidden);
    if (!document.hidden && stale()) refresh();
  });

  const defaultCity = () => ({ name: t('defaultCity'), sub: '', lat: 49.0659, lon: 33.4204, cc: 'UA' });
  const geoCity = (p) => ({ name: t('myPlace'), sub: '', geo: true, lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3), cc: '' });

  // Якщо доступ до геолокації вже дозволено — при заході показуємо погоду за місцезнаходженням.
  // Спочатку миттєво малюється останнє місто, потім воно замінюється на поточне місце
  // (якщо користувач за цей час сам нічого не обрав).
  async function autoLocate() {
    if (!navigator.geolocation) return;
    let granted = false;
    try { granted = (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; }
    catch { granted = !!store.get(LS.geo, false); } // Safari без Permissions API: довіряємо раніше наданому дозволу
    if (!granted) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { if (!state.manual) loadCity(geoCity(p)); },
      () => { /* лишаємо останнє місто */ },
      { timeout: 10000, maximumAge: 300000 }
    );
  }

  /* ───────── Старт ───────── */
  async function init() {
    el.icon.innerHTML = iconSVG('clear', true);
    state.saved = store.get(LS.saved, []);
    const countries = getJSON('data/countries.json').catch(() => []);

    const saved = store.get(LS.lang, null);
    if (saved && I[saved]) {
      state.lang = saved;
      applyLang();
      renderChips();
      const last = store.get(LS.last, null);
      const isLast = !!(last && typeof last.lat === 'number' && typeof last.lon === 'number');
      const ok = await loadCity(isLast ? last : defaultCity());
      if (!ok && isLast) await loadCity(defaultCity());
      autoLocate();
    } else {
      applyLang();
      renderChips();
      el.gate.hidden = false;
    }
    COUNTRIES = await countries;
  }

  init();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
