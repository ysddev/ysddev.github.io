// Переносит новые отзывы с Профи.ру на сайт.
//
// 1. Открывает публичные профили в Chromium (Playwright) и читает отзывы из __NEXT_DATA__.
// 2. Берёт только письменные отзывы с оценкой 4 и выше, которых ещё нет на сайте.
// 3. Добавляет их в начало REVIEWS в index.html и 404.html, обновляет счётчики «N отзывов»
//    во всех местах и заново пререндерит блок отзывов.
// 4. Счёт на кнопках и «N отзывов» — как на Профи (PROFI_TOTAL), даже если новый отзыв без текста.
//
// Запуск: node scripts/sync-reviews.mjs [--dry]
// Переменная PROFI_JSON=<файл> позволяет подать заранее сохранённые данные вместо похода на Профи (для проверки).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEEN_FILE = path.join(ROOT, 'data', 'profi-reviews.json');
const DRY = process.argv.includes('--dry');
const PROFILES = [
  { id: 'KhripunovaSM', who: 's' }, // Софья
  { id: 'SherzodaYN', who: 'y' },   // Юсуф
];
const MIN_MARK = 4;

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SERVICE_EN = [
  [/интернет-магазин/i, 'Online store'], [/telegram|бот/i, 'Telegram bot'], [/презентац/i, 'Presentation design'],
  [/лендинг|landing/i, 'Landing page'], [/визитк/i, 'Business-card site'], [/корпоративн/i, 'Corporate website'],
  [/баннер/i, 'Banner'], [/логотип/i, 'Logo design'], [/фирменн/i, 'Brand identity'], [/дизайн/i, 'Web design'],
  [/tilda/i, 'Tilda website'], [/wordpress/i, 'WordPress website'], [/сайт/i, 'Website'],
];

const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
};

const mskParts = (ts) => {
  const d = new Date((ts + 3 * 3600) * 1000); // Москва, UTC+3
  return { day: d.getUTCDate(), m: d.getUTCMonth(), y: d.getUTCFullYear() };
};

const cleanText = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+([,.!?])/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

// «Миронова Ирина» → «Ирина», «Чумакова Елена Юрьевна» → «Елена», «Мария» → «Мария».
const shortName = (author) => {
  const w = String(author || '').trim().split(/\s+/).filter(Boolean);
  if (w.length >= 3) return w[1];
  if (w.length === 2 && /(ова|ева|ёва|ина|ына|ая|ов|ев|ёв|ин|ын|ский|ская|ко|юк|ук)$/i.test(w[0])) return w[1];
  return w.join(' ') || 'Клиент';
};

const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const price = (v) => v ? String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽' : '';
const js = (s) => JSON.stringify(s);

export function toSiteReview(node, who) {
  const { day, m, y } = mskParts(node.date.timestamp);
  const w = cap((node.services?.main?.[0]?.name) || 'Работа на Профи.ру');
  const en = (SERVICE_EN.find(([re]) => re.test(w)) || [null, w])[1];
  const t = cleanText(node.textHTML);
  const pv = node.reviewPrice?.value || node.price;
  const parts = [
    `n:${js(shortName(node.author))}`, `w:${js(w)}`, `we:${js(en)}`, `p:${js(price(pv))}`,
    `d:${js(`${day} ${MONTHS_RU[m]} ${y}`)}`, `de:${js(`${day} ${MONTHS_EN[m]} ${y}`)}`, 'r:5',
  ];
  if (String(node.mark).trim() === '5+') parts.push('m:"5+"'); // на Профи высшая оценка — «5+»
  if (who === 's') parts.push('s:"s"');
  parts.push(`t:${js(t)}`, `te:${js(t)}`);
  return { line: '{' + parts.join(', ') + '},', d: `${day} ${MONTHS_RU[m]} ${y}`, n: shortName(node.author), author: node.author || '', t };
}

