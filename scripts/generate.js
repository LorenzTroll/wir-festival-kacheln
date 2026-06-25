// WIR-Festival Wochenuebersicht — Render-Pipeline (CD-Version)
// Datenquelle (ICS / EM-REST) -> Wochen-Events -> Karussell-Slides (1080x1350, JPG) im WIR-CD
//   + events-KWxx.csv (Figma) + index.html (Galerie) + uebersicht.html (Website-Modul-Vorschau).
// CD aus Figma: BG #76519b, Akzent #ff5100, Text #e9e8e8, Font Host Grotesk (lokal gebuendelt).

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

const W = 1080;
const H = 1350; // Hochformat (Instagram 4:5)

let FONT_CSS = '';   // @font-face mit data-URIs (offline, deterministisch)
let SVG_RAW = '';    // sanitisiertes Logo-SVG (Recoloring zur Render-Zeit)

// Farb-Themes (bg=Hintergrund, text=Text+Linien, accent=Cover-Highlight, logo=SVG-Farbe).
// Weitere Varianten einfach hier ergaenzen; Auswahl per THEME-Env oder einzeln BG_COLOR/TEXT_COLOR/ACCENT_COLOR/LOGO_COLOR.
// 5 Paletten (bg=Hintergrund, text=Text+Linien, accent=Cover-Box, logo=SVG, huText="Wochenuebersicht"-Schrift).
const THEMES = {
  p1: { bg: '#E6E6E6', text: '#FF5100', accent: '#FF5100', logo: '#FF5100', huText: '#E6E6E6' },
  p2: { bg: '#EBE394', text: '#FF5100', accent: '#FF5100', logo: '#FF5100', huText: '#E9E8E8' },
  p3: { bg: '#C4DEE4', text: '#FF5100', accent: '#FF5100', logo: '#FF5100', huText: '#C4DEE4' },
  p4: { bg: '#FF5100', text: '#FFFFFF', accent: '#FFFFFF', logo: '#FFFFFF', huText: '#FF5100' },
  p5: { bg: '#76519B', text: '#E9E8E8', accent: '#FF5100', logo: '#FFFFFF', huText: '#E9E8E8' },
};
// Woechentliche Rotation: Reihenfolge der Paletten. Index = Kalenderwoche mod 5 -> jede Woche die naechste,
// nach 5 von vorn. Die Kalenderwoche ist der Zaehler -> kein Speichern des letzten Standes noetig.
const PALETTE_CYCLE = ['p1', 'p2', 'p3', 'p4', 'p5'];
let COLORS = THEMES.p1;
function resolveColors(kw) {
  // Explizite Auswahl (THEME=p1..p5) gewinnt zum Testen; sonst automatisch nach Kalenderwoche rotieren.
  let name = (process.env.THEME || '').toLowerCase();
  if (!name || !THEMES[name]) name = PALETTE_CYCLE[(parseInt(kw, 10) || 0) % PALETTE_CYCLE.length];
  const t = THEMES[name];
  COLORS = {
    bg: process.env.BG_COLOR || t.bg,
    text: process.env.TEXT_COLOR || t.text,
    accent: process.env.ACCENT_COLOR || t.accent,
    logo: process.env.LOGO_COLOR || t.logo,
    huText: process.env.HU_TEXT_COLOR || t.huText,
  };
}

async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* nur echte Umgebungsvariablen */ }
}

async function loadAssets() {
  FONT_CSS = await fs.readFile(path.join(ROOT, 'template/fonts/host-grotesk.css'), 'utf8');
  let svg = await fs.readFile(path.join(ROOT, 'template/assets/wir-festival-logo.svg'), 'utf8');
  // Figma exportiert das Logo mit preserveAspectRatio="none" + 100% -> wuerde verzerren. Aspekt erhalten.
  svg = svg.replace('preserveAspectRatio="none"', 'preserveAspectRatio="xMidYMid meet"')
    .replace('width="100%" height="100%"', 'width="413.331" height="355.089"');
  SVG_RAW = svg;
}

