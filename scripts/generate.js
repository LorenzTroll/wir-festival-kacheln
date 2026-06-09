// Test A — Render-Pipeline
// Datenquelle (ICS-Feed ODER EM-REST-API) -> Wochen-Events filtern -> PNG-Kacheln (1080x1080).
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

async function renderTile(page, html) {
  await page.setContent(html, { waitUntil: 'networkidle0' });
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

  let i = 0;
  for (const ev of week) {
    i += 1;
    const html = tpl
      .replaceAll('{{kind}}', 'event')
      .replaceAll('{{kw}}', kw)
      .replaceAll('{{weekday}}', format(ev.start, 'EEEE', { locale: de }))
      .replaceAll('{{date}}', format(ev.start, 'dd. MMMM', { locale: de }))
      .replaceAll('{{time}}', format(ev.start, 'HH:mm') + (ev.end && !isNaN(ev.end) ? '–' + format(ev.end, 'HH:mm') : '') + ' Uhr')
      .replaceAll('{{title}}', truncate(ev.title, 110))
      .replaceAll('{{location}}', ev.location || '')
      .replaceAll('{{description}}', truncate(ev.description, 220));
    await renderTile(page, html);
    const file = path.join(OUT, `kachel-KW${kw}-${String(i).padStart(2, '0')}.png`);
    await page.screenshot({ path: file, type: 'png' });
    console.log(`  ✓ ${path.basename(file)}  —  ${ev.title.slice(0, 50)}`);
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
  await renderTile(page, cover);
  await page.screenshot({ path: path.join(OUT, `kachel-KW${kw}-00-cover.png`), type: 'png' });
  console.log(`  ✓ kachel-KW${kw}-00-cover.png  —  Cover`);

  await browser.close();
  console.log(`\nFertig. ${week.length + 1} Kacheln in output/`);
}

main().catch((err) => { console.error('FEHLER:', err); process.exit(1); });
