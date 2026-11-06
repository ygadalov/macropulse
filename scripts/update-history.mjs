#!/usr/bin/env node
/* MacroPulse: догрузка дельты курсов ЦБ РФ в fx-history.js.
   Запускается GitHub Actions раз в сутки (см. .github/workflows/daily-update.yml).
   Источник — открытое JSON-зеркало cbr-xml-daily.ru (те же данные, что cbr.ru).
   Без зависимостей: Node >= 20 (fetch встроен). */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'fx-history.js';
const MIRROR = 'https://www.cbr-xml-daily.ru';

/* Дни без установки курса ЦБ: воскресенье, понедельник, госпраздники РФ.
   Суббота — день установки: файл, датированный субботой, несёт пятничную установку. */
const RU_HOLIDAYS = { '01-01': 1, '01-02': 1, '01-03': 1, '01-04': 1, '01-05': 1, '01-06': 1, '01-07': 1, '01-08': 1, '02-23': 1, '03-08': 1, '05-01': 1, '05-09': 1, '06-12': 1, '11-04': 1 };
const isoDay = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
function isRateDay(d) {
  const w = d.getUTCDay();
  return w !== 0 && w !== 1 && !RU_HOLIDAYS[isoDay(d).slice(5)];
}

async function fetchJSON(url, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ac.signal });
      clearTimeout(to);
      if (r.status === 404) return null;            // дня (ещё) нет — не ошибка
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      clearTimeout(to);
      if (a === tries) throw e;
      await new Promise(res => setTimeout(res, 1000 * a));
    }
  }
  return null;
}

function valuteToDict(valute) {
  const dict = {};
  for (const cc of Object.keys(valute || {})) {
    const r = valute[cc];
    if (r && typeof r.Value === 'number' && r.Nominal) dict[cc] = r.Value / r.Nominal;
  }
  return Object.keys(dict).length ? dict : null;
}

/* регистрация валюты: ids — словарь кодов ЦБ, names — названия */
function register(hist, cc, v) {
  if (!hist.ids[cc] && v.ID) hist.ids[cc] = v.ID;
  if (v.Name) hist.names[cc] = v.Name;
}

/* --- читаем базу --- */
const raw = readFileSync(FILE, 'utf8');
const start = raw.indexOf('window.FX_HIST=');
if (start === -1) throw new Error('window.FX_HIST не найден в ' + FILE);
const hist = JSON.parse(raw.slice(start + 'window.FX_HIST='.length).replace(/;\s*$/, ''));
console.log(`база: ${Object.keys(hist.cur).length} валют, lastDate=${hist.lastDate}`);

/* --- каких дней не хватает --- */
const today = new Date();
const days = [];
let d = new Date(hist.lastDate + 'T12:00:00Z');
d = new Date(d.getTime() + 864e5);
while (d <= today) {
  if (isRateDay(d)) days.push(isoDay(d));
  d = new Date(d.getTime() + 864e5);
}
if (!days.length) { console.log('база актуальна, догрузка не нужна'); process.exit(0); }
console.log('догружаем дни:', days.join(', '));

/* --- догрузка --- */
let added = 0;
for (const day of days) {
  const p = day.split('-');
  const data = await fetchJSON(`${MIRROR}/archive/${p[0]}/${p[1]}/${p[2]}/daily_json.js`);
  const dict = data && valuteToDict(data.Valute);
  if (!dict) { console.log(day + ': нет данных (пропуск)'); continue; }
  for (const cc of Object.keys(dict)) {
    if (!hist.cur[cc]) hist.cur[cc] = {};
    hist.cur[cc][day] = dict[cc];
    register(hist, cc, data.Valute[cc] || {});
  }
  if (day > hist.lastDate) hist.lastDate = day;
  added++;
  await new Promise(res => setTimeout(res, 150)); /* бережём зеркало */
}

if (!added) { console.log('новых данных не получено'); process.exit(0); }

/* --- свежий снимок на всякий случай (вдруг архивный файл дня ещё не выложен) --- */
try {
  const snap = await fetchJSON(MIRROR + '/daily_json.js', 2);
  const day = snap && String(snap.Date).slice(0, 10);
  const dict = snap && valuteToDict(snap.Valute);
  if (day && dict && day > hist.lastDate) {
    for (const cc of Object.keys(dict)) {
      if (!hist.cur[cc]) hist.cur[cc] = {};
      hist.cur[cc][day] = dict[cc];
      register(hist, cc, snap.Valute[cc] || {});
    }
    hist.lastDate = day;
    console.log('снимок добавлен за ' + day);
  }
} catch (e) { console.log('снимок недоступен (не критично):', e.message); }

/* --- записываем --- */
hist.generated = new Date().toISOString();
hist.to = hist.lastDate;
const out = '/* FX Forecast Terminal — локальная база курсов ЦБ РФ.\n' +
  '   Сгенерировано: ' + hist.generated + '. Период: ' + hist.from + ' .. ' + hist.to + '.\n' +
  '   Этот файл перезаписывается кнопкой «Сохранить базу» в приложении. */\n' +
  'window.FX_HIST=' + JSON.stringify(hist) + ';\n';
writeFileSync(FILE, out);
console.log(`готово: +${added} дн., lastDate=${hist.lastDate}`);
