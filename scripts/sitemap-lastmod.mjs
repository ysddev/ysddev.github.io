// Ставит в sitemap.xml настоящую дату последней правки каждой страницы (по git), чтобы Яндекс и Google
// переобходили изменённые страницы. 23.11 аудит: у 80 страниц из 83 стояло 2026-11-05, хотя цены менялись 21–23.11.
// Запуск: node scripts/sitemap-lastmod.mjs (в Actions — шагом в «Отзывы с Профи.ру», нужен fetch-depth: 0)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'sitemap.xml');
const xml = fs.readFileSync(FILE, 'utf8');
let changed = 0;
const out = xml.replace(/<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g, (all, loc, old) => {
  const rel = loc.replace(/^https:\/\/ysddev\.com\/?/, '') || 'index.html';
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return all;
  let d = '';
  try { d = execFileSync('git', ['log', '-1', '--format=%cs', '--', rel], { cwd: ROOT }).toString().trim(); } catch { return all; }
  if (!d || d === old) return all;
  changed++;
  return `<url><loc>${loc}</loc><lastmod>${d}</lastmod>`;
});
if (changed) fs.writeFileSync(FILE, out);
console.log(`sitemap.xml: обновлено дат ${changed}`);
