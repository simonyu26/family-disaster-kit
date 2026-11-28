// 靜態檢查（災防顧問 v3.0 諮詢第 1 點、D-05）：頁面會用到的每一個本機檔案，都必須在 sw.js 的 APP_ASSETS 裡，
// 否則離線時會缺檔，緊急模式可能整個不能用。缺一個就讓 CI 失敗。
// 掃描範圍：index.html 的 <script src>、<link href>、<img src>；CSS（含 index.html 的 <style> 與本機 .css）裡的 url()；
// JS 裡寫死的本機路徑字串（'./…'）；vendor 套件附帶、程式會用到的圖檔（Leaflet 標記圖示）。
// 用法：node tests/smoke/check-assets.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };

// 1. sw.js 的預存清單
const sw = read('sw.js');
const listSrc = (sw.match(/const APP_ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
const assets = new Set([...listSrc.matchAll(/'([^']+)'/g)].map(m => norm(m[1])));
ok(assets.size > 0, `讀到 sw.js 的 APP_ASSETS（${assets.size} 項）`);

function norm(u) {
  u = u.split('#')[0].split('?')[0];
  if (/^(https?:|data:|blob:|tel:|mailto:|javascript:)/i.test(u) || u.startsWith('//')) return null;
  if (u === '' || u === './' || u === '/') return './';
  u = u.replace(/^\.\//, '').replace(/^\//, '');
  return './' + u;
}

// 2. 頁面引用的本機檔案
// 已知用不到的 vendor 檔案：Leaflet 的圖層切換控制項圖示。程式沒有用 L.control.layers，下面也會檢查這一點；哪天用了，就要移出這份清單並加進 APP_ASSETS
const UNUSED = new Set(['./vendor/leaflet-1.9.4/images/layers.png', './vendor/leaflet-1.9.4/images/layers-2x.png']);
const html = read('index.html');
const needed = new Map(); // 路徑 → 從哪裡來
// 樣板字串裡的 ${…} 不是固定路徑（例如成員頭像的 <img src="${…}">），略過
const add = (u, from) => { if (u.includes('${')) return; const n = norm(u); if (n && n !== './' && !UNUSED.has(n)) needed.set(n, needed.get(n) || from); };
for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1], 'index.html <script>');
for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) add(m[1], 'index.html <link>');
for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1], 'index.html <img>');

// CSS url()：index.html 的 <style> 和每一個本機 .css（路徑相對於 css 檔所在資料夾）
const cssUrls = (css, dir, from) => {
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const u = m[1];
    if (/^(data:|https?:|#)/i.test(u)) continue;
    add(path.posix.join(dir, u), from);
  }
};
for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) cssUrls(m[1], '.', 'index.html <style>');
for (const [p] of [...needed]) {
  if (p.endsWith('.css') && fs.existsSync(path.join(ROOT, p))) cssUrls(read(p), path.posix.dirname(p.slice(2)), p);
}

// JS 裡寫死的本機檔案路徑：inline script 與每一個本機 .js（vendor 的壓縮檔除外，另外處理）
const jsSources = [...html.matchAll(/<script(?![^>]*\bsrc)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => ['index.html <script>', m[1]]);
for (const [p] of [...needed]) if (p.endsWith('.js') && !p.startsWith('./vendor/') && fs.existsSync(path.join(ROOT, p))) jsSources.push([p, read(p)]);
for (const [from, js] of jsSources) {
  for (const m of js.matchAll(/["'`](\.\/[A-Za-z0-9_\-./]+\.(?:js|css|json|png|jpg|jpeg|svg|mp3|wav|ogg|webp|woff2?))["'`]/g)) add(m[1], from + '（JS 字串）');
  // 動態載入但不是寫死的路徑，掃不到：一律要求改成寫死的常數（災防顧問）
  ok(!/\bimport\s*\(\s*[^'"`\s)]/.test(js), `${from}：沒有用變數組出的 import()`);
  ok(!/new\s+Audio\s*\(\s*[^'"`\s)]/.test(js), `${from}：沒有用變數組出的 Audio 音檔路徑`);
}

// vendor 附帶、執行時才用到的檔案：Leaflet 預設標記圖示
if ([...needed.keys()].some(p => p.includes('/leaflet-'))) {
  const dir = [...needed.keys()].find(p => p.endsWith('/leaflet.js')).replace(/leaflet\.js$/, '');
  for (const f of ['images/marker-icon.png', 'images/marker-icon-2x.png', 'images/marker-shadow.png']) add(dir + f, 'Leaflet 預設標記圖示');
}

// 3. 比對
ok(!jsSources.some(([, js]) => /control\.layers|leaflet-control-layers/.test(js)), '沒有用到 Leaflet 圖層切換控制項（所以 layers.png 不用預存）');
for (const [p, from] of needed) {
  ok(fs.existsSync(path.join(ROOT, p)), `檔案存在：${p}（${from}）`);
  ok(assets.has(p), `已列入 sw.js 預存清單：${p}（${from}）`);
}
ok(assets.has('./') && assets.has('./index.html'), '預存清單含首頁');
// 反過來：清單裡的每一個檔案都要存在，否則 SW 整批安裝失敗
for (const a of assets) if (a !== './') ok(fs.existsSync(path.join(ROOT, a)), `預存清單裡的檔案存在：${a}`);

console.log(fail ? `${fail} FAIL` : 'ALL PASS');
process.exit(fail ? 1 : 0);
