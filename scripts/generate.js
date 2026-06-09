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

// --- CSV fuer Figma (Daten-Sync-Plugins) ---
async function writeCsv(rendered, kw) {
  const base = (process.env.PAGES_BASE_URL || '').replace(/\/$/, '');
  const header = ['kw', 'weekday', 'date', 'time', 'title', 'location', 'description', 'url', 'image', 'image_url'];
  const rows = rendered.map(({ ev, name }) => [
    kw,
    format(ev.start, 'EEEE', { locale: de }),
    format(ev.start, 'dd.MM.yyyy'),
    timeLabel(ev),
    ev.title,
    ev.location,
    ev.description,
    ev.url,
    name,
    base ? `${base}/${name}` : name,
  ].map(csvCell).join(','));
  const csv = [header.join(','), ...rows].join('\n') + '\n';
  await fs.writeFile(path.join(OUT, `events-KW${kw}.csv`), csv, 'utf8');
}

// --- Galerie-Seite (fester Link fuer die Redaktion) ---
async function writeIndex(rendered, coverName, kw, weekStart, weekEnd) {
  const range = `${format(weekStart, 'dd.MM.')}–${format(weekEnd, 'dd.MM.yyyy')}`;
  const cards = rendered.map(({ ev, name }) => `
    <figure class="card">
      <a href="${name}" download><img src="${name}" alt="${htmlEscape(ev.title)}" loading="lazy"></a>
      <figcaption>
        <strong>${htmlEscape(ev.title)}</strong>
        <span>${htmlEscape(format(ev.start, 'EEEE dd.MM.', { locale: de }))} · ${htmlEscape(timeLabel(ev))}</span>
        <a class="dl" href="${name}" download>PNG herunterladen</a>
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
    <div class="sub">${range} · ${rendered.length} Veranstaltung${rendered.length === 1 ? '' : 'en'} · automatisch generiert</div>
    <a class="csv" href="events-KW${kw}.csv" download>📄 CSV für Figma herunterladen</a>
  </header>
  ${coverName ? `<div class="cover"><img src="${coverName}" alt="Cover"></div>` : ''}
  <div class="grid">${cards}</div>
</body></html>\n`;
  await fs.writeFile(path.join(OUT, 'index.html'), html, 'utf8');
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

  const rendered = [];
  let i = 0;
  for (const ev of week) {
    i += 1;
    const html = tpl
      .replaceAll('{{kind}}', 'event')
      .replaceAll('{{kw}}', kw)
      .replaceAll('{{weekday}}', format(ev.start, 'EEEE', { locale: de }))
      .replaceAll('{{date}}', format(ev.start, 'dd. MMMM', { locale: de }))
      .replaceAll('{{time}}', timeLabel(ev))
      .replaceAll('{{title}}', truncate(ev.title, 110))
      .replaceAll('{{location}}', ev.location || '')
      .replaceAll('{{description}}', truncate(ev.description, 220));
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const name = `kachel-KW${kw}-${String(i).padStart(2, '0')}.png`;
    await page.screenshot({ path: path.join(OUT, name), type: 'png' });
    rendered.push({ ev, name });
    console.log(`  ✓ ${name}  —  ${ev.title.slice(0, 50)}`);
  }

  // Cover-Kachel
  const cover = tpl
    .replaceAll('{{kind}}', 'cover')
    .replaceAll('{{kw}}', kw)
    .replaceAll('{{weekday}}', '')
    .replaceAll('{{date}}', `${format(weekStart, 'dd.MM.')}–${format(weekEnd, 'dd.MM.yyyy')}`)
    .replaceAll('{{time}}', '')
    .replaceAll('{{title}}', `Diese Woche bei WIR`)
    .replaceAll('{{location}}', `${week.length} Veranstaltung${week.length === 1 ? '' : 'en'}`)
    .replaceAll('{{description}}', '');
  await page.setContent(cover, { waitUntil: 'networkidle0' });
  const coverName = `kachel-KW${kw}-00-cover.png`;
  await page.screenshot({ path: path.join(OUT, coverName), type: 'png' });
  console.log(`  ✓ ${coverName}  —  Cover`);

  await browser.close();

  // Begleit-Dateien fuer den festen Link
  await writeCsv(rendered, kw);
  await writeIndex(rendered, coverName, kw, weekStart, weekEnd);
  console.log(`\nFertig. ${week.length + 1} Kacheln + CSV + index.html in output/`);
}

main().catch((err) => { console.error('FEHLER:', err); process.exit(1); });
