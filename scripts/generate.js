// Test A — Render-Pipeline
// Datenquelle (ICS-Feed ODER EM-REST-API) -> Wochen-Events filtern -> PNG-Kacheln (1080x1080)
//   + events-KWxx.csv (fuer Figma) + index.html (Galerie). Alles nach output/, das GitHub Pages publiziert.
//
// Quelle umschaltbar via SOURCE=ics (Standard) oder SOURCE=em-rest.
// ICS funktioniert anonym, ist aber auf 50 Events ab dem aeltesten limitiert
//   -> fuer Produktion SOURCE=em-rest mit WP_USER/WP_APP_PASSWORD nutzen (aktuelle Daten).

import 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ical from 'node-ical';
import puppeteer from 'puppeteer';
import {
  addWeeks, startOfWeek, endOfWeek, format, parseISO, isWithinInterval,
} from 'date-fns';
import { de } from 'date-fns/locale';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output');
const TEMPLATE = path.join(ROOT, 'template', 'kachel.html');

// --- Minimaler .env-Loader (keine Dependency noetig) ---
async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* keine .env -> nur echte Umgebungsvariablen */ }
}

// --- HTML/Entities aus Texten entfernen (EM-Beschreibungen enthalten HTML) ---
function clean(str = '') {
  return String(str)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

// LOCATION ist "Venue, Strasse, Ort, Land" -> nur den Venue-Namen fuer die Kachel
function venue(loc = '') {
  return clean(loc).split(',')[0].trim();
}

function truncate(str, n) {
  const s = clean(str);
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// CSV-Feld korrekt quoten
function csvCell(v = '') {
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function htmlEscape(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Quelle 1: ICS-Feed ---
async function fetchFromICS(url) {
  const data = await ical.async.fromURL(url);
  const events = [];
  for (const k of Object.keys(data)) {
    const e = data[k];
    if (e.type !== 'VEVENT') continue;
    events.push({
      title: clean(e.summary),
      start: e.start,             // node-ical liefert echte Date-Objekte
      end: e.end,
      location: venue(e.location),
      description: e.description ? clean(e.description) : '',
      url: e.url || '',
    });
  }
  return events;
}

// --- Quelle 2: EM-REST-API (Produktion, aktuelle Daten) ---
// Aktiviert via SOURCE=em-rest. Braucht WP_BASE_URL, WP_USER, WP_APP_PASSWORD.
// Hinweis: Feld-Mapping ggf. an die reale Antwort anpassen, sobald Credentials da sind.
async function fetchFromEMRest() {
  const base = process.env.WP_BASE_URL;
  const auth = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
  const res = await fetch(`${base}/wp-json/events-manager/v1/events?scope=future&per_page=50`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`EM-REST ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const arr = Array.isArray(json) ? json : (json.events || json.data || []);
  return arr.map((e) => ({
    title: clean(e.event_name || e.title),
    start: new Date(e.event_start_date ? `${e.event_start_date}T${e.event_start_time || '00:00:00'}` : e.start),
    end: new Date(e.event_end_date ? `${e.event_end_date}T${e.event_end_time || '00:00:00'}` : e.end),
    location: venue(e.location_name || e.location?.location_name || ''),
    description: clean(e.post_content || e.description || ''),
    url: e.event_url || e.link || '',
  }));
}

function timeLabel(ev) {
  const start = format(ev.start, 'HH:mm');
  const end = ev.end && !isNaN(ev.end) ? '–' + format(ev.end, 'HH:mm') : '';
  return `${start}${end} Uhr`;
}

// --- CSV fuer Figma (Daten-Sync-Plugins) — eine Zeile pro Event ---
async function writeCsv(events, kw) {
  const header = ['kw', 'weekday', 'date', 'time', 'title', 'location', 'description', 'url'];
  const rows = events.map((ev) => [
    kw,
    format(ev.start, 'EEEE', { locale: de }),
    format(ev.start, 'dd.MM.yyyy'),
    timeLabel(ev),
    ev.title,
    ev.location,
    ev.description,
    ev.url,
  ].map(csvCell).join(','));
  const csv = [header.join(','), ...rows].join('\n') + '\n';
  await fs.writeFile(path.join(OUT, `events-KW${kw}.csv`), csv, 'utf8');
}

// --- Galerie-Seite (fester Link fuer die Redaktion) — Karussell-Slides in Reihenfolge ---
async function writeIndex(slides, kw, weekStart, weekEnd) {
  const range = `${format(weekStart, 'dd.MM.')}–${format(weekEnd, 'dd.MM.yyyy')}`;
  const cards = slides.map((s, idx) => `
    <figure class="card">
      <a href="${s.name}" download><img src="${s.name}" alt="${htmlEscape(s.caption)}" loading="lazy"></a>
      <figcaption>
        <strong>${String(idx + 1).padStart(2, '0')} · ${htmlEscape(s.caption)}</strong>
        <a class="dl" href="${s.name}" download>PNG herunterladen</a>
      </figcaption>
    </figure>`).join('');

  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>WIR · Halle — Kacheln KW ${kw}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#12121f;color:#fff;margin:0;padding:40px}
  header{max-width:1100px;margin:0 auto 28px}
  h1{margin:0;font-size:30px}.sub{color:#b8b8d0;margin-top:6px}
  .csv{display:inline-block;margin-top:16px;background:#e94560;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}
  .grid{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:22px}
  .card{margin:0;background:#1a1a2e;border-radius:12px;overflow:hidden}
  .card img{width:100%;display:block}
  figcaption{padding:14px;display:flex;flex-direction:column;gap:6px;font-size:14px}
  figcaption span{color:#b8b8d0}
  .dl{color:#e94560;text-decoration:none;font-weight:600;margin-top:4px}
  .cover{max-width:1100px;margin:0 auto 22px}.cover img{width:100%;max-width:420px;border-radius:12px;display:block}
</style></head>
<body>
  <header>
    <h1>Diese Woche bei WIR — KW ${kw}</h1>
    <div class="sub">${range} · ${slides.length} Karussell-Slide${slides.length === 1 ? '' : 's'} · automatisch generiert</div>
    <a class="csv" href="events-KW${kw}.csv" download>📄 CSV für Figma herunterladen</a>
    <a class="csv" style="background:#333" href="uebersicht.html">🌐 Website-Übersicht (Vorschau)</a>
  </header>
  <div class="grid">${cards}</div>
</body></html>\n`;
  await fs.writeFile(path.join(OUT, 'index.html'), html, 'utf8');
}

// --- Website-Wochenuebersicht (Vorschau = exaktes HTML, das der WP-Shortcode spaeter ausgibt) ---
// Pflicht aus dem Briefing: Liste statt Kacheln, im CD, "ansprechend + uebersichtlich".
// Im WP-Plugin ersetzt eine EM-Schleife (scope=this-week, nur veroeffentlichte Events) die statischen <article>.
async function writeOverview(events, kw, weekStart, weekEnd) {
  const range = `${format(weekStart, 'dd.MM.')}–${format(weekEnd, 'dd.MM.yyyy')}`;
  const rows = events.map((ev) => `
    <article class="event">
      <time class="date" datetime="${format(ev.start, 'yyyy-MM-dd')}">
        <span class="wd">${htmlEscape(format(ev.start, 'EE', { locale: de }))}</span>
        <span class="d">${htmlEscape(format(ev.start, 'dd.MM.', { locale: de }))}</span>
      </time>
      <div class="info">
        <h2>${htmlEscape(ev.title)}</h2>
        <p class="meta">${htmlEscape(timeLabel(ev))}${ev.location ? ' · 📍 ' + htmlEscape(ev.location) : ''}</p>
        <p class="desc">${htmlEscape(truncate(ev.description, 180))}</p>
        ${ev.url ? `<a class="more" href="${ev.url}">Mehr erfahren →</a>` : ''}
      </div>
    </article>`).join('');

  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>WIR · Halle — Wochenübersicht KW ${kw}</title>
<style>
  /* PLATZHALTER-CD — echte Farben/Fonts ersetzen diese Werte. */
  :root{--accent:#e94560;--ink:#1a1a2e;--muted:#5b5b70;--line:#ececf2;--bg:#ffffff}
  *{box-sizing:border-box}
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f8;color:var(--ink);margin:0;padding:40px}
  .wrap{max-width:760px;margin:0 auto;background:var(--bg);border-radius:16px;overflow:hidden;box-shadow:0 4px 30px rgba(0,0,0,.06)}
  header{padding:32px 36px;border-bottom:4px solid var(--accent)}
  header h1{margin:0;font-size:26px}
  header .sub{color:var(--muted);margin-top:6px;font-size:15px}
  .event{display:flex;gap:24px;padding:24px 36px;border-bottom:1px solid var(--line)}
  .event:last-child{border-bottom:0}
  .date{flex:0 0 64px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:4px}
  .date .wd{font-size:14px;color:var(--accent);font-weight:700;text-transform:uppercase}
  .date .d{font-size:20px;font-weight:800}
  .info h2{margin:0 0 6px;font-size:20px;line-height:1.2}
  .info .meta{margin:0 0 8px;color:var(--accent);font-weight:600;font-size:15px}
  .info .desc{margin:0 0 8px;color:var(--muted);font-size:15px;line-height:1.5}
  .info .more{color:var(--accent);text-decoration:none;font-weight:600;font-size:15px}
  footer{padding:20px 36px;color:var(--muted);font-size:13px}
</style></head>
<body>
  <div class="wrap">
    <header>
      <h1>Diese Woche bei WIR</h1>
      <div class="sub">KW ${kw} · ${range} · ${events.length} Veranstaltung${events.length === 1 ? '' : 'en'}</div>
    </header>
    ${rows || '<div class="event"><div class="info"><p class="desc">Diese Woche sind keine Veranstaltungen eingetragen.</p></div></div>'}
    <footer>Automatisch erzeugt aus dem Veranstaltungskalender · wir-halle.de</footer>
  </div>
</body></html>\n`;
  await fs.writeFile(path.join(OUT, 'uebersicht.html'), html, 'utf8');
}

// --- Karussell: Tages-Slide (Datums-Header oben + kompakte Event-Liste) ---
function eventRow(ev) {
  return `<li><span class="t">${htmlEscape(format(ev.start, 'HH:mm'))}</span>`
    + `<span class="r"><span class="ti">${htmlEscape(truncate(ev.title, 95))}</span>`
    + `${ev.location ? `<span class="loc">📍 ${htmlEscape(ev.location)}</span>` : ''}</span></li>`;
}

// Eine Slide kann mehrere Tages-Abschnitte (sections) enthalten; jeder beginnt mit seinem Datum.
function slideMultiHtml(kw, sections) {
  const blocks = sections.map((s) => `
    <section class="day">
      <h2 class="datehead">${htmlEscape(s.dateLine)}${s.isCont ? ' <span class="cont">· Fortsetzung</span>' : ''}</h2>
      <ul class="list">${s.rows.join('')}</ul>
    </section>`).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  /* PLATZHALTER-CD — echte Farben/Fonts ersetzen diese Werte. */
  .slide{position:relative;width:1080px;height:1080px;overflow:hidden;
    font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#1a1a2e;color:#fff;padding:70px 80px}
  .slide::before{content:"";position:absolute;left:0;top:0;bottom:0;width:22px;background:#e94560}
  .brand{font-size:30px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#e94560}
  .kw{font-size:24px;color:#b8b8d0;margin-top:4px}
  .day{margin-top:42px}
  .day:first-of-type{margin-top:30px}
  .day + .day{padding-top:34px;border-top:2px solid rgba(255,255,255,.16)}
  .datehead{font-size:48px;font-weight:800;line-height:1.05}
  .cont{font-size:26px;color:#b8b8d0;font-style:italic;font-weight:600}
  ul.list{list-style:none;margin-top:20px}
  li{display:flex;gap:24px;padding:18px 0;border-bottom:1px solid rgba(255,255,255,.12);align-items:flex-start}
  li:last-child{border-bottom:0}
  .t{flex:0 0 140px;font-size:36px;font-weight:800;color:#e94560;white-space:nowrap;line-height:1.2}
  .r{display:flex;flex-direction:column}
  .ti{font-size:34px;font-weight:700;line-height:1.18}
  .loc{font-size:26px;color:#b8b8d0;margin-top:6px}
  </style></head><body><div class="slide">
    <div class="brand">WIR · Halle</div><div class="kw">Kalenderwoche ${kw}</div>
    ${blocks}
  </div></body></html>`;
}

// Bin-Packing auf Tagesebene: ganze Tage hintereinander auf eine Slide, solange Platz ist.
// Passt der naechste ganze Tag nicht mehr -> Weissraum lassen, neue Slide. Ein einzelner
// Tag, der allein nicht auf eine Slide passt, wird (nur dann) auf Folge-Slides aufgeteilt.
async function packSlides(page, kw, days) {
  const slides = [];
  let cur = [];
  const mkSec = (day, isCont, rows) => ({ dateLine: day.dateLine, short: day.short, isCont, rows });
  const fits = async (sections) => {
    await page.setContent(slideMultiHtml(kw, sections), { waitUntil: 'load' });
    const ov = await page.evaluate(() => { const e = document.querySelector('.slide'); return e.scrollHeight - e.clientHeight; });
    return ov <= 1;
  };

  for (const day of days) {
    // 1) Passt der ganze Tag noch zusaetzlich auf die aktuelle Slide?
    if (await fits(cur.concat([mkSec(day, false, day.rows)]))) {
      cur = cur.concat([mkSec(day, false, day.rows)]);
      continue;
    }
    // 2) Nein -> aktuelle Slide abschliessen (Weissraum bleibt), Tag auf frischer Slide versuchen.
    if (cur.length > 0) {
      slides.push(cur);
      cur = [];
      if (await fits([mkSec(day, false, day.rows)])) { cur = [mkSec(day, false, day.rows)]; continue; }
    }
    // 3) Tag passt auch allein nicht -> auf Folge-Slides aufteilen.
    let i = 0; let first = true;
    while (i < day.rows.length) {
      let fitTo = i;
      for (let j = i; j < day.rows.length; j += 1) {
        if (await fits(cur.concat([mkSec(day, !first, day.rows.slice(i, j + 1))]))) fitTo = j; else break;
      }
      cur = cur.concat([mkSec(day, !first, day.rows.slice(i, fitTo + 1))]);
      i = fitTo + 1; first = false;
      if (i < day.rows.length) { slides.push(cur); cur = []; } // letzter Teil bleibt in cur -> naechster Tag darf folgen
    }
  }
  if (cur.length > 0) slides.push(cur);
  return slides;
}

// === System B: Datum an jeder Zeile (Chip), Events fliessen durch, Slides voll ===
function eventRowB(ev) {
  return `<li>
    <div class="chip"><span class="wd">${htmlEscape(format(ev.start, 'EE', { locale: de }))}</span><span class="dn">${htmlEscape(format(ev.start, 'dd.MM.', { locale: de }))}</span></div>
    <div class="r"><span class="ti"><span class="time">${htmlEscape(format(ev.start, 'HH:mm'))}</span>${htmlEscape(truncate(ev.title, 88))}</span>${ev.location ? `<span class="loc">📍 ${htmlEscape(ev.location)}</span>` : ''}</div>
  </li>`;
}

function slideB(kw, rowsHtml) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  /* PLATZHALTER-CD — echte Farben/Fonts ersetzen diese Werte. */
  .slide{position:relative;width:1080px;height:1080px;overflow:hidden;
    font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#1a1a2e;color:#fff;padding:70px 80px}
  .slide::before{content:"";position:absolute;left:0;top:0;bottom:0;width:22px;background:#e94560}
  .brand{font-size:30px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#e94560}
  .kw{font-size:24px;color:#b8b8d0;margin-top:4px}
  ul.list{list-style:none;margin-top:38px}
  li{display:flex;gap:28px;padding:22px 0;border-bottom:1px solid rgba(255,255,255,.12);align-items:flex-start}
  li:last-child{border-bottom:0}
  .chip{flex:0 0 132px;display:flex;flex-direction:column;line-height:1.05}
  .chip .wd{font-size:27px;font-weight:800;color:#e94560;text-transform:uppercase}
  .chip .dn{font-size:33px;font-weight:800;color:#e94560}
  .r{display:flex;flex-direction:column}
  .ti{font-size:34px;font-weight:700;line-height:1.18}
  .time{color:#b8b8d0;font-weight:800;margin-right:10px}
  .loc{font-size:26px;color:#b8b8d0;margin-top:6px}
  </style></head><body><div class="slide">
    <div class="brand">WIR · Halle</div><div class="kw">Kalenderwoche ${kw} · Diese Woche</div>
    <ul class="list">${rowsHtml}</ul>
  </div></body></html>`;
}

// Zeilen-Packing: so viele Event-Zeilen wie passen pro Slide (Datum steht an jeder Zeile -> Umbruch egal).
async function packRows(page, kw, items) {
  const slides = [];
  let i = 0;
  while (i < items.length) {
    let fitTo = i;
    for (let j = i; j < items.length; j += 1) {
      await page.setContent(slideB(kw, items.slice(i, j + 1).map((x) => x.html).join('')), { waitUntil: 'load' });
      const ov = await page.evaluate(() => { const e = document.querySelector('.slide'); return e.scrollHeight - e.clientHeight; });
      if (ov <= 1) fitTo = j; else break;
    }
    slides.push(items.slice(i, fitTo + 1));
    i = fitTo + 1;
  }
  return slides;
}

async function main() {
  await loadEnv();
  const source = process.env.SOURCE || 'ics';

  // Zielwoche bestimmen
  const ref = process.env.REF_DATE ? parseISO(process.env.REF_DATE) : new Date();
  const offset = parseInt(process.env.WEEK_OFFSET ?? '1', 10);
  const weekStart = startOfWeek(addWeeks(ref, offset), { weekStartsOn: 1 }); // Montag
  const weekEnd = endOfWeek(addWeeks(ref, offset), { weekStartsOn: 1 });       // Sonntag 23:59
  const kw = format(weekStart, 'II', { locale: de });

  console.log(`Quelle:     ${source}`);
  console.log(`Zielwoche:  KW ${kw} — ${format(weekStart, 'dd.MM.yyyy')} bis ${format(weekEnd, 'dd.MM.yyyy')}`);

  const all = source === 'em-rest' ? await fetchFromEMRest() : await fetchFromICS(process.env.ICS_URL);
  console.log(`Feed gesamt: ${all.length} Events`);

  const week = all
    .filter((e) => e.start instanceof Date && !isNaN(e.start) && isWithinInterval(e.start, { start: weekStart, end: weekEnd }))
    .sort((a, b) => a.start - b.start);

  console.log(`In Zielwoche: ${week.length} Events`);
  if (week.length === 0) {
    console.log('\n⚠️  Keine Events in dieser Woche. (Bei ICS: 50er-Limit ab aeltestem Event — REF_DATE auf eine Woche mit Events setzen oder SOURCE=em-rest.)');
  }

  // Rendern
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const tpl = await fs.readFile(TEMPLATE, 'utf8');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });

  // Events nach Tag gruppieren (week ist bereits chronologisch sortiert)
  const days = [];
  const byKey = new Map();
  for (const ev of week) {
    const key = format(ev.start, 'yyyy-MM-dd');
    if (!byKey.has(key)) { const d = { date: ev.start, events: [] }; byKey.set(key, d); days.push(d); }
    byKey.get(key).events.push(ev);
  }

  const slides = [];
  let n = 0;
  const shoot = async (caption) => {
    n += 1;
    const name = `slide-KW${kw}-${String(n).padStart(2, '0')}.png`;
    await page.screenshot({ path: path.join(OUT, name), type: 'png', clip: { x: 0, y: 0, width: 1080, height: 1080 } });
    slides.push({ name, caption });
    console.log(`  ✓ ${name}  —  ${caption}`);
  };

  // Slide 1: Deckblatt (Cover-Variante der bestehenden Vorlage)
  const cover = tpl
    .replaceAll('{{kind}}', 'cover')
    .replaceAll('{{kw}}', kw)
    .replaceAll('{{weekday}}', '')
    .replaceAll('{{date}}', `${format(weekStart, 'dd.MM.')}–${format(weekEnd, 'dd.MM.yyyy')}`)
    .replaceAll('{{time}}', '')
    .replaceAll('{{title}}', 'Diese Woche bei WIR')
    .replaceAll('{{location}}', `${week.length} Veranstaltung${week.length === 1 ? '' : 'en'}`)
    .replaceAll('{{description}}', '');
  await page.setContent(cover, { waitUntil: 'networkidle0' });
  await shoot('Deckblatt');

  // Layout waehlbar: 'chips' (System B, Standard) | 'days' (Tages-Bloecke mit Weissraum)
  const layout = (process.env.LAYOUT || 'chips').toLowerCase();
  if (layout === 'days') {
    const dayBlocks = days.map((day) => ({
      dateLine: format(day.date, 'EEEE, d. MMMM', { locale: de }), // z.B. "Donnerstag, 11. September"
      short: format(day.date, 'EE dd.MM.', { locale: de }),
      rows: day.events.map(eventRow),
    }));
    const slideSections = await packSlides(page, kw, dayBlocks);
    for (const sections of slideSections) {
      await page.setContent(slideMultiHtml(kw, sections), { waitUntil: 'load' });
      const caption = sections.map((s) => `${s.short}${s.isCont ? ' (Forts.)' : ''}`).join(' · ');
      await shoot(caption);
    }
  } else {
    const items = week.map((ev) => ({ ev, html: eventRowB(ev) }));
    const groups = await packRows(page, kw, items);
    for (const g of groups) {
      await page.setContent(slideB(kw, g.map((x) => x.html).join('')), { waitUntil: 'load' });
      const fd = format(g[0].ev.start, 'EE dd.MM.', { locale: de });
      const ld = format(g[g.length - 1].ev.start, 'EE dd.MM.', { locale: de });
      await shoot(fd === ld ? fd : `${fd} – ${ld}`);
    }
  }

  await browser.close();

  // Begleit-Dateien fuer den festen Link
  await writeCsv(week, kw);
  await writeIndex(slides, kw, weekStart, weekEnd);
  await writeOverview(week, kw, weekStart, weekEnd);
  console.log(`\nFertig. ${slides.length} Karussell-Slides + CSV + index.html + uebersicht.html in output/`);
}

main().catch((err) => { console.error('FEHLER:', err); process.exit(1); });