export function pickNew(edges, who, seen, existing) {
  const out = [];
  for (const e of edges) {
    const n = e.node || e;
    if (!n || n.__typename !== 'WrittenReview') continue;
    if (seen.has(String(n.id))) continue;
    if (parseInt(n.mark, 10) < MIN_MARK) continue;
    if (!cleanText(n.textHTML)) continue;
    const r = toSiteReview(n, who);
    const sameWho = (x) => ((x.s || 'y') === who) && (x.n === r.n || r.author.includes(x.n) || x.n.includes(r.n));
    // Защита от дублей с отзывами, которые были добавлены вручную до автопереноса.
    // 25.11: теперь читаем все отзывы, а не 10 последних. Имя на Профи клиент мог поменять («Его Величество» вместо
    // «Александр», аноним вместо «Константин») — такой отзыв тоже уже на сайте: тот же исполнитель, дата и начало текста.
    const sameText = (x) => (x.s || 'y') === who && (() => { const a = normT(x.t), b = normT(r.t), L = Math.min(a.length, b.length);
      return L >= 12 && a.slice(0, L) === b.slice(0, L); })();
    const dup = existing.some((x) => x.d === r.d && (sameWho(x) || sameText(x)));
    // Клиент дописал отзыв: у Профи это новый номер и новая дата, старый исчезает. Раньше скрипт добавлял его
    // вторым (16.11: Ольга, «Веб-дизайн» 2 и 10 ноября — на сайте на 1 больше, чем на Профи). Теперь заменяем старый.
    const head = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const edited = dup ? null : existing.find((x) => sameWho(x) && x.t && head(r.t).startsWith(head(x.t)));
    out.push({ id: String(n.id), dup, replaces: edited ? { n: edited.n, d: edited.d } : null, ...r });
  }
  return out;
}

export function readReviews(html) {
  const i = html.indexOf('var REVIEWS = [');
  if (i < 0) throw new Error('REVIEWS not found');
  let depth = 0, j = html.indexOf('[', i);
  for (let k = j; k < html.length; k++) {
    if (html[k] === '[') depth++;
    else if (html[k] === ']' && --depth === 0) return (0, eval)(html.slice(j, k + 1));
  }
  throw new Error('REVIEWS not closed');
}

// Счёт отзывов на Профи из index.html: var PROFI_TOTAL = {s: 25, y: 35};
export function readTotals(html) {
  const m = html.match(/var PROFI_TOTAL = \{\s*s:\s*(\d+),\s*y:\s*(\d+)\s*\};/);
  return m ? { s: +m[1], y: +m[2] } : {};
}

// Убрать строку отзыва {n:"Имя", … d:"дата", …} из REVIEWS (одна строка — один отзыв)
export function dropReview(html, n, d) {
  const lines = html.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`{n:${JSON.stringify(n)},`) && l.includes(`d:${JSON.stringify(d)}`));
  if (i >= 0) lines.splice(i, 1);
  return lines.join('\n');
}

// 25.11 владелец: «Отзыв на 5+ поменяли, а на сайте до сих пор 5; у Никиты стоит 1, хотя на Профи 5+».
// Скрипт переносил только новые отзывы, а оценку уже перенесённых не трогал: клиент поднял 5 до 5+ — на сайте осталось 5.
// У 13 отзывов, перенесённых вручную, стояло m:1 — на сайте рядом со звёздами было «1». Теперь оценка каждого отзыва
// сверяется с Профи при каждом запуске: 5+ → m:"5+", 5 → без m, 4 → r:4.
const normT = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '').slice(0, 24);

export function markField(mark) {
  const m = String(mark).trim();
  if (m === '5+') return 'r:5, m:"5+"';
  const n = parseInt(m, 10);
  return `r:${Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 5}`;
}

