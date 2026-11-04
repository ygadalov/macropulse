/* ===== FX Forecast Terminal — ЛОКАЛЬНАЯ ВЕРСИЯ =====
   Работает с file:// без серверов. База курсов ЦБ РФ лежит рядом в fx-history.js
   (window.FX_HIST, 10 лет). При открытии страницы догружаются только новые дни
   с JSON-зеркала cbr-xml-daily.ru (резерв — JSONP-канал); дельта сразу пишется
   в localStorage, а кнопка «Сохранить базу» перезаписывает fx-history.js
   (в Chrome/Edge — напрямую через File System Access API, иначе — скачивание).
   Кросс-курсы без рубля — через рублёвые курсы обеих валют (RUB = 1).
   Прогноз: ансамбль (damped Holt + Theta + дрейф) на log-курсе; тренд: лог-линейная
   регрессия. Внешних CDN нет: Chart.js и шрифты лежат локально в src/. */
(function () {
  'use strict';

  var CBR = 'https://www.cbr-xml-daily.ru'; /* зеркало официальных курсов ЦБ РФ, JSON + CORS */
  var state = { base: 'USD', quote: 'EUR', windowDays: 365, horizon: 14 };
  var chart = null;
  var loadSeq = 0;

  var $ = function (id) { return document.getElementById(id); };
  var led = $('statusLed');

  /* ---------- helpers ---------- */
  function fmt(v, forceDigits) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    var d = forceDigits != null ? forceDigits : (a >= 500 ? 2 : a >= 20 ? 3 : a >= 0.01 ? 4 : 6);
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  }
  function fmtPct(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    var s = (v > 0 ? '+' : '') + (v * 100).toFixed(digits == null ? 2 : digits).replace('.', ',');
    return s + ' %';
  }
  function isoDay(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDateRU(iso) {
    var p = iso.split('-');
    return p[2] + '.' + p[1] + '.' + p[0];
  }
  function fmtDateShort(iso) {
    var p = iso.split('-');
    return p[2] + '.' + p[1] + '.' + p[0].slice(2);
  }
  function setLed(mode, text) {
    led.className = 'led' + (mode ? ' ' + mode : '');
    led.textContent = text;
  }
  function fetchJSON(url, opts) {
    /* таймаут: зависший запрос не должен навсегда занимать воркер загрузчика */
    var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = null;
    if (ac) {
      to = setTimeout(function () { ac.abort(); }, 20000);
      opts = Object.assign({}, opts, { signal: ac.signal });
    }
    function done() { if (to) clearTimeout(to); }
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) { done(); return j; }, function (e) { done(); throw e; });
  }
  /* уступка кадра между пачками без таймера: в фоновых вкладках Chrome принудительно
     замедляет setTimeout до ≥1 с, из-за чего загрузка «в соседней вкладке» ползёт;
     сообщение MessageChannel таймером не считается и не душится */
  var yieldTask = (function () {
    if (typeof MessageChannel !== 'undefined') {
      var ch = new MessageChannel(), q = [];
      ch.port1.onmessage = function () { var f = q.shift(); if (f) f(); };
      return function (f) { q.push(f); ch.port2.postMessage(0); };
    }
    return function (f) { setTimeout(f, 0); };
  })();
  /* резервный канал: JSONP-версия зеркала. Тег <script> не подчиняется CORS — спасает,
     когда контент доходит, но CORS-заголовки вырезаны фильтром провайдера/лимитером.
   Имя колбэка у зеркала одно на всех (CBR_XML_Daily_Ru) — вызовы строго по очереди */
  function jsonpFetch(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      var to = setTimeout(function () { cleanup(); reject(new Error('jsonp timeout')); }, 20000);
      function cleanup() { clearTimeout(to); s.remove(); window.CBR_XML_Daily_Ru = undefined; }
      window.CBR_XML_Daily_Ru = function (data) { cleanup(); resolve(data); };
      s.onerror = function () { cleanup(); reject(new Error('jsonp error')); };
      s.src = url.replace(/daily_json\.js$/, 'daily_jsonp.js');
      document.head.appendChild(s);
    });
  }
  /* fetch с повторными попытками — для актуального снимка и предыдущей установки */
  function fetchRetry(url, tries, opts) {
    return fetchJSON(url, opts).catch(function (err) {
      if (tries <= 1) throw err;
      return new Promise(function (res) { setTimeout(res, 700); })
        .then(function () { return fetchRetry(url, tries - 1, opts); });
    });
  }

  /* ---------- часы (московское время) ---------- */
  var mskFmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  function tickClock() { $('clock').textContent = mskFmt.format(new Date()) + ' МСК'; }
  tickClock();
  setInterval(tickClock, 1000);

  /* ---------- снимок ЦБ (актуальный + предыдущая установка) ---------- */
  /* rateOf: рублей за 1 ед. валюты (Value/Nominal); RUB = 1 */
  function rateOf(valute, code) {
    if (code === 'RUB') return 1;
    var r = valute && valute[code];
    return r ? r.Value / r.Nominal : null;
  }

  /* ---------- лента котировок (всё — курсы ЦБ РФ) ---------- */
  var TICKER_RUB = ['USD', 'EUR', 'CNY', 'KZT'];
  var TICKER_CROSS = [['EUR', 'USD'], ['GBP', 'USD'], ['USD', 'JPY'], ['USD', 'CHF'], ['USD', 'TRY'], ['USD', 'INR']];
  function tkChip(label, val, chg) {
    var cls = chg > 0 ? 'up' : chg < 0 ? 'dn' : '';
    var arrow = chg > 0 ? '▲' : chg < 0 ? '▼' : '•';
    return '<span class="tk"><b>' + label + '</b><span class="v">' + fmt(val) + '</span>' +
      '<span class="' + cls + '">' + arrow + ' ' + Math.abs(chg * 100).toFixed(2).replace('.', ',') + '%</span></span>';
  }
  function loadTicker(snap) {
    var html = '';
    TICKER_RUB.forEach(function (cc) {
      var v = rateOf(snap.cur, cc), p = snap.prev ? rateOf(snap.prev, cc) : null;
      if (v != null) html += tkChip(cc + '/RUB', v, p ? v / p - 1 : 0);
    });
    TICKER_CROSS.forEach(function (pair) {
      var v1 = rateOf(snap.cur, pair[0]), v2 = rateOf(snap.cur, pair[1]);
      var p1 = snap.prev ? rateOf(snap.prev, pair[0]) : null;
      var p2 = snap.prev ? rateOf(snap.prev, pair[1]) : null;
      if (v1 && v2) html += tkChip(pair[0] + '/' + pair[1], v1 / v2, (p1 && p2) ? (v1 / v2) / (p1 / p2) - 1 : 0);
    });
    $('tickerTrack').innerHTML = html
      ? html + html /* дублируем для бесшовной прокрутки */
      : '<span class="tk"><b>ЛЕНТА НЕДОСТУПНА</b></span>';
  }

  /* ---------- список валют (полный перечень ЦБ + RUB, из локальной базы) ---------- */
  var PIN = ['USD', 'EUR', 'RUB', 'CNY', 'GBP', 'CHF', 'JPY', 'KZT'];
  function buildCurrencies() {
    var names = DB.names;
    var codes = Object.keys(names);
    codes.sort(function (a, b) {
      var ia = PIN.indexOf(a), ib = PIN.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var opts = codes.map(function (c) { return '<option value="' + c + '">' + c + ' — ' + names[c] + '</option>'; }).join('');
    var b = $('baseSel'), q = $('quoteSel');
    b.innerHTML = opts; q.innerHTML = opts;
    b.value = state.base; q.value = state.quote;
    b.disabled = false; q.disabled = false;
  }
  /* если в снимке зеркала появились новые валюты — дописываем имена и перестраиваем список */
  function mergeNamesFromSnapshot(valute) {
    var added = false;
    Object.keys(valute || {}).forEach(function (cc) {
      if (!DB.names[cc]) { DB.names[cc] = valute[cc].Name; added = true; }
    });
    if (added) buildCurrencies();
  }

  /* ---------- модель: ансамбль из трёх по лог-курсу ---------- */
  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function med3(a, b, c) { return a > b ? (b > c ? b : a > c ? c : a) : (a > c ? a : b > c ? c : b); }

  /* робастная σ через MAD: один шоковый день не раздувает полосу надолго */
  function robustSigma(errors) {
    var m = median(errors);
    var dev = errors.map(function (e) { return Math.abs(e - m); });
    return 1.4826 * median(dev);
  }

  /* Holt с затухающим трендом: l = α·y + (1−α)(l + φ·b); b = β·Δl + (1−β)·φ·b;
     прогноз: l + (φ+φ²+…+φʰ)·b — тренд затухает, а не улетает линейно */
  function fitDampedHolt(y, alpha, beta, phi) {
    var n = y.length;
    var l = y[0], b = y[1] - y[0];
    var errors = [];
    for (var i = 1; i < n; i++) {
      errors.push(y[i] - (l + phi * b));
      var lp = l;
      l = alpha * y[i] + (1 - alpha) * (l + phi * b);
      b = beta * (l - lp) + (1 - beta) * phi * b;
    }
    return { l: l, b: b, errors: errors };
  }
  /* подбор α/β/φ: в режиме АВТО — сетка по одношаговой SSE под конкретный ряд,
     в ручном — параметры из настроек */
  function dampedHoltBest(y, h) {
    var best;
    if (settings.modelMode === 'manual') {
      var f0 = fitDampedHolt(y, settings.holt.alpha, settings.holt.beta, settings.holt.phi);
      best = { l: f0.l, b: f0.b, errors: f0.errors,
               alpha: settings.holt.alpha, beta: settings.holt.beta, phi: settings.holt.phi };
    } else {
      var ALPHAS = [0.3, 0.5, 0.7, 0.9], BETAS = [0.01, 0.05, 0.1], PHIS = [0.8, 0.9, 0.95, 0.99];
      best = null;
      for (var ia = 0; ia < ALPHAS.length; ia++)
        for (var ib = 0; ib < BETAS.length; ib++)
          for (var ip = 0; ip < PHIS.length; ip++) {
            var f = fitDampedHolt(y, ALPHAS[ia], BETAS[ib], PHIS[ip]);
            var sse = 0;
            for (var i = 0; i < f.errors.length; i++) sse += f.errors[i] * f.errors[i];
            if (!best || sse < best.sse)
              best = { sse: sse, l: f.l, b: f.b, errors: f.errors, alpha: ALPHAS[ia], beta: BETAS[ib], phi: PHIS[ip] };
          }
    }
    var fc = [], s = 0, pk = 1;
    for (var k = 1; k <= h; k++) { pk *= best.phi; s += pk; fc.push(best.l + s * best.b); }
    return { forecast: fc, errors: best.errors, params: { alpha: best.alpha, beta: best.beta, phi: best.phi } };
  }

  /* SES с подбором α (для Theta) */
  function sesBest(y) {
    var best = null;
    for (var ai = 1; ai <= 9; ai++) {
      var alpha = ai / 10;
      var l = y[0], sse = 0;
      for (var i = 1; i < y.length; i++) {
        var e = y[i] - l;
        sse += e * e;
        l += alpha * e;
      }
      if (!best || sse < best.sse) best = { sse: sse, level: l, alpha: alpha };
    }
    return best;
  }

  /* Theta-метод: тета-линия θ=2 (удвоенная кривизна минус тренд) + SES на ней,
     итог — полусумма с экстраполяцией линейного тренда */
  function thetaForecast(y, h) {
    var n = y.length;
    var reg = ols(y);
    var z2 = [];
    for (var i = 0; i < n; i++) z2.push(2 * y[i] - (reg.a + reg.b * i));
    var fit = sesBest(z2);
    var fc = [];
    for (var k = 1; k <= h; k++) fc.push(0.5 * (fit.level + reg.a + reg.b * (n - 1 + k)));
    return { forecast: fc, alpha: fit.alpha };
  }

  /* ансамбль: damped Holt + Theta + наивный дрейф; точка — медиана трёх (log);
     полоса 90%: робастная σ·√h плюс разброс между моделями (расходятся — полоса шире) */
  function ensembleForecast(logY, h) {
    var n = logY.length;
    var dh = dampedHoltBest(logY, h);
    var th = thetaForecast(logY, h);
    var drift = (logY[n - 1] - logY[0]) / (n - 1);
    var sig = robustSigma(dh.errors);
    var fc = [], bandHi = [], bandLo = [];
    for (var k = 0; k < h; k++) {
      var v1 = dh.forecast[k], v2 = th.forecast[k], v3 = logY[n - 1] + (k + 1) * drift;
      var m = med3(v1, v2, v3);
      var mean = (v1 + v2 + v3) / 3;
      var spread = Math.sqrt(((v1 - mean) * (v1 - mean) + (v2 - mean) * (v2 - mean) + (v3 - mean) * (v3 - mean)) / 2);
      var half = 1.645 * Math.sqrt(sig * sig * (k + 1) + spread * spread);
      fc.push(m); bandHi.push(m + half); bandLo.push(m - half);
    }
    return { forecast: fc, bandHi: bandHi, bandLo: bandLo, sigma: sig, params: dh.params, thetaAlpha: th.alpha };
  }

  /* OLS: y = a + b*t; возвращает a, b, R^2 */
  function ols(y) {
    var n = y.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) { sx += i; sy += y[i]; sxy += i * y[i]; sxx += i * i; }
    var b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    var a = (sy - b * sx) / n;
    var my = sy / n, ssRes = 0, ssTot = 0;
    for (i = 0; i < n; i++) {
      var f = a + b * i;
      ssRes += (y[i] - f) * (y[i] - f);
      ssTot += (y[i] - my) * (y[i] - my);
    }
    return { a: a, b: b, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
  }

  /* даты прогноза: будущие дни установки курса ЦБ РФ (вт–пт, без госпраздников) */
  function nextCbrDays(lastISO, count) {
    var d = new Date(lastISO + 'T12:00:00Z');
    var out = [];
    while (out.length < count) {
      d = new Date(d.getTime() + 864e5);
      if (isCbrRateDay(d)) out.push(isoDay(d));
    }
    return out;
  }

  /* ---------- кэш подневных курсов ЦБ ---------- */
  /* cbrd:{дата} → JSON-строка {КОД: руб за 1 ед.} (все 54 валюты дня) или 'none'.
     Зеркало в памяти хранит СЫРЫЕ строки: localStorage — синхронный, а полный JSON.parse
     ~1000 словарей по 54 валюты на слабом CPU — секунды. Нам нужны только 2 кода пары,
     поэтому вместо парсинга — быстрый поиск подстроки (нативный indexOf). */
  var dayMem = {};
  var dayMemMiss = {};
  function cbrDayRaw(d) {
    if (d in dayMem) return dayMem[d];
    if (dayMemMiss[d]) return null;
    var raw = null;
    try { raw = localStorage.getItem('cbrd:' + d); } catch (e) { raw = null; }
    if (raw == null) dayMemMiss[d] = 1; else dayMem[d] = raw;
    return raw;
  }
  function cbrDaySetRaw(d, raw) {
    dayMem[d] = raw;
    delete dayMemMiss[d];
    try { localStorage.setItem('cbrd:' + d, raw); } catch (e) { /* квота — останется в памяти */ }
  }
  /* курс одной валюты из подневного JSON без полного парсинга; RUB = 1 */
  function rateFromRaw(raw, code) {
    if (code === 'RUB') return 1;
    var key = '"' + code + '":';
    var i = raw.indexOf(key);
    if (i === -1) return null;
    var j = i + key.length, k = j;
    while (k < raw.length) {
      var c = raw.charCodeAt(k);
      if (c === 44 || c === 125) break; /* ',' или '}' */
      k++;
    }
    var v = parseFloat(raw.slice(j, k));
    return isNaN(v) ? null : v;
  }
  function purgeLegacyCache() {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('cbr1:') === 0 || k.indexOf('cbr2:') === 0) localStorage.removeItem(k);
      });
    } catch (e) { /* noop */ }
  }

  /* Дни, когда ЦБ РФ курс не устанавливает: выходные, понедельники (пятничный курс
     действует сб–пн) и фиксированные госпраздники РФ. Их не запрашиваем вовсе. */
  var RU_HOLIDAYS = { '01-01': 1, '01-02': 1, '01-03': 1, '01-04': 1, '01-05': 1, '01-06': 1, '01-07': 1, '01-08': 1, '02-23': 1, '03-08': 1, '05-01': 1, '05-09': 1, '06-12': 1, '11-04': 1 };
  function isCbrRateDay(d) {
    var w = d.getUTCDay();
    if (w === 0 || w === 1 || w === 6) return false;
    return !RU_HOLIDAYS[isoDay(d).slice(5)];
  }

  /* ---------- локальная база курсов ---------- */
  /* Источник — fx-history.js (window.FX_HIST): {generated, from, to, lastDate,
     ids, names, cur:{КОД:{ISO: руб за 1 ед.}}}. Новые дни, догруженные с зеркала,
     дописываются в память и в localStorage-дельту ('fx:delta'); кнопка
     «Сохранить базу» сшивает базу с дельтой и перезаписывает fx-history.js. */
  var DB = {
    cur: {},        // КОД -> {ISO: курс} — база + дельта, рабочая копия в памяти
    names: {},      // КОД -> название
    from: '', to: '', lastDate: '', generated: '',
    delta: {},      // КОД -> {ISO: курс} — только догруженное за сессии (для сохранения)
    dirtyDays: {}   // ISO -> 1 — даты, которых нет в файле fx-history.js
  };
  function dbInit() {
    var H = window.FX_HIST || {};
    DB.cur = H.cur || {};
    DB.names = { RUB: 'Российский рубль' };
    Object.keys(H.names || {}).forEach(function (cc) { DB.names[cc] = H.names[cc]; });
    DB.from = H.from || ''; DB.to = H.to || '';
    DB.lastDate = H.lastDate || ''; DB.generated = H.generated || '';
    /* дельта из прошлых сессий (ещё не слита в файл) */
    try {
      var d = JSON.parse(localStorage.getItem('fx:delta') || 'null');
      if (d && d.cur) {
        Object.keys(d.cur).forEach(function (cc) {
          if (!DB.cur[cc]) DB.cur[cc] = {};
          if (!DB.delta[cc]) DB.delta[cc] = {};
          Object.keys(d.cur[cc]).forEach(function (iso) {
            DB.cur[cc][iso] = d.cur[cc][iso];
            DB.delta[cc][iso] = d.cur[cc][iso];
            DB.dirtyDays[iso] = 1;
            if (iso > DB.lastDate) DB.lastDate = iso;
          });
        });
      }
    } catch (e) { /* noop */ }
  }
  /* записать один день установки (dict: {КОД: руб за 1 ед.}) в память + дельту */
  function dbPut(iso, dict) {
    if (!dict) return;
    var inFile = window.FX_HIST && window.FX_HIST.cur;
    Object.keys(dict).forEach(function (cc) {
      var v = dict[cc];
      if (v == null || !isFinite(v)) return;
      if (!DB.cur[cc]) DB.cur[cc] = {};
      /* не затираем и не дублируем: если дата уже в файле базы с тем же
         значением — это не дельта */
      var already = inFile && window.FX_HIST.cur[cc] && window.FX_HIST.cur[cc][iso];
      DB.cur[cc][iso] = v;
      if (already == null || already !== v) {
        if (!DB.delta[cc]) DB.delta[cc] = {};
        DB.delta[cc][iso] = v;
        DB.dirtyDays[iso] = 1;
      }
    });
    if (iso > DB.lastDate) DB.lastDate = iso;
  }
  var deltaSaveTimer = null;
  function dbScheduleSave() {
    /* localStorage синхронный — сбрасываем дельту не чаще раза в 2 сек */
    if (deltaSaveTimer) return;
    deltaSaveTimer = setTimeout(function () {
      deltaSaveTimer = null;
      try { localStorage.setItem('fx:delta', JSON.stringify({ cur: DB.delta })); } catch (e) { /* квота */ }
      updateDbPanel();
    }, 2000);
  }
  /* ряд пары из базы с форвард-филлом (в пн/выходные действует последний курс) */
  function rowsFromDb(startISO, endISO) {
    var bMap = DB.cur[state.base] || {}, qMap = DB.cur[state.quote] || {};
    /* последнее известное значение ДО начала окна — иначе первые выходные пустые */
    var lastB = null, lastQ = null;
    var probe = new Date(startISO + 'T12:00:00Z');
    for (var back = 0; back < 10; back++) {
      probe = new Date(probe.getTime() - 864e5);
      var pb = isoDay(probe);
      if (lastB == null && bMap[pb] != null) lastB = bMap[pb];
      if (lastQ == null && qMap[pb] != null) lastQ = qMap[pb];
      if (lastB != null && lastQ != null) break;
    }
    var rows = [];
    var d = new Date(startISO + 'T12:00:00Z');
    var endD = new Date(endISO + 'T12:00:00Z');
    while (d <= endD) {
      var iso = isoDay(d);
      if (bMap[iso] != null) lastB = bMap[iso];
      if (qMap[iso] != null) lastQ = qMap[iso];
      var vb = state.base === 'RUB' ? 1 : lastB;
      var vq = state.quote === 'RUB' ? 1 : lastQ;
      if (vb != null && vq != null) rows.push({ d: iso, v: vb / vq });
      d = new Date(d.getTime() + 864e5);
    }
    return rows;
  }
  /* список дней установки ЦБ в (lastDate; endISO], которых нет в базе */
  function missingRateDays(endISO) {
    var out = [];
    if (!DB.lastDate) return out;
    var d = new Date(DB.lastDate + 'T12:00:00Z');
    var endD = new Date(endISO + 'T12:00:00Z');
    d = new Date(d.getTime() + 864e5);
    while (d <= endD) {
      if (isCbrRateDay(d)) out.push(isoDay(d));
      d = new Date(d.getTime() + 864e5);
    }
    return out;
  }

  /* Догрузка недостающих дней с зеркала: подневные JSON-файлы, 12 параллельных
     запросов (замеренный оптимум: зеркало режет скорость при ~16+ одновременных),
     кэш в localStorage, прогресс с процентами в статус-панели. Каждый удачный день
     целиком (все валюты) пишется в локальную базу — см. dbPut. */
  function loadMissingDays(days, mySeq) {
    var total = days.length, cachedN = 0;
    var failedDays = []; /* дни, не выдержившие 3 попыток — уйдут в резервный JSONP-канал */
    var idx = 0;
    var lastRep = -1e9;
    function report(force) {
      if (mySeq !== loadSeq) return; /* не перекрываем актуальный статус */
      var now = Date.now();
      if (!force && now - lastRep < 120) return; /* перерисовка DOM не чаще ~8 раз/сек */
      lastRep = now;
      var extra = cachedN ? ' · из кэша: ' + cachedN : '';
      showState('Догрузка новых курсов ЦБ РФ · ' + idx + ' / ' + total + ' дн.' + extra, true, total ? idx / total : 0);
    }
    report(true); /* сразу показываем 0 %, чтобы было видно, что процесс идёт */
    function worker() {
      return new Promise(function (resolve) {
        function step() {
          if (idx >= total || mySeq !== loadSeq) return resolve(); /* конец или устаревший запрос */
          /* пачка кэш-попаданий — синхронно, но с уступкой кадра между пачками:
             иначе вся обработка идёт одной цепочкой микрозадач и UI «замораживается» */
          var n = 0;
          while (idx < total && n < 90) {
            var raw = cbrDayRaw(days[idx]);
            if (raw == null) break;
            if (raw !== 'none') {
              /* день уже был загружен ранее (кэш), но в базу не попал — дописываем */
              var dictCached = null;
              try { dictCached = JSON.parse(raw); } catch (e) { dictCached = null; }
              if (dictCached) dbPut(days[idx], dictCached);
            }
            idx++; cachedN++; n++;
          }
          dbScheduleSave();
          report(false);
          if (n > 0) { yieldTask(step); return; }
          if (idx >= total || mySeq !== loadSeq) return resolve();
          /* сетевой день: claim (idx++) до fetch, чтобы воркеры не взяли один день дважды.
             До 3 попыток с нарастающей паузой; день после всех попыток не кэшируем —
             его подхватит резервный JSONP-канал в конце загрузки */
          var day = days[idx++];
          var p = day.split('-');
          var url = CBR + '/archive/' + p[0] + '/' + p[1] + '/' + p[2] + '/daily_json.js';
          (function tryFetch(attempt) {
            fetchJSON(url).then(function (data) {
              var dict = null;
              if (data.Valute) {
                dict = {};
                Object.keys(data.Valute).forEach(function (cc) {
                  var r = data.Valute[cc];
                  dict[cc] = r.Value / r.Nominal;
                });
              }
              var rawNew = dict == null ? 'none' : JSON.stringify(dict);
              cbrDaySetRaw(day, rawNew);
              if (dict) { dbPut(day, dict); dbScheduleSave(); }
              report(false);
              step();
            }).catch(function () {
              if (attempt < 3) {
                setTimeout(function () { tryFetch(attempt + 1); }, 800 * attempt);
              } else {
                failedDays.push(day);
                report(false);
                step();
              }
            });
          })(1);
        }
        step();
      });
    }
    var workers = [];
    for (var i = 0; i < 12; i++) workers.push(worker());
    return Promise.all(workers).then(function () {
      /* резервный проход: сбойные дни догружаем JSONP (script-тег вне юрисдикции CORS).
         Колбэк у зеркала общий — строго последовательно */
      if (!failedDays.length) return finish([]);
      var ji = 0;
      var still = [];
      function nextJsonp() {
        if (ji >= failedDays.length || mySeq !== loadSeq) return finish(still);
        var day = failedDays[ji++];
        var p = day.split('-');
        var url = CBR + '/archive/' + p[0] + '/' + p[1] + '/' + p[2] + '/daily_json.js';
        if (mySeq === loadSeq) {
          showState('Резервный канал: догрузка · ' + ji + ' / ' + failedDays.length + ' дн.', true, (total - failedDays.length + ji) / total);
        }
        return jsonpFetch(url).then(function (data) {
          var dict = null;
          if (data.Valute) {
            dict = {};
            Object.keys(data.Valute).forEach(function (cc) {
              var r = data.Valute[cc];
              dict[cc] = r.Value / r.Nominal;
            });
          }
          var rawNew = dict == null ? 'none' : JSON.stringify(dict);
          cbrDaySetRaw(day, rawNew);
          if (dict) { dbPut(day, dict); dbScheduleSave(); }
        }).catch(function () {
          still.push(day);
        }).then(nextJsonp);
      }
      return nextJsonp();
    });

    function finish(stillFailed) {
      /* честный отказ вместо «резинового» графика: если сеть отдала меньше 70% дней,
         форвард-филл превратил бы ряд в ступеньки — лучше явная ошибка с повтором */
      if (stillFailed.length > total * 0.3 && total > 3) {
        throw new Error('Зеркало курсов отдало только ' + (total - stillFailed.length) + ' из ' + total +
          ' дней (основной и резервный каналы). Проверьте соединение и повторите чуть позже.');
      }
      return;
    }
  }

  /* ---------- загрузка ряда + расчёт ---------- */
  var lastRows = null; /* последний загруженный ряд: пересчёт горизонта без обхода кэша */

  /* основной путь: локальная база (fx-history.js + дельта) — сеть не нужна вовсе.
     Сеть нужна только для догрузки дней, которых в базе ещё нет (обычно 0–3 дня). */
  function fetchRows(startISO, endISO, seq) {
    showState('Чтение локальной базы…', true, null);
    var miss = missingRateDays(endISO);
    var after = miss.length ? loadMissingDays(miss, seq) : Promise.resolve();
    return after.then(function () {
      var rows = rowsFromDb(startISO, endISO);
      /* порог от длины окна: ~0.2 от календарных дней — отсев мусора,
         но короткие окна (1М и меньше) не проваливаются */
      var winDays = Math.max(1, Math.round((new Date(endISO) - new Date(startISO)) / 864e5));
      var minRows = Math.max(3, Math.floor(winDays * 0.2));
      if (rows.length < minRows) throw new Error('в локальной базе недостаточно данных за этот период');
      return rows;
    });
  }

  function loadSeries() {
    var seq = ++loadSeq;
    if (state.base === state.quote) { showError('Выберите две разные валюты.'); return; }
    setLed('', 'LOADING');

    var end = new Date();
    var start = new Date(end.getTime() - state.windowDays * 864e5);
    fetchRows(isoDay(start), isoDay(end), seq).then(function (rows) {
      if (seq !== loadSeq) return; /* устаревший ответ */
      lastRows = rows;
      computeAndRender(rows);
      setLed('on', 'LIVE');
    }).catch(function (err) {
      if (seq !== loadSeq) return;
      setLed('err', 'OFFLINE');
      showError('Не удалось загрузить котировки ЦБ РФ (' + err.message + '). Если дело в догрузке новых дней — проверьте соединение и повторите.');
    });
  }

  /* progress: 0..1 — определённый прогресс (бар + %%); null + loading — неопределённый (бегущий бар) */
  function showState(text, loading, progress) {
    var el = $('chartState');
    el.style.display = 'grid';
    var extra = '';
    if (progress != null) {
      var pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
      extra = '<div class="pbar"><div class="pbar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="ppct">' + pct + ' %</div>';
    } else if (loading) {
      extra = '<div class="pbar indet"><div class="pbar-fill"></div></div>';
    }
    el.innerHTML = '<div class="state-box"><div class="t' + (loading ? ' skel' : '') + '">' + text + '</div>' + extra + '</div>';
  }
  function showError(text) {
    var el = $('chartState');
    el.style.display = 'grid';
    el.innerHTML = '<div><div class="t">' + text + '</div>' +
      '<button class="retry" id="retryBtn">Повторить</button></div>';
    $('retryBtn').addEventListener('click', function () { boot(); });
  }
  function hideState() { $('chartState').style.display = 'none'; }

  /* ---------- расчёт и отрисовка ---------- */
  function computeAndRender(rows) {
    var dates = rows.map(function (r) { return r.d; });
    var values = rows.map(function (r) { return r.v; });
    var logY = values.map(Math.log);
    var n = values.length;
    var h = state.horizon;
    lastSeriesEnd = dates[n - 1]; /* для автообновления: следим за новой датой установки */

    /* ансамблевый прогноз: медиана трёх моделей, полоса из робастной σ + разброса моделей */
    var ens = ensembleForecast(logY, h);
    var fcDates = nextCbrDays(dates[n - 1], h);
    var fcVals = ens.forecast.map(Math.exp);
    var bandHi = ens.bandHi.map(Math.exp);
    var bandLo = ens.bandLo.map(Math.exp);

    /* фактическая плотность точек ряда в году (ЦБ ставит курс вт–пт, без праздников) */
    var spanDays = Math.max((new Date(dates[n - 1] + 'T12:00:00Z') - new Date(dates[0] + 'T12:00:00Z')) / 864e5, 1);
    var ppy = (n - 1) / spanDays * 365.25;

    /* долгосрочный тренд (лог-линейная регрессия) */
    var reg = ols(logY);
    var driftDay = reg.b;
    var driftYear = Math.exp(driftDay * ppy) - 1;

    /* волатильность из дневных лог-доходностей */
    var rets = [];
    for (var i = 1; i < n; i++) rets.push(logY[i] - logY[i - 1]);
    var mr = rets.reduce(function (a, x) { return a + x; }, 0) / rets.length;
    var vol = Math.sqrt(rets.reduce(function (a, x) { return a + (x - mr) * (x - mr); }, 0) / Math.max(rets.length - 1, 1)) * Math.sqrt(ppy);

    /* статистика */
    var last = values[n - 1];
    var d1 = n > 1 ? last / values[n - 2] - 1 : null;
    var d30 = n > 30 ? last / values[n - 31] - 1 : null;

    renderStats(last, d1, d30, vol, driftYear, dates[n - 1]);
    renderHead(last, d1);
    renderPeriod(dates, fcDates, n);
    renderChart(dates, values, fcDates, fcVals, bandHi, bandLo, reg, n);
    renderForecastTable(fcDates, fcVals, last);
    renderTrend(driftYear, reg.r2, vol, fcVals, values, dates);
    renderModelParams(ens);
    hideState();
  }

  /* подобранные параметры модели — строкой в панель «Модель» */
  function renderModelParams(ens) {
    var el = $('modelParams');
    if (!el) return;
    var p = ens.params;
    var src = settings.modelMode === 'manual' ? 'Задано вручную' : 'Подобрано по истории';
    el.textContent = src + ': Holt α=' + p.alpha + ', β=' + p.beta + ', φ=' + p.phi +
      ' · Theta α=' + ens.thetaAlpha.toFixed(1) +
      ' · σ ошибок ' + (ens.sigma * 100).toFixed(2).replace('.', ',') + ' %/день';
  }

  function clsOf(x) { return x > 0 ? 'up' : x < 0 ? 'dn' : 'flat'; }

  function renderStats(last, d1, d30, vol, driftYear, lastDate) {
    var k = $('stLastK');
    if (k) k.textContent = 'Курс на ' + fmtDateRU(lastDate);
    $('stLast').textContent = fmt(last);
    $('stLast').className = 'v';
    var e1 = $('stD1'); e1.textContent = fmtPct(d1); e1.className = 'v ' + clsOf(d1);
    var e30 = $('stD30'); e30.textContent = fmtPct(d30); e30.className = 'v ' + clsOf(d30);
    $('stVol').textContent = (vol * 100).toFixed(1).replace('.', ',') + ' %';
    var tr = $('stTrend'); tr.textContent = fmtPct(driftYear, 1); tr.className = 'v small ' + clsOf(driftYear);
  }

  function renderHead(last, d1) {
    $('pairName').textContent = state.base + '/' + state.quote;
    $('pairRate').textContent = fmt(last);
    var c = $('pairChg');
    c.textContent = fmtPct(d1) + ' за день';
    c.className = 'chg ' + clsOf(d1);
  }

  /* периоды анализа — под головой графика, чтобы окно было видно всегда */
  function renderPeriod(dates, fcDates, n) {
    var el = $('chartPeriod');
    if (!el) return;
    el.innerHTML =
      'История: <b>' + fmtDateRU(dates[0]) + ' — ' + fmtDateRU(dates[n - 1]) + '</b> · ' + n + ' точек' +
      '<span class="sep">·</span>Прогноз: <b>' + fmtDateRU(fcDates[0]) + ' — ' + fmtDateRU(fcDates[fcDates.length - 1]) + '</b> · ' + fcDates.length + ' раб. дн.';
  }

  /* ---------- график ---------- */
  function renderChart(dates, values, fcDates, fcVals, bandHi, bandLo, reg, n) {
    /* прореживание истории для отрисовки: на слабом CPU тысяча точек × 5 рядов — секунды;
       даты/значения/тренд режем одним шагом, прогноз (≤60 точек) не трогаем */
    var s = Math.max(1, Math.ceil(n / 420));
    var hDates = [], hVals = [], trendHist = [];
    for (var i = 0; i < n; i++) {
      var tv = Math.exp(reg.a + reg.b * i);
      if (i % s === 0 || i === n - 1) { hDates.push(dates[i]); hVals.push(values[i]); trendHist.push(tv); }
    }
    var m = hVals.length;
    var labels = hDates.concat(fcDates);
    var histData = hVals.concat(new Array(fcDates.length).fill(null));
    /* прогноз начинаем от последней исторической точки, чтобы линия была непрерывной */
    var fcData = new Array(m - 1).fill(null).concat([hVals[m - 1]]).concat(fcVals);
    var hiData = new Array(m - 1).fill(null).concat([hVals[m - 1]]).concat(bandHi);
    var loData = new Array(m - 1).fill(null).concat([hVals[m - 1]]).concat(bandLo);
    var trendAll = trendHist.slice();
    for (var k = 1; k <= fcDates.length; k++) trendAll.push(Math.exp(reg.a + reg.b * (n - 1 + k)));

    var cfg = {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: '90% верх', data: hiData, borderWidth: 0, pointRadius: 0, fill: false, tension: 0 },
          { label: '90% интервал', data: loData, borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(251,191,36,.13)', tension: 0 },
          { label: 'История', data: histData, borderColor: '#22d3ee', borderWidth: 1.6, pointRadius: 0, pointHitRadius: 8, tension: 0.15 },
          { label: 'Прогноз', data: fcData, borderColor: '#fbbf24', borderWidth: 1.8, borderDash: [6, 4], pointRadius: 0, pointHitRadius: 8, tension: 0.15 },
          { label: 'Тренд', data: trendAll, borderColor: 'rgba(139,155,180,.75)', borderWidth: 1.2, borderDash: [2, 4], pointRadius: 0, tension: 0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: false, /* анимация тысячи точек на слабом CPU — главный источник фризов */
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0c1220', borderColor: '#243356', borderWidth: 1,
            titleColor: '#8b9bb4', bodyColor: '#d7e1ef',
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
            padding: 10, displayColors: false,
            filter: function (item) { return item.dataset.label !== '90% верх' && item.parsed.y != null; },
            callbacks: {
              title: function (items) { return items.length ? fmtDateRU(items[0].label) : ''; },
              label: function (item) { return item.dataset.label + ': ' + fmt(item.parsed.y); }
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(26,37,64,.6)' },
            ticks: {
              color: '#5b6b84', maxTicksLimit: (typeof window !== 'undefined' && window.innerWidth < 640) ? 4 : 10, maxRotation: 0,
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: function (val, idx) {
                var l = this.getLabelForValue(val);
                if (typeof l !== 'string') return l;
                /* на длинных окнах (>~13 мес) месяцы без года повторяются и ось
                   читается как один год — добавляем год: «11.2021» */
                var labs = this.chart.data.labels;
                var span = labs.length > 1 ?
                  (new Date(labs[labs.length - 1]) - new Date(labs[0])) / 864e5 : 0;
                return span > 400 ? fmtDateRU(l).slice(3) : fmtDateRU(l).slice(0, 5);
              }
            }
          },
          y: {
            position: 'right',
            grid: { color: 'rgba(26,37,64,.6)' },
            ticks: {
              color: '#5b6b84',
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: function (v) { return fmt(v); }
            }
          }
        }
      }
    };

    if (chart) { chart.destroy(); }
    chart = new Chart($('fxChart').getContext('2d'), cfg);
  }

  /* ---------- таблица прогноза ---------- */
  function renderForecastTable(fcDates, fcVals, last) {
    /* все дни прогноза (до 60) — скролл в панели; иначе при смене горизонта
       первые 15 строк одинаковы и кажется, что таблица не реагирует */
    var html = '';
    var prev = last;
    for (var i = 0; i < fcDates.length; i++) {
      var d = fcVals[i] / prev - 1;
      html += '<tr><td class="d">' + fmtDateRU(fcDates[i]) + '</td><td>' + fmt(fcVals[i]) + '</td>' +
        '<td class="' + clsOf(d) + '">' + fmtPct(d, 2) + '</td></tr>';
      prev = fcVals[i];
    }
    $('fcBody').innerHTML = html;
    $('fcCount').textContent = fmtDateShort(fcDates[0]) + ' — ' + fmtDateShort(fcDates[fcDates.length - 1]) + ' · ' + fcDates.length + ' раб. дн.';
  }

  /* ---------- карточка тренда ---------- */
  function renderTrend(driftYear, r2, vol, fcVals, values, dates) {
    var abs = Math.abs(driftYear);
    var kind, word;
    if (abs < 0.02) { kind = 'flat'; word = 'БОКОВИК'; }
    else if (driftYear > 0) { kind = 'up'; word = 'УКРЕПЛЕНИЕ ' + state.base; }
    else { kind = 'dn'; word = 'ОСЛАБЛЕНИЕ ' + state.base; }
    $('trendBadge').innerHTML = '<span class="badge ' + kind + '">' + word + '</span>';

    var last = values[values.length - 1];
    var fcEnd = fcVals[fcVals.length - 1];
    var fcTotal = fcEnd / last - 1;
    var years = (new Date(dates[dates.length - 1] + 'T12:00:00Z') - new Date(dates[0] + 'T12:00:00Z')) / 864e5 / 365.25;
    var comment;
    if (abs < 0.02) comment = 'Выраженного направленного движения за окно нет — курс колеблется вокруг среднего уровня.';
    else if (driftYear > 0) comment = state.base + ' в среднем укрепляется к ' + state.quote + ' в долгосрочной перспективе.';
    else comment = state.base + ' в среднем ослабевает к ' + state.quote + ' в долгосрочной перспективе.';

    $('trendRows').innerHTML =
      trow('Дрейф, годовых', fmtPct(driftYear, 1), clsOf(driftYear)) +
      trow('Ожидание на ' + state.horizon + ' раб. дн.', fmtPct(fcTotal), clsOf(fcTotal)) +
      trow('Прогноз на ' + fmtDateRU(nextCbrDays(dates[dates.length - 1], state.horizon)[state.horizon - 1]), fmt(fcEnd), '') +
      trow('Сила тренда (R²)', (r2 * 100).toFixed(0) + ' %', '') +
      trow('Волатильность, год.', (vol * 100).toFixed(1).replace('.', ',') + ' %', '') +
      trow('Окно анализа', fmtDateShort(dates[0]) + ' — ' + fmtDateShort(dates[dates.length - 1]) + ' · ~' + years.toFixed(1).replace('.', ',') + ' г.', '') +
      '<p class="note" style="margin-top:10px">' + comment + ' Чем выше R², тем устойчивее тренд; при R² ниже ~30 % тренд скорее шум.</p>';
  }
  function trow(k, v, cls) {
    return '<div class="trow"><span class="k">' + k + '</span><span class="v ' + cls + '">' + v + '</span></div>';
  }

  /* ---------- события ---------- */
  $('baseSel').addEventListener('change', function () { state.base = this.value; loadSeries(); });
  $('quoteSel').addEventListener('change', function () { state.quote = this.value; loadSeries(); });
  $('swapBtn').addEventListener('click', function () {
    var t = state.base; state.base = state.quote; state.quote = t;
    $('baseSel').value = state.base; $('quoteSel').value = state.quote;
    loadSeries();
  });
  /* выбранное окно запоминаем: по умолчанию 6М — холодная загрузка вдвое легче
     (~100 запросов вместо ~200), меньше шансов упереться в per-IP лимит зеркала */
  function applyWindowFromSettings() {
    state.windowDays = settings.winDays;
    var seg = $('winSeg');
    if (seg) seg.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(parseInt(b.dataset.days, 10) === settings.winDays));
    });
  }
  $('winSeg').addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    this.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    btn.setAttribute('aria-pressed', 'true');
    state.windowDays = parseInt(btn.dataset.days, 10);
    settings.winDays = state.windowDays;
    settingsSave();
    loadSeries();
  });
  var horizonTimer = null;
  $('horizon').addEventListener('input', function () {
    state.horizon = parseInt(this.value, 10);
    $('horizonVal').textContent = state.horizon + ' дн.';
    this.style.setProperty('--fill', ((state.horizon - 3) / 57 * 100) + '%');
    clearTimeout(horizonTimer);
    /* горизонт влияет только на расчёт: пересчитываем прогноз из уже загруженного
       ряда, без обхода кэша и оверлея загрузки; если ряд ещё грузится — ничего не
       делаем, завершение loadSeries подхватит актуальный state.horizon */
    horizonTimer = setTimeout(function () { if (lastRows) computeAndRender(lastRows); }, 150);
  });
  $('horizon').style.setProperty('--fill', ((14 - 3) / 57 * 100) + '%');

  /* ---------- настройки (выдвижная панель) ---------- */
  var settings = { autoMin: 0, modelMode: 'auto', holt: { alpha: 0.6, beta: 0.1, phi: 0.95 }, winDays: 180 };
  var lastSeriesEnd = null; /* последняя дата установки в загруженном ряде */
  var autoTimer = null;

  function settingsLoad() {
    try {
      var s = JSON.parse(localStorage.getItem('fx:settings') || 'null');
      if (!s) return;
      if (typeof s.autoMin === 'number') settings.autoMin = s.autoMin;
      if (s.modelMode === 'manual') settings.modelMode = 'manual';
      if (typeof s.winDays === 'number' && [180, 365, 730, 1825, 3650].indexOf(s.winDays) !== -1) settings.winDays = s.winDays;
      if (s.holt) {
        ['alpha', 'beta', 'phi'].forEach(function (k) {
          if (typeof s.holt[k] === 'number') settings.holt[k] = s.holt[k];
        });
      }
    } catch (e) { /* noop */ }
  }
  function settingsSave() {
    try { localStorage.setItem('fx:settings', JSON.stringify(settings)); } catch (e) { /* noop */ }
  }
  function applyAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (settings.autoMin > 0) autoTimer = setInterval(refreshLatest, settings.autoMin * 60000);
  }
  /* мягкое фоновое обновление: зеркало (fetch, затем JSONP). Новая установка ЦБ
     сразу дописывается в локальную базу; лента обновляется всегда */
  function refreshLatest() {
    if (document.hidden) return;
    fetchJSON(CBR + '/daily_json.js', { cache: 'no-store' })
    .catch(function () { return jsonpFetch(CBR + '/daily_json.js'); })
    .then(function (t) {
      var purl = String(t.PreviousURL).replace(/^\/\//, 'https://');
      fetchJSON(purl, { cache: 'no-store' })
      .catch(function () { return jsonpFetch(purl); })
      .then(function (p) {
        loadTicker({ cur: t.Valute, prev: p.Valute });
      }).catch(function () { /* лента останется как есть */ });
      mergeNamesFromSnapshot(t.Valute);
      var latest = String(t.Date).slice(0, 10);
      /* снимок — это тоже день установки: пишем в базу, чтобы потом не догружать */
      if (latest > DB.lastDate) {
        var dict = {};
        Object.keys(t.Valute || {}).forEach(function (cc) {
          var r = t.Valute[cc];
          dict[cc] = r.Value / r.Nominal;
        });
        dbPut(latest, dict);
        dbScheduleSave();
      }
      if (lastSeriesEnd && latest > lastSeriesEnd) loadSeries();
      else updateDbPanel();
    }).catch(function () { /* офлайн — молча пропускаем тик */ });
  }

  function syncAutoSeg() {
    var seg = $('autoSeg');
    if (!seg) return;
    seg.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(parseInt(b.dataset.min, 10) === settings.autoMin));
    });
  }
  function updateCacheInfo() {
    var n = 0, bytes = 0;
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('cbrd:') === 0) { n++; bytes += k.length + (localStorage.getItem(k) || '').length; }
      });
    } catch (e) { /* noop */ }
    var el = $('cacheInfo');
    if (el) el.textContent = n ? n + ' дн. · ~' + Math.max(1, Math.round(bytes * 2 / 1024)) + ' КБ' : 'пусто';
  }
  /* ---------- параметры модели: АВТО / ВРУЧНУЮ ---------- */
  var PARAM_DEFS = [
    { id: 'paAlpha', key: 'alpha', min: 0.1, max: 0.95 },
    { id: 'paBeta', key: 'beta', min: 0, max: 0.3 },
    { id: 'paPhi', key: 'phi', min: 0.8, max: 1 }
  ];
  function fmtParam(v) { return v.toFixed(2).replace('.', ','); }
  function syncModelUI() {
    var seg = $('modelModeSeg');
    if (!seg) return;
    seg.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === settings.modelMode));
    });
    var manual = settings.modelMode === 'manual';
    $('paramSliders').classList.toggle('disabled', !manual);
    PARAM_DEFS.forEach(function (d) {
      var inp = $(d.id);
      inp.disabled = !manual;
      inp.value = settings.holt[d.key];
      $(d.id + 'Val').textContent = fmtParam(settings.holt[d.key]);
      inp.style.setProperty('--fill', ((settings.holt[d.key] - d.min) / (d.max - d.min) * 100) + '%');
    });
  }
  $('modelModeSeg').addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    settings.modelMode = btn.dataset.mode;
    settingsSave();
    syncModelUI();
    /* данные те же — только пересчёт */
    if (lastRows) computeAndRender(lastRows); else loadSeries();
  });
  var paramTimer = null;
  PARAM_DEFS.forEach(function (d) {
    $(d.id).addEventListener('input', function () {
      var v = parseFloat(this.value);
      settings.holt[d.key] = v;
      $(d.id + 'Val').textContent = fmtParam(v);
      this.style.setProperty('--fill', ((v - d.min) / (d.max - d.min) * 100) + '%');
      settingsSave();
      clearTimeout(paramTimer);
      paramTimer = setTimeout(function () { if (lastRows) computeAndRender(lastRows); }, 150);
    });
  });

  function openSettings() {
    closeHelp();
    updateCacheInfo();
    $('settingsDrawer').classList.add('open');
    $('drawerBackdrop').classList.add('open');
    $('settingsDrawer').setAttribute('aria-hidden', 'false');
  }
  function closeSettings() {
    $('settingsDrawer').classList.remove('open');
    $('settingsDrawer').setAttribute('aria-hidden', 'true');
    if (!$('helpDrawer').classList.contains('open')) $('drawerBackdrop').classList.remove('open');
  }
  function openHelp() {
    closeSettings();
    $('helpDrawer').classList.add('open');
    $('drawerBackdrop').classList.add('open');
    $('helpDrawer').setAttribute('aria-hidden', 'false');
  }
  function closeHelp() {
    $('helpDrawer').classList.remove('open');
    $('helpDrawer').setAttribute('aria-hidden', 'true');
    if (!$('settingsDrawer').classList.contains('open')) $('drawerBackdrop').classList.remove('open');
  }
  function closeDrawers() { closeSettings(); closeHelp(); }
  /* высота шапки на мобильном плавает (перенос в две строки) — drawer прибиваем к её нижней кромке */
  function syncHdrH() {
    var h = document.querySelector('.hdr');
    if (h) document.documentElement.style.setProperty('--hdrh', h.offsetHeight + 'px');
  }
  window.addEventListener('resize', syncHdrH);
  window.addEventListener('orientationchange', syncHdrH);
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('helpBtn').addEventListener('click', openHelp);
  $('helpClose').addEventListener('click', closeHelp);
  $('drawerBackdrop').addEventListener('click', closeDrawers);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawers(); });
  $('autoSeg').addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    settings.autoMin = parseInt(btn.dataset.min, 10);
    settingsSave();
    syncAutoSeg();
    applyAuto();
  });
  $('cacheClear').addEventListener('click', function () {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('cbrd:') === 0) localStorage.removeItem(k);
      });
    } catch (e) { /* noop */ }
    dayMem = {}; dayMemMiss = {};
    updateCacheInfo();
    var b = this;
    b.textContent = 'Очищено';
    setTimeout(function () { b.textContent = 'Очистить'; }, 1500);
  });
  var dbSaveBtn = $('dbSave');
  if (dbSaveBtn) dbSaveBtn.addEventListener('click', saveDbFile);
  /* возврат на вкладку — проверить свежесть, если автообновление включено */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && settings.autoMin > 0) refreshLatest();
  });

  /* ---------- панель локальной базы + сохранение в файл ---------- */
  function dirtyCount() { return Object.keys(DB.dirtyDays).length; }
  function updateDbPanel() {
    var info = $('dbInfo'), btn = $('dbSave'), badge = $('dbBadge');
    if (!info) return;
    var n = Object.keys(DB.cur).length;
    info.textContent = n + ' валют · ' + fmtDateRU(DB.from) + ' — ' + fmtDateRU(DB.lastDate);
    var dirty = dirtyCount();
    if (badge) {
      if (dirty > 0) {
        badge.textContent = '+' + dirty + ' дн. не сохранено';
        badge.className = 'db-badge dirty';
      } else {
        badge.textContent = 'сохранена';
        badge.className = 'db-badge';
      }
    }
    if (btn) btn.disabled = dirty === 0;
  }
  /* собрать экспортируемый объект базы: файл + дельта */
  function buildExport() {
    return {
      generated: new Date().toISOString(),
      from: DB.from,
      to: DB.lastDate,
      lastDate: DB.lastDate,
      ids: Object.keys(DB.cur).sort(),
      names: (function () { var m = {}; Object.keys(DB.names).forEach(function (c) { if (c !== 'RUB') m[c] = DB.names[c]; }); return m; })(),
      cur: DB.cur
    };
  }
  function exportText() {
    var h = buildExport();
    return '/* FX Forecast Terminal — локальная база курсов ЦБ РФ.\n' +
      '   Сгенерировано: ' + h.generated + '. Период: ' + h.from + ' .. ' + h.to + '.\n' +
      '   Этот файл перезаписывается кнопкой «Сохранить базу» в приложении. */\n' +
      'window.FX_HIST=' + JSON.stringify(h) + ';\n';
  }
  /* File System Access API (Chrome/Edge): перезаписываем тот же fx-history.js напрямую.
     Хэндл файла запоминаем в IndexedDB — при следующих сессиях перезапись без диалога.
     Firefox/Safari: обычное скачивание с тем же именем (браузер предложит заменить). */
  var saveHandle = null;
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var rq = indexedDB.open('fx-local', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rq = db.transaction('kv').objectStore('kv').get(key);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }
  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rq = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
        rq.onsuccess = function () { resolve(); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }
  function downloadFallback(text) {
    var blob = new Blob([text], { type: 'text/javascript;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fx-history.js';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }
  function afterSaved() {
    /* дельта слита в файл — чистим её и из localStorage */
    DB.delta = {};
    DB.dirtyDays = {};
    try { localStorage.removeItem('fx:delta'); } catch (e) { /* noop */ }
    /* файл теперь совпадает с памятью: обновим window.FX_HIST, чтобы dbPut
       корректно отличал «уже в файле» от новых дат */
    window.FX_HIST = buildExport();
    updateDbPanel();
    var b = $('dbSave');
    if (b) {
      b.textContent = 'Сохранено ✓';
      setTimeout(function () { b.textContent = 'Сохранить базу'; }, 2000);
    }
  }
  function saveDbFile() {
    var text = exportText();
    var btn = $('dbSave');
    function fail(msg) {
      if (btn) { btn.textContent = msg; setTimeout(function () { btn.textContent = 'Сохранить базу'; }, 2500); }
    }
    if (!window.showSaveFilePicker) { downloadFallback(text); afterSaved(); return; }
    var pick = saveHandle ? Promise.resolve(saveHandle) :
      idbGet('fxHandle').catch(function () { return null; }).then(function (h) {
        if (h) return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
          if (p === 'granted') return h;
          return h.requestPermission({ mode: 'readwrite' }).then(function (p2) { return p2 === 'granted' ? h : null; });
        });
        return null;
      }).then(function (h) {
        if (h) return h;
        return window.showSaveFilePicker({
          suggestedName: 'fx-history.js',
          types: [{ description: 'База курсов ЦБ РФ', accept: { 'text/javascript': ['.js'] } }]
        });
      });
    pick.then(function (h) {
      saveHandle = h;
      idbSet('fxHandle', h).catch(function () { /* noop */ });
      return h.createWritable().then(function (w) {
        return w.write(text).then(function () { return w.close(); });
      });
    }).then(function () {
      afterSaved();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return; /* пользователь отменил диалог */
      /* хэндл протух (файл переименовали/удалили) — в следующий раз спросим заново */
      saveHandle = null;
      idbSet('fxHandle', null).catch(function () { /* noop */ });
      downloadFallback(text); afterSaved();
    });
  }
  /* напоминание при закрытии вкладки: браузеры запрещают свой текст в этом
     диалоге (антиспам) — показывается стандартный вопрос «покинуть страницу?» */
  window.addEventListener('beforeunload', function (e) {
    if (dirtyCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- старт ---------- */
  /* лента из локальной базы на холодном старте (без сети): последний и
     предпоследний дни установки; rateOf ждёт {КОД:{Value,Nominal}} — собираем */
  function tickerFromDb() {
    var days = Object.keys(DB.dirtyDays).concat([DB.lastDate]);
    /* две последние даты в базе по любой валюте (USD есть всегда) */
    var usd = DB.cur.USD || {};
    var dates = Object.keys(usd).sort();
    var last = dates[dates.length - 1], prev = dates[dates.length - 2];
    function valuteOf(iso) {
      var v = {};
      Object.keys(DB.cur).forEach(function (cc) {
        if (DB.cur[cc][iso] != null) v[cc] = { Value: DB.cur[cc][iso], Nominal: 1, Name: DB.names[cc] || cc };
      });
      return v;
    }
    if (last) loadTicker({ cur: valuteOf(last), prev: prev ? valuteOf(prev) : null });
  }
  function boot() {
    purgeLegacyCache();
    syncHdrH();
    settingsLoad();
    applyWindowFromSettings();
    syncAutoSeg();
    syncModelUI();
    applyAuto();
    dbInit();
    if (!window.FX_HIST || !DB.cur.USD) {
      setLed('err', 'NO BASE');
      showError('Файл базы fx-history.js не найден или повреждён. Положите его рядом с index.html.');
      return;
    }
    buildCurrencies();
    updateDbPanel();
    /* сеть при старте не нужна: список валют, тикер и график — из локальной базы */
    tickerFromDb();
    loadSeries();
    /* фоново: если есть сеть — догрузить свежую установку в базу и обновить ленту */
    refreshLatest();
  }
  boot();
})();
