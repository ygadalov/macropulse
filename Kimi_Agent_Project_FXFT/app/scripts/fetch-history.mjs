/* Снятие 5-летней истории курсов с официального API ЦБ РФ в api/data/history.json.
   Запуск вручную при обновлении версии: npm run history
   ~35 диапазонных запросов (XML_dynamic), последовательно и с паузами — не досаждаем ЦБ. */
import { mkdir, writeFile } from 'node:fs/promises';

const CBR = 'https://www.cbr.ru/scripts';
const YEARS = Number(process.argv[2]) || 10;

function num(s) { return parseFloat(String(s).replace(',', '.')); }
function ddmmyyyy(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function isoShift(iso, daysDelta) {
  const t = new Date(iso + 'T12:00:00Z').getTime() + daysDelta * 864e5;
  return new Date(t).toISOString().slice(0, 10);
}

async function fetchXml(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 60000);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return new TextDecoder('windows-1251').decode(buf);
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    } finally { clearTimeout(to); }
  }
  throw last;
}

const today = new Date().toISOString().slice(0, 10);
const from = isoShift(today, -Math.round(YEARS * 365.25));

/* карта CharCode → внутренний id ЦБ из актуального снимка */
const daily = await fetchXml(CBR + '/XML_daily.asp');
const ids = {};
const names = {};
{
  const re = /<Valute ID="([^"]+)">([\s\S]*?)<\/Valute>/g;
  let m;
  while ((m = re.exec(daily))) {
    const code = (m[2].match(/<CharCode>([^<]*)<\/CharCode>/) || [])[1];
    const name = (m[2].match(/<Name>([^<]*)<\/Name>/) || [])[1];
    if (code) { ids[code] = m[1]; names[code] = name || code; }
  }
}
const codes = Object.keys(ids);
console.log(`валют в снимке: ${codes.length}, диапазон ${from} .. ${today}`);

const cur = {};
let lastDate = '';
let done = 0;
async function fetchOne(code) {
  const url = `${CBR}/XML_dynamic.asp?date_req1=${ddmmyyyy(from)}&date_req2=${ddmmyyyy(today)}&VAL_NM_RQ=${ids[code]}`;
  try {
    const xml = await fetchXml(url);
    const re = /<Record Date="([^"]+)"[^>]*>([\s\S]*?)<\/Record>/g;
    let m;
    const map = {};
    while ((m = re.exec(xml))) {
      const nominal = +((m[2].match(/<Nominal>([^<]*)<\/Nominal>/) || [])[1] || 1);
      const value = num((m[2].match(/<Value>([^<]*)<\/Value>/) || [])[1]);
      if (Number.isNaN(value)) continue;
      const [dd, mm, yy] = m[1].split('.');
      const iso = `${yy}-${mm}-${dd}`;
      map[iso] = value / (nominal || 1);
      if (iso > lastDate) lastDate = iso;
    }
    cur[code] = map;
    done++;
    console.log(`${code}: ${Object.keys(map).length} записей (${done}/${codes.length})`);
  } catch (e) {
    console.error(`${code}: ОШИБКА ${e.message} — валюта пропущена`);
  }
}
/* 3 в параллель — 10-летние диапазоны тяжёлые (~25 с), последовательно было бы ~25 мин */
for (let i = 0; i < codes.length; i += 3) {
  await Promise.all(codes.slice(i, i + 3).map(fetchOne));
  await new Promise((res) => setTimeout(res, 200)); /* вежливая пауза между пачками */
}

await mkdir('api/data', { recursive: true });
const out = { generated: new Date().toISOString(), from, to: today, lastDate, ids, names, cur };
await writeFile('api/data/history.json', JSON.stringify(out));
console.log(`записано api/data/history.json: ${codes.length} валют, последняя дата ${lastDate}`);