// Возвращает [новый html, список правок]. Отзыв на сайте ищем по исполнителю и дате, при нескольких — по имени,
// потом по началу текста (имя на Профи клиент может поменять).
export function syncMarks(html, nodes) {
  const lines = html.split('\n');
  const changes = [];
  for (const { node, who } of nodes) {
    if (!node || node.__typename !== 'WrittenReview' || parseInt(node.mark, 10) < MIN_MARK) continue;
    const { day, m, y } = mskParts(node.date.timestamp);
    const d = `${day} ${MONTHS_RU[m]} ${y}`;
    const idx = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('{n:') && l.includes(`d:${js(d)}`)
      && (who === 's') === l.includes('s:"s"')).map(([, i]) => i);
    if (!idx.length) continue;
    const n = shortName(node.author);
    const t = normT(cleanText(node.textHTML));
    let i = idx.length === 1 ? idx[0] : idx.find((k) => lines[k].startsWith(`{n:${js(n)},`));
    const same = (x) => { const L = Math.min(x.length, t.length); return L >= 12 && x.slice(0, L) === t.slice(0, L); };
    if (i === undefined) i = idx.find((k) => { const mt = lines[k].match(/ t:("(?:[^"\\]|\\.)*")/); return mt && same(normT(JSON.parse(mt[1]))); });
    if (i === undefined) continue;
    const want = markField(node.mark);
    const cur = lines[i].match(/r:\d(?:, m:(?:"[^"]*"|\d+))?/);
    if (cur && cur[0] !== want) {
      changes.push(`${lines[i].match(/^\{n:("[^"]*")/)[1]} ${d}: ${cur[0]} → ${want}`);
      lines[i] = lines[i].replace(cur[0], want);
    }
  }
  return [lines.join('\n'), changes];
}

export function updateCounts(total) {
  const ru = `${total} ${plural(total, 'отзыв', 'отзыва', 'отзывов')}`;
  const ruGen = `${total} ${plural(total, 'отзыв', 'отзыва', 'отзывов')}`;
  const en = `${total} review${total === 1 ? '' : 's'}`;
  const tile = [[/(<b>)\d+( <span class="st-stars")/g, `$1${total}$2`],
    [/(data-i="st1">)Отзыв[а-яё]*/g, `$1${plural(total, 'Отзыв', 'Отзыва', 'Отзывов')}`]];
  const rules = {
    'index.html': [...tile, [/(день\. )\d+ отзыв[а-яё]*( клиентов)/g, `$1${ru}$2`], [/(<br>)\d+ отзыв[а-яё]*(<\/h2>)/g, `$1${ru}$2`], [/(на сайте )\d+ отзыв[а-яё]*/g, `$1${ruGen}`]],
    '404.html': [...tile, [/(день\. )\d+ отзыв[а-яё]*( клиентов)/g, `$1${ru}$2`], [/(<br>)\d+ отзыв[а-яё]*(<\/h2>)/g, `$1${ru}$2`], [/(на сайте )\d+ отзыв[а-яё]*/g, `$1${ruGen}`]],
    'en.js': [[/(with )\d+ client reviews?/g, `$1${total} client review${total === 1 ? '' : 's'}`], [/(<br>)\d+ reviews?/g, `$1${en}`]],
    'widget.js': [[/(на сайте )\d+ отзыв[а-яё]*/g, `$1${ruGen}`], [/(; )\d+ reviews?( on this site)/g, `$1${en}$2`]],
  };
  for (const [f, rs] of Object.entries(rules)) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    let t = fs.readFileSync(p, 'utf8');
    for (const [re, to] of rs) t = t.replace(re, to);
    fs.writeFileSync(p, t);
  }
}

function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

// Тот же пререндер, что раньше делался вручную: JS-блоки главной сохраняются в HTML между маркерами <!--pr:id-->.
export async function prerender(browser) {
  const IDS = ['filters', 'worksGrid', 'wMore', 'ptable', 'revWho', 'revGrid', 'revMore'];
  const srv = await serve();
  const port = srv.address().port;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.evaluate(() => document.getElementById('works')?.scrollIntoView());
  await page.waitForTimeout(3000);
  const got = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.innerHTML ?? null])), IDS);
  await page.close();
  srv.close();
  const FILE = path.join(ROOT, 'index.html');
  let t = fs.readFileSync(FILE, 'utf8');
  for (const id of IDS) {
    const h = got[id];
    if (h == null) { console.log('prerender: missing', id); continue; }
    const m = t.match(new RegExp('<div[^>]*id="' + id + '"[^>]*>'));
    if (!m) { console.log('prerender: nofind', id); continue; }
    const start = m.index + m[0].length, open = '<!--pr:' + id + '-->', close = '<!--/pr:' + id + '-->';
    if (t.startsWith(open, start)) {
      const end = t.indexOf(close, start);
      t = t.slice(0, start) + open + h + close + t.slice(end + close.length);
    } else if (t.startsWith('</div>', start)) {
      t = t.slice(0, start) + open + h + close + t.slice(start);
    } else console.log('prerender: not empty', id);
  }
  fs.writeFileSync(FILE, t);
}

