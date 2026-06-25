// Einmalig: Host-Grotesk-Fonts (latin) als data-URI-@font-face buendeln + Logo speichern.
// Ergebnis: template/fonts/host-grotesk.css (offline, deterministisch) + template/assets/wir-festival-logo.svg
import fs from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const ROOT = path.resolve('.');
const LOGO = 'https://www.figma.com/api/mcp/asset/029f1b9a-8592-4302-87f4-544820807035';

async function main() {
  const cssUrl = 'https://fonts.googleapis.com/css2?family=Host+Grotesk:ital,wght@0,400;0,700;1,400&display=swap';
  const css = await (await fetch(cssUrl, { headers: { 'User-Agent': UA } })).text();
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
  let m; let out = '';
  while ((m = re.exec(css))) {
    if (m[1] !== 'latin') continue; // latin deckt deutsche Umlaute ab
    const body = m[2];
    const style = (body.match(/font-style:\s*([^;]+);/) || [])[1].trim();
    const weight = (body.match(/font-weight:\s*([^;]+);/) || [])[1].trim();
    const url = (body.match(/url\(([^)]+)\)\s*format\('woff2'\)/) || [])[1];
    const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
    out += `@font-face{font-family:'Host Grotesk';font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2')}\n`;
    console.log('font', style, weight, buf.length, 'bytes');
  }
  await fs.mkdir(path.join(ROOT, 'template/fonts'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'template/fonts/host-grotesk.css'), out);
  await fs.mkdir(path.join(ROOT, 'template/assets'), { recursive: true });
  const logo = Buffer.from(await (await fetch(LOGO, { headers: { 'User-Agent': UA } })).arrayBuffer());
  await fs.writeFile(path.join(ROOT, 'template/assets/wir-festival-logo.svg'), logo);
  console.log('logo', logo.length, 'bytes;  fonts-css', out.length, 'bytes');
}
main().catch((e) => { console.error(e); process.exit(1); });
