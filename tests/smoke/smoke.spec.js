// 冒煙測試（v3.0 拆檔的安全網）：只檢查「有沒有壞」，不鎖定版面細節。
// 緊急模式的檢查項目依災防顧問 2026-11-27（reviews/v30-split-smoke-disaster.md 第 4 點）；離線與改版情境依 D-05、工程顧問。
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./server');

const ROOT = path.resolve(__dirname, '..', '..');
const APP_VERSION = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/const APP_VERSION = '([^']+)'/) || [])[1];

let site;
test.beforeAll(async () => { site = await startServer(ROOT); });
test.afterAll(async () => { if (site) await site.close(); });

// 擋掉所有外部網址；記錄頁面錯誤
async function open(page, url, { geo = true } = {}) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());
  if (geo) {
    await page.context().setGeolocation({ latitude: 25.033, longitude: 121.543, accuracy: 20 }).catch(() => {});
    await page.context().grantPermissions(['geolocation']).catch(() => {});
  }
  await page.goto(url);
  await page.waitForFunction(() => typeof switchTab === 'function');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(e => e.remove()));
  return errors;
}

async function noHScroll(page) {
  const w = page.viewportSize().width;
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw, '不可有橫向捲動').toBeLessThanOrEqual(w);
}

async function enterEmergency(page) {
  await page.evaluate(() => { if (!document.body.classList.contains('emergency-mode')) toggleEmergencyMode(); });
  await expect(page.locator('body')).toHaveClass(/emergency-mode/);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(e => e.remove()));
}

// 「緊急模式能操作」：災防顧問列的項目逐一檢查
async function checkEmergencyUsable(page, { full = true } = {}) {
  await enterEmergency(page);
  const cards = page.locator('#guide-sop-pane .sos-triage-btn');
  await expect(cards).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(cards.nth(i)).toBeVisible();
    const box = await cards.nth(i).boundingBox();
    expect(box.height, `四大卡第 ${i + 1} 張高度 ≥68px`).toBeGreaterThanOrEqual(68);
  }
  // 1. 立即報案：119、110、112 是 tel 連結
  await cards.nth(0).click();
  for (const n of ['119', '110', '112']) await expect(page.locator(`#guide-sop-pane a[href="tel:${n}"]`).first()).toBeVisible();
  await noHScroll(page);
  if (!full) return;

  // 複製求救簡訊：剪貼簿或備援文字框，至少一個有文字
  await page.evaluate(() => { window.__clip = ''; try { navigator.clipboard.writeText = t => { window.__clip = t; return Promise.resolve(); }; } catch (e) {} });
  await page.locator('#guide-sop-pane button', { hasText: '複製求救簡訊' }).click();
  await expect.poll(async () => page.evaluate(() => (window.__clip || '') + (document.getElementById('sos-copy-text').value || '')), { timeout: 10_000 }).toContain('25.03');

  // 2. 有人受傷：止血帶計時能開始
  await cards.nth(1).click();
  const tqBefore = await page.locator('#tq-display').innerText();
  await page.locator('#btn-tq-toggle').click();
  await expect.poll(() => page.evaluate(() => typeof tqStartMs !== 'undefined' && tqStartMs > 0)).toBe(true);
  expect(tqBefore.length).toBeGreaterThan(0);

  // 3. 受困：求救閃光能開能停（哨音要聲音裝置，只確認不丟錯）
  await cards.nth(2).click();
  await page.evaluate(() => { try { stopWhistle(); } catch (e) {} });
  await page.locator('#sos-whistle-card button', { hasText: /閃光/ }).first().click();
  await expect(page.locator('#sos-flash-overlay')).toBeVisible();
  await page.locator('#sos-flash-overlay').click();
  await expect(page.locator('#sos-flash-overlay')).toBeHidden();

  // 4. 醫療卡與集合點顯示得出來
  await page.evaluate(() => switchTab('guide'));
  await page.locator('#guide-sop-pane .sos-triage-btn').nth(3).click();
  await expect(page.locator('#guide-plan-pane')).toBeVisible();
  await expect(page.locator('#family-idcards-box')).toBeAttached();
  await expect(page.locator('#rally-hierarchy-box')).toBeAttached();

  // 平安 QR 視窗打得開，QR 碼或文字摘要至少出現一個
  await page.evaluate(() => openFamilyQrModal());
  await expect(page.locator('#qr-modal')).toHaveClass(/open/);
  const qrOk = await page.evaluate(() => !!document.querySelector('#qr-modal-box canvas, #qr-modal-box img') || (document.getElementById('qr-text-preview').innerText || '').includes('家庭平安卡'));
  expect(qrOk, 'QR 碼或文字摘要至少一個').toBe(true);
  await page.evaluate(() => closeModal('qr-modal'));

  // 結束應變：點一下不會結束，按住 2 秒才結束
  const end = page.locator('#btn-em-end');
  await expect(end).toBeVisible();
  await end.click();
  await page.waitForTimeout(300);
  await expect(page.locator('body')).toHaveClass(/emergency-mode/);
  const b = await end.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2400);
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/emergency-mode/);
}

