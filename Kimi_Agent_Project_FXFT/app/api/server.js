/*
 * FX Forecast Terminal — мини-бэкенд.
 * Вместо 100–200 подневных запросов браузера к зеркалу сервер забирает у официального
 * API ЦБ РФ (www.cbr.ru/scripts/XML_daily.asp + XML_dynamic.asp) весь диапазон
 * 1–2 запросами на валюту и отдаёт фронтенду готовый JSON. Кэш в памяти процесса.
 *
 * Внешних зависимостей нет: собирается простым копированием в dist/boot.js
 * (см. scripts/build.mjs), поэтому деплой-пакету не нужен node_modules.
 */
import http from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)); // каталог dist/
const PUBLIC = join(ROOT, 'public');

/* Статика читается в память один раз при старте: рабочая директория dist/
   на хосте может быть очищена после запуска, а сервер обязан жить дальше. */
const staticFiles = new Map(); // '/src/main.js' -> Buffer
async function preloadStatic(dir, prefix) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await preloadStatic(full, prefix + entry.name + '/');
    else staticFiles.set(prefix + entry.name, await readFile(full));
  }
}
const PORT = Number(process.env.PORT || 3000);
const CBR = 'https://www.cbr.ru/scripts';

const SNAP_TTL = 10 * 60e3;  // снимок и предыдущая установка
const RANGE_TTL = 10 * 60e3; // диапазоны (сегодняшний день может доустановиться)

/* ---------- кэш с TTL и склейкой параллельных запросов ---------- */
const cache = new Map();
const inflight = new Map();
function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.data);
  const pend = inflight.get(key);
  if (pend) return pend;
  const p = loader()
    .then((d) => { cache.set(key, { t: Date.now(), data: d }); inflight.delete(key); return d; })
    .catch((e) => { inflight.delete(key); throw e; });
  inflight.set(key, p);
  return p;
}

async function fetchXml(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return new TextDecoder('windows-1251').decode(buf);
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 600 * (i + 1)));
    } finally {
      clearTimeout(to);
    }
  }
  throw last;
}

/* ---------- парсинг: структура CBR XML — плоские повторяющиеся блоки ---------- */
function num(s) { return parseFloat(String(s).replace(',', '.')); }

function parseDaily(xml) {
  const date = (xml.match(/<ValCurs[^>]*\sDate="([^"]+)"/) || [])[1] || '';
  const valute = {};
  const re = /<Valute ID="([^"]+)">([\s\S]*?)<\/Valute>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[2];
    const get = (tag) => {
      const mm = b.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
      return mm ? mm[1] : '';
    };
    const code = get('CharCode');
    if (!code) continue;
    valute[code] = {
      CharCode: code,
      Nominal: +get('Nominal') || 1,
      Name: get('Name'),
      Value: num(get('Value')),
      _id: m[1], // внутренний код валюты (R01235) — нужен для XML_dynamic
    };
  }
  return { date, valute };
}

function parseDynamic(xml) {
  const rows = [];
  const re = /<Record Date="([^"]+)"[^>]*>([\s\S]*?)<\/Record>/g;
  let m;
  while ((m = re.exec(xml))) {
    const nominal = +((m[2].match(/<Nominal>([^<]*)<\/Nominal>/) || [])[1] || 1);
    const value = num((m[2].match(/<Value>([^<]*)<\/Value>/) || [])[1]);
    if (Number.isNaN(value)) continue;
    const [dd, mm, yy] = m[1].split('.');
    rows.push({ d: `${yy}-${mm}-${dd}`, v: value / (nominal || 1) }); // руб. за единицу
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : 1));
  return rows;
}