async function fetchProfiles(browser) {
  if (process.env.PROFI_JSON) return JSON.parse(fs.readFileSync(process.env.PROFI_JSON, 'utf8'));
  const out = {};
  const ctx = await browser.newContext({ locale: 'ru-RU', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
  for (const p of PROFILES) {
    const page = await ctx.newPage();
    try {
      // 25.11: страница профиля отдаёт только 10 последних отзывов, страница /reviews/ — все: нужно для сверки оценок
      await page.goto(`https://profi.ru/profile/${p.id}/reviews/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const data = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        const d = JSON.parse(el.textContent);
        let found = null;
        (function walk(o) {
          if (found || !o || typeof o !== 'object') return;
          if (Array.isArray(o.edges) && o.edges[0]?.node && 'mark' in o.edges[0].node) { found = o; return; }
          for (const k in o) walk(o[k]);
        })(d);
        return found ? { total: found.totalCount, edges: found.edges } : null;
      });
      if (!data) console.log(`${p.id}: профиль недоступен (скрыт или сайт не отдал данные) — пропускаю`);
      else { out[p.id] = data; console.log(`${p.id}: на Профи ${data.total} отзывов, на странице ${data.edges.length}`); }
    } catch (e) {
      console.log(`${p.id}: ошибка загрузки — ${e.message}`);
    }
    await page.close();
  }
  await ctx.close();
  return out;
}

async function main() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const seenData = fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) : { seen: [] };
  const seen = new Set(seenData.seen.map(String));
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const existing = readReviews(indexHtml);

  const profiles = await fetchProfiles(browser);
  const add = [];
  for (const p of PROFILES) {
    const data = profiles[p.id];
    if (!data) continue;
    for (const r of pickNew(data.edges, p.who, seen, existing)) {
      seen.add(r.id);
      if (r.dup) console.log(`уже на сайте: ${r.n}, ${r.d}`);
      else { add.push(r); console.log(`${r.replaces ? `отзыв дописан (было ${r.replaces.d}, заменяю)` : 'новый отзыв'}: ${r.n}, ${r.d} — ${r.t.slice(0, 60)}…`); }
    }
  }

  const seenChanged = seen.size !== new Set(seenData.seen.map(String)).size;
  // 23.11: счёт на кнопках «Софья / Юсуф» и «N отзывов» — как на Профи (там есть и отзывы без текста, на сайт они не
  // попадают). Было: считали только перенесённые — у Софьи на Профи 25, на сайте 24, а «новых отзывов нет»
  const totals = readTotals(indexHtml);
  const fresh = { ...totals };
  for (const p of PROFILES) if (profiles[p.id]?.total) fresh[p.who] = Math.max(profiles[p.id].total, 0);
  const totalsChanged = PROFILES.some((p) => (fresh[p.who] || 0) !== (totals[p.who] || 0));
  // оценки уже перенесённых отзывов — как на Профи сейчас
  const nodes = PROFILES.flatMap((p) => (profiles[p.id]?.edges || []).map((e) => ({ node: e.node || e, who: p.who })));
  let marksChanged = false;
  if (!DRY) {
    for (const f of ['index.html', '404.html']) {
      const fp = path.join(ROOT, f);
      if (!fs.existsSync(fp)) continue;
      const [t, ch] = syncMarks(fs.readFileSync(fp, 'utf8'), nodes);
      if (ch.length) { fs.writeFileSync(fp, t); marksChanged = true; if (f === 'index.html') ch.forEach((c) => console.log('оценка: ' + c)); }
    }
  } else console.log('[dry] оценки: ' + syncMarks(indexHtml, nodes)[1].join('; '));
  if (!add.length && !seenChanged && !totalsChanged && !marksChanged) { console.log('Новых отзывов нет, счёт как на Профи.'); await browser.close(); return; }
  if (DRY) { console.log(`[dry] добавил бы ${add.length}, счёт ${JSON.stringify(fresh)}`); await browser.close(); return; }
  if (totalsChanged) {
    for (const f of ['index.html', '404.html']) {
      const p = path.join(ROOT, f);
      if (!fs.existsSync(p)) continue;
      const t = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, t.replace(/var PROFI_TOTAL = \{[^}]*\};/, `var PROFI_TOTAL = {s: ${fresh.s || 0}, y: ${fresh.y || 0}};`));
    }
    console.log(`Счёт как на Профи: Софья ${fresh.s}, Юсуф ${fresh.y}`);
  }

  if (add.length) {
    // Новые сверху: Профи отдаёт отзывы от новых к старым.
    const block = add.map((r) => r.line + '\n').join('');
    for (const f of ['index.html', '404.html']) {
      const p = path.join(ROOT, f);
      if (!fs.existsSync(p)) continue;
      let t = fs.readFileSync(p, 'utf8');
      if (!t.includes('var REVIEWS = [\n')) continue;
      for (const r of add.filter((x) => x.replaces)) t = dropReview(t, r.replaces.n, r.replaces.d);
      fs.writeFileSync(p, t.replace('var REVIEWS = [\n', 'var REVIEWS = [\n' + block));
    }
    console.log(`Добавлено: ${add.length}`);
  }
  if (add.length || totalsChanged || marksChanged) {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const t = readTotals(html), onSite = readReviews(html);
    const per = (k) => Math.max(t[k] || 0, onSite.filter((r) => (r.s || 'y') === k).length);
    const total = per('s') + per('y');
    updateCounts(total);
    await prerender(browser);
    console.log(`Всего отзывов (как на Профи): ${total}`);
  }
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify({ seen: [...seen].sort() }, null, 1) + '\n');
  await browser.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
