#!/usr/bin/env node
/* MacroPulse: догрузка дельты курсов НБК (Национальный банк Казахстана) в kzt-history.js.
   Запускается GitHub Actions раз в сутки (см. .github/workflows/daily-update.yml).
   Источник — официальный XML nationalbank.kz/rss/get_rates.cfm?fdate=ДД.ММ.ГГГГ.
   Из браузера он недоступен (CORS закрыт), поэтому догрузка только здесь.
   Без зависимостей: Node >= 20 (fetch встроен). */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'kzt-history.js';
const API = 'https://nationalbank.kz/rss/get_rates.cfm?fdate=';

const isoDay = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');

async function fetchXML(iso, tries = 3) {
  const p = iso.split('-');
  const url = API + `${p[2]}.${p[1]}.${p[0]}`;
  for (let a = 1; a <= tries; a++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'macropulse-bot' } });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      return parseDay(text);
    } catch (e) {
      clearTimeout(to);
      if (a === tries) { console.log(iso + ': ошибка загрузки (' + e.message + ')'); return null; }
      await new Promise(res => setTimeout(res, 1000 * a));
    }
  }
  return null;
}

/* XML дня → { КОД: тенге за 1 ед. валюты } (description/quant) + имена */
function parseDay(text) {
  if (!text || text.indexOf('<item>') === -1) return null;
  const dict = {}, names = {};
  const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    const cc = pick(it, 'title'), fn = pick(it, 'fullname');
    const quant = parseFloat(pick(it, 'quant') || '1');
    const val = parseFloat((pick(it, 'description') || '').replace(',', '.'));
    if (!cc || !isFinite(val) || !isFinite(quant) || !quant) continue;
    dict[cc] = val / quant;
    if (fn) names[cc] = fn.charAt(0).toUpperCase() + fn.slice(1);
  }
  return Object.keys(dict).length ? { dict, names } : null;
}
function pick(item, tag) {
  const m = item.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

/* --- читаем базу --- */
const raw = readFileSync(FILE, 'utf8');
const start = raw.indexOf('window.KZT_HIST=');
if (start === -1) throw new Error('window.KZT_HIST не найден в ' + FILE);
const hist = JSON.parse(raw.slice(start + 'window.KZT_HIST='.length).replace(/;\s*$/, ''));
console.log(`база НБК: ${hist.codes.length} валют, lastDate=${hist.lastDate}`);

/* --- каких дней не хватает (каждый календарный, без фильтра) --- */
const today = new Date();
const days = [];
let d = new Date(hist.lastDate + 'T12:00:00Z');
d = new Date(d.getTime() + 864e5);
while (d <= today) {
  days.push(isoDay(d));
  d = new Date(d.getTime() + 864e5);
}
if (!days.length) { console.log('база НБК актуальна, догрузка не нужна'); process.exit(0); }
console.log('догружаем дни НБК:', days.join(', '));

/* --- догрузка: день-дубликат предыдущего по значениям пропускаем
       (вс/пн = копии субботы, праздники KZ = копии прошлого дня) --- */
let added = 0;
for (const day of days) {
  const res = await fetchXML(day);
  if (!res) { console.log(day + ': нет данных (пропуск)'); continue; }
  const prev = hist.cur[hist.lastDate] || {};
  const same = Object.keys(res.dict).length === Object.keys(prev).length &&
    Object.keys(res.dict).every(cc => prev[cc] === res.dict[cc]);
  if (same) { console.log(day + ': дубликат ' + hist.lastDate + ' (пропуск)'); continue; }
  hist.cur[day] = res.dict;
  Object.assign(hist.names, res.names);
  hist.lastDate = day;
  added++;
  await new Promise(res2 => setTimeout(res2, 300)); /* бережём API НБК */
}

if (!added) { console.log('новых данных НБК не получено'); process.exit(0); }

/* --- записываем --- */
hist.generated = new Date().toISOString().slice(0, 10);
hist.to = hist.lastDate;
const out = '/* FX Forecast Terminal — локальная база курсов НБК (тенге).\n' +
  '   Сгенерировано: ' + hist.generated + '. Период: ' + hist.from + ' .. ' + hist.to + '.\n' +
  '   Перезаписывается ежедневным GitHub Action (scripts/update-kzt-history.mjs);\n' +
  '   из браузера API НБК недоступен (CORS), ручной догрузки нет. */\n' +
  'window.KZT_HIST=' + JSON.stringify(hist) + ';\n';
writeFileSync(FILE, out);
console.log(`готово: +${added} дн. НБК, lastDate=${hist.lastDate}`);
