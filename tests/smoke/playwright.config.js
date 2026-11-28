// 冒煙測試設定。用法：npm ci && npx playwright install --with-deps chromium webkit && npm run smoke
// 只檢查「有沒有壞」，不鎖定版面細節。外部網址一律擋掉（地圖圖磚、NCDR、GAS 都不連）。
const { defineConfig, devices } = require('@playwright/test');

const projects = [
  { name: 'chromium-360', use: { browserName: 'chromium', viewport: { width: 360, height: 800 } } },
  { name: 'chromium-390', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
];
// WebKit（iPhone 用的引擎，災防顧問）：CI 一律跑；本機沒裝 WebKit 時可設 SMOKE_WEBKIT=0 略過
if (process.env.SMOKE_WEBKIT !== '0') {
  projects.push({ name: 'webkit-390', use: { browserName: 'webkit', viewport: { width: 390, height: 844 } } });
}

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js$/,
  timeout: 60_000,
  retries: 0,           // 不重試：時好時壞要修，不要藏起來
  workers: 2,
  reporter: [['list']],
  use: { trace: 'off', locale: 'zh-TW', timezoneId: 'Asia/Taipei', serviceWorkers: 'allow' },
  projects,
});