test('載入沒有錯誤，版本號一致', async ({ page }) => {
  const errors = await open(page, site.url + '/index.html');
  expect(APP_VERSION).toMatch(/^v\d/);
  await expect(page.locator('#app-version-pill')).toHaveText(APP_VERSION);
  expect(await page.title()).toContain(APP_VERSION);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('四個主分頁都切得過去，沒有橫向捲動', async ({ page }) => {
  const errors = await open(page, site.url + '/index.html');
  for (const tab of ['camp', 'inventory', 'map', 'guide']) {
    await page.evaluate(t => switchTab(t), tab);
    await page.waitForTimeout(300);
    await expect(page.locator('#tab-' + tab), `${tab} 分頁顯示`).toBeVisible();
    const h = await page.evaluate(t => document.getElementById('tab-' + t).getBoundingClientRect().height, tab);
    expect(h, `${tab} 分頁有內容`).toBeGreaterThan(100);
    await noHScroll(page);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('沒網路時能新增物資，重新載入後還在（本機保存）', async ({ page }) => {
  const errors = await open(page, site.url + '/index.html');
  const name = '冒煙測試口糧' + Date.now() % 100000;
  // 第一次使用：載入「三人小家庭」範本，進入本機模式
  await page.evaluate(() => initLocalFamilyTemplate('core3'));
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelectorAll('.toast').forEach(e => e.remove()); switchTab('inventory'); openAddItemModal(); });
  await page.fill('#modal-item-name', name);
  await page.locator('#modal-chars-list input[type=checkbox]').first().check();
  // 沒網路時走本機保存（離線佇列）；有網路但沒設雲端時目前會顯示「新增失敗」，那是另一件事，不在冒煙測試範圍
  await page.context().setOffline(true);
  await page.locator('#item-modal button', { hasText: '儲存' }).click();
  await page.waitForTimeout(500);
  await page.context().setOffline(false);
  await page.reload();
  await page.waitForFunction(() => typeof switchTab === 'function');
  await page.evaluate(() => switchTab('inventory'));
  await expect(page.locator('body')).toContainText(name);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('緊急模式：四大卡、報案、求救簡訊、止血帶、閃光、醫療卡、平安 QR、長按結束都能用', async ({ page }) => {
  const errors = await open(page, site.url + '/index.html');
  await checkEmergencyUsable(page);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('離線：Service Worker 裝好後斷網重新載入，緊急模式能用（D-05）', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright 的 WebKit 不支援 Service Worker 離線測試');
  const errors = await open(page, site.url + '/index.html');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15_000 }).catch(async () => { await page.reload(); });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15_000 });
  const swUrl = await page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
  expect(swUrl).toContain('v=' + encodeURIComponent(APP_VERSION));
  await page.context().setOffline(true);
  await page.reload();
  await page.waitForFunction(() => typeof switchTab === 'function');
  await checkEmergencyUsable(page);
  await page.context().setOffline(false);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('改版後離線：舊版載入、換新檔案連網載入一次、再斷網重新載入，緊急模式能用', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright 的 WebKit 不支援 Service Worker 離線測試');
  // 把網站複製到暫存資料夾，在複本上「部署新版」
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-site-'));
  fs.cpSync(ROOT, tmp, { recursive: true, filter: s => !/[\\/](node_modules|\.git|test-results|tests)([\\/]|$)/.test(s) });
  const s2 = await startServer(tmp);
  try {
    const errors = await open(page, s2.url + '/index.html');
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15_000 }).catch(async () => { await page.reload(); });
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15_000 });
    // 部署新版：只改版號（拆檔後，這裡會連帶換掉 css/js 的 ?v=）
    const NEW = APP_VERSION + '-smoke';
    for (const f of fs.readdirSync(tmp, { recursive: true }).map(String).filter(f => /\.(html|js|css)$/.test(f) && !f.includes('vendor'))) {
      const p = path.join(tmp, f); const t = fs.readFileSync(p, 'utf8');
      if (t.includes(APP_VERSION)) fs.writeFileSync(p, t.split(APP_VERSION).join(NEW));
    }
    await page.reload();
    await page.waitForFunction(() => typeof switchTab === 'function');
    await page.waitForTimeout(1500);
    await page.context().setOffline(true);
    await page.reload();
    await page.waitForFunction(() => typeof switchTab === 'function');
    await checkEmergencyUsable(page, { full: false });
    await page.context().setOffline(false);
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await s2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
