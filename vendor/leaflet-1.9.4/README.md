# Leaflet 1.9.4（自行託管）

- 來源：npm 套件 `leaflet@1.9.4` 的 `dist/`，目錄結構與官方相同（`leaflet.css` 旁邊就是 `images/`）。
- 授權：BSD 2-Clause，見 `LICENSE`。
- 為什麼自行託管：S-07，不從 unpkg 載入，離線時由 Service Worker 預存。
- 雜湊（與 Leaflet 官方公布的 SRI 相同，E-11 用這兩個數字核對線上檔）：

| 檔案 | SHA-256（十六進位） | SRI |
|---|---|---|
| leaflet.js | db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a | sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo= |
| leaflet.css | a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6 | sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY= |

- 更新版本時：換成新目錄（例如 `leaflet-1.9.5/`），同步改 `index.html` 和 `sw.js` 的路徑，並重新核對雜湊。