function ddmmyyyy(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function isoShift(iso, daysDelta) {
  const t = new Date(iso + 'T12:00:00Z').getTime() + daysDelta * 864e5;
  return new Date(t).toISOString().slice(0, 10);
}

/* ---------- данные ---------- */
function dailyParsed(dateReq) { // dateReq: 'DD/MM/YYYY' либо '' (актуальная установка)
  return cached('daily:' + (dateReq || 'cur'), SNAP_TTL, () =>
    fetchXml(CBR + '/XML_daily.asp' + (dateReq ? '?date_req=' + encodeURIComponent(dateReq) : ''))
      .then(parseDaily));
}

/* Актуальная установка + предыдущая (для дневных дельт ленты):
   предыдущую ищем шагами назад — date_req возвращает установку, действующую на дату,
   поэтому первый ответ с другой датой и есть предыдущая установка (праздники перешагнём). */
async function snapshot() {
  const cur = await dailyParsed('');
  const [dd, mm, yy] = cur.date.split('.');
  let iso = `${yy}-${mm}-${dd}`;
  let prev = null;
  for (let i = 0; i < 15; i++) {
    iso = isoShift(iso, -1);
    const cand = await dailyParsed(ddmmyyyy(iso));
    if (cand.date && cand.date !== cur.date && Object.keys(cand.valute).length) { prev = cand; break; }
  }
  return { cur, prev };
}

function toMirrorShape(parsed) {
  if (!parsed) return null;
  const out = {};
  Object.keys(parsed.valute).forEach((code) => {
    const v = parsed.valute[code];
    out[code] = { CharCode: v.CharCode, Nominal: v.Nominal, Name: v.Name, Value: v.Value };
  });
  return out;
}

function dynamicSeries(id, fromISO, toISO) {
  return cached(`dyn:${id}:${fromISO}:${toISO}`, RANGE_TTL, () =>
    fetchXml(`${CBR}/XML_dynamic.asp?date_req1=${ddmmyyyy(fromISO)}&date_req2=${ddmmyyyy(toISO)}&VAL_NM_RQ=${id}`)
      .then(parseDynamic));
}

/* ---------- предзагруженная 5-летняя история (api/data/history.json → dist/history.json) ----------
   Любой диапазон внутри истории отдаётся из памяти мгновенно, без обращений к ЦБ;
   свежий хвост (после даты файла) догружается одним диапазонным запросом-дельтой. */
let HIST = null;      // { firstDate, lastDate, ids, cur: {CODE: {dates[], vals[]}} }
async function loadHistory() {
  try {
    const raw = JSON.parse(await readFile(join(ROOT, 'history.json'), 'utf8'));
    const cur = {};
    Object.keys(raw.cur).forEach((code) => {
      const dates = Object.keys(raw.cur[code]).sort();
      /* lastDate — у каждой валюты свой: иначе дельта одной валюты
         закрывала бы догрузку остальных */
      cur[code] = { dates, vals: dates.map((d) => raw.cur[code][d]), lastDate: dates[dates.length - 1] };
    });
    HIST = { firstDate: raw.from, ids: raw.ids || {}, names: raw.names || {}, cur };
    console.log(`история: ${Object.keys(cur).length} валют, ${raw.from} .. ${raw.lastDate}`);
  } catch {
    HIST = null; // файла нет — работаем как раньше, диапазонными запросами к ЦБ
  }
}

/* ---------- фоновое обновление истории: при старте и раз в сутки ----------
   Догружает хвосты по ВСЕМ валютам (последовательно, с паузами — не досаждаем ЦБ)
   и скидывает результат обратно в файл, чтобы перезапуск начинался со свежих данных. */
const HIST_REFRESH_MS = 24 * 3600e3;
let persistTimer = null;
let refreshing = false;

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistHistory, 5000); /* дебаунс: пишем один раз после прогона */
}

async function persistHistory() {
  if (!HIST) return;
  const cur = {};
  let lastDate = '';
  Object.keys(HIST.cur).forEach((code) => {
    const h = HIST.cur[code];
    const map = {};
    for (let i = 0; i < h.dates.length; i++) map[h.dates[i]] = h.vals[i];
    cur[code] = map;
    if (h.lastDate > lastDate) lastDate = h.lastDate;
  });
  const today = new Date().toISOString().slice(0, 10);
  const json = JSON.stringify({
    generated: new Date().toISOString(), from: HIST.firstDate, to: today,
    lastDate, ids: HIST.ids, names: HIST.names, cur,
  });
  /* два пути: dist/ — что читает этот процесс после перезапуска в том же контейнере;
     api/data/ — исходник в проекте (переживёт сборку, попадёт в следующую версию) */
  for (const p of [join(ROOT, 'history.json'), join(ROOT, '..', 'api', 'data', 'history.json')]) {
    try { await writeFile(p, json); } catch { /* ФС может быть только на чтение — не страшно */ }
  }
  console.log(`история сохранена на диск (по ${lastDate})`);
}

async function refreshHistory() {
  if (!HIST || refreshing) return;
  refreshing = true;
  const today = new Date().toISOString().slice(0, 10);
  let touched = 0;
  try {
    for (const code of Object.keys(HIST.cur)) {
      const h = HIST.cur[code];
      if (h.lastDate >= today) continue;
      try {
        const delta = await dynamicSeries(HIST.ids[code], isoShift(h.lastDate, 1), today);
        for (const r of delta) {
          if (r.d > h.lastDate) { h.dates.push(r.d); h.vals.push(r.v); }
        }
        if (delta.length) { h.lastDate = delta[delta.length - 1].d; touched++; }
      } catch (e) {
        console.error(`история: дельта ${code} не загрузилась: ${e.message}`);
      }
      await new Promise((res) => setTimeout(res, 150)); /* вежливая пауза между валютами */
    }
  } finally {
    refreshing = false;
  }
  if (touched) { console.log(`история: догружено ${touched} валют`); schedulePersist(); }
}