function clean(str = '') {
  return String(str)
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&rsquo;|&lsquo;/gi, "'").replace(/&ndash;|&mdash;/gi, '–')
    .replace(/\\(["';,\\])/g, '$1') // verbleibende iCal-Escapes (z.B. \") entfernen
    .replace(/\s+/g, ' ').trim();
}
function venue(loc = '') { return clean(loc).split(',')[0].trim(); }
function truncate(str, n) { const s = clean(str); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function csvCell(v = '') { return `"${String(v).replace(/"/g, '""')}"`; }
function htmlEscape(s = '') { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function startTime(ev) { return format(ev.start, 'HH:mm'); }        // nur Anfangszeit, ohne "Uhr"
function dayDate(d) { return format(d, 'dd.MM.', { locale: de }); }  // Datum ohne Jahr

function firstCategory(cats) {
  const arr = Array.isArray(cats) ? cats : (cats ? [cats] : []);
  return arr.length ? clean(String(arr[0])) : '';
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
      start: e.start,
      end: e.end,
      location: venue(e.location),
      category: firstCategory(e.categories),
      description: e.description ? clean(e.description) : '',
      url: e.url || '',
    });
  }
  return events;
}

// --- Quelle 2: EM-REST-API (Produktion) ---
async function fetchFromEMRest() {
  const base = process.env.WP_BASE_URL;
  const auth = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
  const res = await fetch(`${base}/wp-json/events-manager/v1/events?scope=future&per_page=50`, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`EM-REST ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const arr = Array.isArray(json) ? json : (json.events || json.data || []);
  return arr.map((e) => ({
    title: clean(e.event_name || e.title),
    start: new Date(e.event_start_date ? `${e.event_start_date}T${e.event_start_time || '00:00:00'}` : e.start),
    end: new Date(e.event_end_date ? `${e.event_end_date}T${e.event_end_time || '00:00:00'}` : e.end),
    location: venue(e.location_name || e.location?.location_name || ''),
    category: firstCategory(e.categories || e.event_categories),
    description: clean(e.post_content || e.description || ''),
    url: e.event_url || e.link || '',
  }));
}

function baseCss() {
  return `*{margin:0;padding:0;box-sizing:border-box}
  .page{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${COLORS.bg};color:${COLORS.text};font-family:'Host Grotesk',sans-serif}`;
}
function logoDataUri() {
  // Figma-Export faerbt die Pfade ueber fill="var(--fill-0, white)" (23x) + ein fill="white".
  const svg = SVG_RAW
    .replace(/var\(--fill-0,\s*white\)/g, COLORS.logo)
    .replace(/fill="white"/g, `fill="${COLORS.logo}"`);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// --- Deckblatt (Figma A) ---
function coverHtml(weekStart, weekEnd) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${FONT_CSS}
  ${baseCss()}
  .logo{position:absolute;top:118px;left:319px;width:442px;height:auto}
  .dots{position:absolute;top:668px;left:28px;width:1024px;border-top:7px dotted ${COLORS.text}}
  .hu{position:absolute;left:28px;top:740px;font-size:100px;font-weight:700;line-height:1.16;letter-spacing:-1px;color:${COLORS.huText}}
  .hu span{background:${COLORS.accent};padding:4px 12px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
  .range{position:absolute;right:42px;bottom:60px;font-size:150px;font-weight:700;line-height:1;text-align:right}
  </style></head><body><div class="page">
    <img class="logo" src="${logoDataUri()}" alt="wir festival">
    <div class="dots"></div>
    <div class="hu"><span>Wochen-<br>übersicht</span></div>
    <div class="range">${dayDate(weekStart)}<br>– ${dayDate(weekEnd)}</div>
  </div></body></html>`;
}

// --- Eine Event-Zeile (Figma B): links Zeit + Ort (kursiv), rechts Kategorie + Titel ---
function eventRow(ev) {
  const cat = ev.category ? `<div class="cat">${htmlEscape(ev.category)}</div>` : '';
  const loc = ev.location ? `<div class="loc">${htmlEscape(ev.location)}</div>` : '';
  return `<li>
    <div class="cl"><div class="time">${htmlEscape(startTime(ev))}</div>${loc}</div>
    <div class="cr">${cat}<div class="title">${htmlEscape(truncate(ev.title, 120))}</div></div>
  </li>`;
}

// --- Listen-Slide: ein oder mehrere Tages-Abschnitte; Tag-Header alterniert (Figma B) ---
function slideHtml(sections) {
  const blocks = sections.map((s) => {
    // Folge-Abschnitt eines Tages (isCont): kein Datums-Header, Liste laeuft einfach weiter.
    const wd = `<span class="wd">${htmlEscape(s.weekday)}</span>`;
    const bd = `<span class="bigdate">${htmlEscape(s.bigDate)}</span>`;
    const head = s.isCont ? '' : `<div class="dayhead">${s.alt ? wd + bd : bd + wd}</div>`;
    return `<section class="day${s.alt ? ' alt' : ''}">${head}<ul class="list">${s.rows.join('')}</ul></section>`;
  }).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${FONT_CSS}
  ${baseCss()}
  .page{padding:40px}
  .day{margin-top:30px}
  .day:first-child{margin-top:4px}
  .day + .day{border-top:5px solid ${COLORS.text};padding-top:26px}
  .dayhead{display:flex;align-items:flex-end;gap:30px}
  .bigdate{flex:0 0 auto;font-size:138px;font-weight:700;line-height:.78;letter-spacing:-2px}
  .wd{flex:1 1 auto;font-size:62px;font-weight:700;line-height:1;padding-bottom:12px;border-bottom:5px solid ${COLORS.text}}
  .day:not(.alt) .wd{text-align:left}
  .day.alt .wd{text-align:right}
  .wd em{font-style:italic;font-size:30px;font-weight:400}
  ul.list{list-style:none;margin-top:24px}
  li{display:flex;gap:34px;padding:22px 0}
  li + li{border-top:7px dotted ${COLORS.text}}
  .day:last-child .list li:last-child{padding-bottom:0} /* unterer Rand = oberer, spart Platz */
  .cl{flex:0 0 330px}
  .time{font-size:40px;font-weight:700;line-height:1.15}
  .loc{font-size:40px;font-style:italic;font-weight:400;line-height:1.2;margin-top:2px}
  .cr{flex:1;min-width:0}
  .cat{font-size:40px;font-weight:700;text-transform:uppercase;line-height:1.15}
  .title{font-size:40px;font-weight:400;line-height:1.2;margin-top:2px}
  </style></head><body><div class="page">${blocks}</div></body></html>`;
}

async function setHtml(page, html) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
}

// Dichtes Packing: Events fliessen durch, Slides werden voll ausgenutzt. Ein Tag darf
// ueber Slides brechen — beginnt dann oben auf der neuen Slide wieder mit Datum (isCont).
async function packSlides(page, days) {
  const slides = [];
  let cur = [];
  const mkSec = (d, isCont) => ({ bigDate: d.bigDate, weekday: d.weekday, alt: d.alt, short: d.short, isCont, rows: [] });
  const fits = async () => {
    await setHtml(page, slideHtml(cur));
    const ov = await page.evaluate(() => { const e = document.querySelector('.page'); return e.scrollHeight - e.clientHeight; });
    return ov <= 1;
  };
  for (const d of days) {
    let idx = 0;
    let isCont = false;
    while (idx < d.rows.length) {
      const sec = mkSec(d, isCont);
      cur.push(sec);
      let added = 0;
      while (idx < d.rows.length) {
        sec.rows.push(d.rows[idx]);
        if (await fits()) { idx += 1; added += 1; } else { sec.rows.pop(); break; }
      }
      if (added === 0) {
        cur.pop(); // leere Section entfernen
        if (cur.length > 0) { slides.push(cur); cur = []; } // Tag oben auf neuer Slide (isCont bleibt false)
        else { // selbst eine Zeile passt allein nicht -> erzwingen
          sec.rows.push(d.rows[idx]); idx += 1; cur.push(sec);
          if (idx < d.rows.length) { slides.push(cur); cur = []; isCont = true; }
        }
      } else if (idx < d.rows.length) {
        slides.push(cur); cur = []; isCont = true; // Slide voll, Tag laeuft als Folge weiter
      }
      // sonst: Tag fertig auf dieser Slide -> cur behalten, naechster Tag packt direkt an
    }
  }
  if (cur.length > 0) slides.push(cur);
  return slides;
}

async function writeCsv(events, kw) {
  const header = ['kw', 'weekday', 'date', 'time', 'category', 'title', 'location', 'url'];
  const rows = events.map((ev) => [
    kw, format(ev.start, 'EEEE', { locale: de }), dayDate(ev.start), startTime(ev),
    ev.category, ev.title, ev.location, ev.url,
  ].map(csvCell).join(','));
  await fs.writeFile(path.join(OUT, `events-KW${kw}.csv`), [header.join(','), ...rows].join('\n') + '\n', 'utf8');
}

async function writeIndex(slides, kw, weekStart, weekEnd, build) {
  const range = `${dayDate(weekStart)} – ${dayDate(weekEnd)}`;
  const v = `?v=${build}`; // Cache-Buster: erzwingt frische Bilder nach jedem Deploy
  const cards = slides.map((s, idx) => `
    <figure class="card">
      <a href="${s.name}${v}" target="_blank" rel="noopener" title="In voller Auflösung öffnen"><img src="${s.name}${v}" alt="${htmlEscape(s.caption)}" loading="lazy"></a>
      <figcaption><strong>${String(idx + 1).padStart(2, '0')} · ${htmlEscape(s.caption)}</strong>
        <span class="links"><a href="${s.name}${v}" target="_blank" rel="noopener">Vollbild</a> · <a class="dl" href="${s.name}${v}" download>herunterladen</a></span></figcaption>
    </figure>`).join('');
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>WIR-Festival — Wochenübersicht KW ${kw}</title><style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#3a2a52;color:#fff;margin:0;padding:40px}
  header{max-width:1100px;margin:0 auto 28px}h1{margin:0;font-size:30px}.sub{color:#d9cfe8;margin-top:6px}
  .csv{display:inline-block;margin-top:16px;margin-right:10px;background:#ff5100;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}
  .grid{max-width:1320px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:24px}
  .card{margin:0;background:#76519b;border-radius:12px;overflow:hidden}
  .card img{width:100%;height:auto;display:block;cursor:zoom-in}
  figcaption{padding:14px;display:flex;flex-direction:column;gap:8px;font-size:14px}
  .links a{color:#ff8a4d;text-decoration:none;font-weight:600}.dl{color:#ff8a4d}
</style></head><body>
  <header><h1>WIR-Festival — Wochenübersicht KW ${kw}</h1>
    <div class="sub">${range} · ${slides.length} Slides · automatisch generiert</div>
    <a class="csv" href="events-KW${kw}.csv" download>📄 CSV für Figma</a>
    <a class="csv" style="background:#5b3f7a" href="uebersicht.html">🌐 Website-Übersicht</a>
  </header><div class="grid">${cards}</div></body></html>\n`;
  await fs.writeFile(path.join(OUT, 'index.html'), html, 'utf8');
}

// Website-Wochenuebersicht (Vorschau = HTML-Output des kuenftigen WP-Shortcodes), im CD
async function writeOverview(events, kw, weekStart, weekEnd) {
  const range = `${dayDate(weekStart)} – ${dayDate(weekEnd)}`;
  const rows = events.map((ev) => `
    <article class="event">
      <time class="date"><span class="wd">${htmlEscape(format(ev.start, 'EE', { locale: de }))}</span><span class="d">${htmlEscape(dayDate(ev.start))}</span></time>
      <div class="info">
        ${ev.category ? `<span class="cat">${htmlEscape(ev.category.toUpperCase())}</span>` : ''}
        <h2>${htmlEscape(ev.title)}</h2>
        <p class="meta">${htmlEscape(startTime(ev))}${ev.location ? ' · ' + htmlEscape(ev.location) : ''}</p>
        ${ev.url ? `<a class="more" href="${ev.url}">Mehr erfahren →</a>` : ''}
      </div>
    </article>`).join('');
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>WIR-Festival — Wochenübersicht KW ${kw}</title><style>${FONT_CSS}
  :root{--accent:#ff5100;--ink:#2a1c3d;--muted:#6b5b80;--line:#ece7f2;--purple:#76519b}
  *{box-sizing:border-box}body{font-family:'Host Grotesk',sans-serif;background:#f3f0f8;color:var(--ink);margin:0;padding:40px}
  .wrap{max-width:780px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 30px rgba(0,0,0,.08)}
  header{padding:30px 36px;background:var(--purple);color:#fff}header h1{margin:0;font-size:28px}.sub{margin-top:6px;opacity:.85}
  .event{display:flex;gap:24px;padding:24px 36px;border-bottom:1px solid var(--line)}.event:last-child{border-bottom:0}
  .date{flex:0 0 70px;display:flex;flex-direction:column;align-items:flex-start;color:var(--accent);font-weight:700}
  .date .wd{font-size:16px;text-transform:uppercase}.date .d{font-size:22px}
  .cat{font-size:14px;font-weight:700;letter-spacing:1px;color:var(--accent)}
  .info h2{margin:4px 0 6px;font-size:21px}.info .meta{margin:0;color:var(--muted);font-style:italic}
  .info .more{display:inline-block;margin-top:8px;color:var(--accent);text-decoration:none;font-weight:700}
  footer{padding:18px 36px;color:var(--muted);font-size:13px}
</style></head><body><div class="wrap">
  <header><h1>Wochenübersicht</h1><div class="sub">KW ${kw} · ${range} · ${events.length} Veranstaltung${events.length === 1 ? '' : 'en'}</div></header>
  ${rows || '<div class="event"><div class="info"><p class="meta">Diese Woche keine Veranstaltungen.</p></div></div>'}
  <footer>Automatisch erzeugt aus dem Veranstaltungskalender · wir-halle.de</footer>
</div></body></html>\n`;
  await fs.writeFile(path.join(OUT, 'uebersicht.html'), html, 'utf8');
}

async function main() {
  await loadEnv();
  await loadAssets();
  const source = process.env.SOURCE || 'ics';
  const ref = process.env.REF_DATE ? parseISO(process.env.REF_DATE) : new Date();
  const offset = parseInt(process.env.WEEK_OFFSET ?? '1', 10);
  const weekStart = startOfWeek(addWeeks(ref, offset), { weekStartsOn: 1 });
  const weekEnd = endOfWeek(addWeeks(ref, offset), { weekStartsOn: 1 });
  const kw = format(weekStart, 'II', { locale: de });
  resolveColors(kw); // Palette der Woche

  console.log(`Quelle: ${source} · Zielwoche KW ${kw} (${dayDate(weekStart)}–${dayDate(weekEnd)})`);
  const all = source === 'em-rest' ? await fetchFromEMRest() : await fetchFromICS(process.env.ICS_URL);
  const week = all
    .filter((e) => e.start instanceof Date && !isNaN(e.start) && isWithinInterval(e.start, { start: weekStart, end: weekEnd }))
    .sort((a, b) => a.start - b.start);
  console.log(`Events in Woche: ${week.length}`);

  // nach Tag gruppieren, Tag-Header alterniert links/rechts
  const days = []; const byKey = new Map();
  for (const ev of week) {
    const key = format(ev.start, 'yyyy-MM-dd');
    if (!byKey.has(key)) { const d = { date: ev.start, events: [] }; byKey.set(key, d); days.push(d); }
    byKey.get(key).events.push(ev);
  }
  const dayBlocks = days.map((d, i) => ({
    bigDate: dayDate(d.date),
    weekday: format(d.date, 'EEEE', { locale: de }),
    short: format(d.date, 'EE dd.MM.', { locale: de }),
    alt: i % 2 === 1,
    rows: d.events.map(eventRow),
  }));

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  const slides = [];
  let n = 0;
  const shoot = async (caption) => {
    n += 1;
    const name = `slide-KW${kw}-${String(n).padStart(2, '0')}.jpg`;
    await page.screenshot({ path: path.join(OUT, name), type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: W, height: H } });
    slides.push({ name, caption });
    console.log(`  ✓ ${name}  —  ${caption}`);
  };

  await setHtml(page, coverHtml(weekStart, weekEnd));
  await shoot('Deckblatt');

  const slideSections = await packSlides(page, dayBlocks);
  for (const sections of slideSections) {
    await setHtml(page, slideHtml(sections));
    await shoot(sections.map((s) => `${s.short}${s.isCont ? ' (Forts.)' : ''}`).join(' · '));
  }

  await browser.close();
  await writeCsv(week, kw);
  await writeIndex(slides, kw, weekStart, weekEnd, Date.now());
  await writeOverview(week, kw, weekStart, weekEnd);
  console.log(`\nFertig. ${slides.length} Slides (JPG) + CSV + index.html + uebersicht.html`);
}

main().catch((err) => { console.error('FEHLER:', err); process.exit(1); });