/* срез истории по валюте; если запрошенный хвост свежее файла — догружаем дельту с ЦБ */
async function histLeg(code, toISO) {
  const h = HIST.cur[code];
  if (!h) return null;
  if (toISO > h.lastDate) {
    try {
      const delta = await dynamicSeries(HIST.ids[code], isoShift(h.lastDate, 1), toISO);
      for (const r of delta) {
        if (r.d > h.lastDate) { h.dates.push(r.d); h.vals.push(r.v); }
      }
      if (delta.length) { h.lastDate = delta[delta.length - 1].d; schedulePersist(); }
    } catch { /* ЦБ недоступен — отдадим что есть, дельту возьмём в следующий раз */ }
  }
  return h;
}

async function legRows(code, fromISO, toISO) {
  if (code === 'RUB') return null;
  if (HIST && fromISO >= HIST.firstDate) {
    const h = await histLeg(code, toISO);
    if (h) {
      const rows = [];
      for (let i = 0; i < h.dates.length; i++) {
        const d = h.dates[i];
        if (d >= fromISO && d <= toISO) rows.push({ d, v: h.vals[i] });
      }
      return rows;
    }
  }
  /* нет в истории (диапазон раньше файла или новая валюта) — полный диапазон с ЦБ */
  const { cur } = await snapshot();
  const v = cur.valute[code];
  if (!v) throw new Error('unknown currency ' + code);
  return dynamicSeries(v._id, fromISO, toISO);
}

/* ряд пары: кросс через рублёвые курсы обеих валют (RUB = 1) */
async function pairSeries(base, quote, fromISO, toISO) {
  const [bRows, qRows] = await Promise.all([legRows(base, fromISO, toISO), legRows(quote, fromISO, toISO)]);
  const bMap = new Map((bRows || []).map((r) => [r.d, r.v]));
  const qMap = new Map((qRows || []).map((r) => [r.d, r.v]));
  const dates = [...new Set([...bMap.keys(), ...qMap.keys()])].sort();
  const rows = [];
  let lastB = null, lastQ = null;
  for (const d of dates) {
    if (bMap.has(d)) lastB = bMap.get(d);
    if (qMap.has(d)) lastQ = qMap.get(d);
    const vb = base === 'RUB' ? 1 : lastB;
    const vq = quote === 'RUB' ? 1 : lastQ;
    if (vb != null && vq != null) rows.push({ d, v: vb / vq });
  }
  return rows;
}

/* ---------- HTTP ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z]{3}$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (path === '/api/health') return sendJson(res, 200, { ok: true });

    if (path === '/api/snapshot') {
      const { cur, prev } = await snapshot();
      const [dd, mm, yy] = cur.date.split('.');
      return sendJson(res, 200, {
        Date: `${yy}-${mm}-${dd}`,
        Valute: toMirrorShape(cur),
        PrevValute: toMirrorShape(prev),
      });
    }

    if (path === '/api/series') {
      const base = url.searchParams.get('base') || '';
      const quote = url.searchParams.get('quote') || '';
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      if (!CODE_RE.test(base) || !CODE_RE.test(quote) || !ISO_RE.test(from) || !ISO_RE.test(to) || base === quote || from > to) {
        return sendJson(res, 400, { error: 'bad params' });
      }
      const rows = await pairSeries(base, quote, from, to);
      if (!rows.length) return sendJson(res, 502, { error: 'not enough data from CBR' });
      return sendJson(res, 200, { base, quote, from, to, rows });
    }

    if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'Not Found' });

    /* статика — из памяти (см. preloadStatic) */
    let rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    if (path === '/' || rel === '') rel = 'index.html';
    const data = staticFiles.get(rel);
    if (!data) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[extname(rel).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (e) {
    if (e && e.code === 'ENOENT') { res.writeHead(404); return res.end('not found'); }
    console.error(new Date().toISOString(), req.url, e && e.message);
    if (req.url.startsWith('/api/')) return sendJson(res, 502, { error: 'upstream CBR failed' });
    res.writeHead(500); res.end('error');
  }
});

await preloadStatic(PUBLIC, '');
await loadHistory();
refreshHistory(); /* фоном при старте, отдачу страниц не блокирует */
setInterval(refreshHistory, HIST_REFRESH_MS).unref(); /* и дальше раз в сутки */
server.listen(PORT, () => {
  console.log(`FX Forecast Terminal backend: http://localhost:${PORT} (статика: ${staticFiles.size} файла в памяти)`);
});
