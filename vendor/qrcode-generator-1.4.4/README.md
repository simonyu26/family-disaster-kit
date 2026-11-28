# QR Code Generator for JavaScript 1.4.4（自行託管）

- 來源：npm 套件 `qrcode-generator@1.4.4` 的 `qrcode.js`（作者 Kazuhiko Arase，GitHub kazuhikoarase/qrcode-generator）。未修改。
- 授權：MIT，見 `LICENSE`（取自原作者 GitHub 倉庫）。
- 為什麼換掉 qrcodejs 1.0.0：qrcodejs 估算中文長度有誤，家裡只要有一位成員，平安 QR 就丟出 `code length overflow`。這個套件依實際位元組自動選版本，並內建 UTF-8 編碼（`qrcode.stringToBytesFuncs['UTF-8']`）。
- 為什麼自行託管：S-07，離線時由 Service Worker 預存。
- 雜湊（E-11 用這些數字核對線上檔；開發環境連不到 cdnjs，和 cdnjs 公布 SRI 的比對由工程顧問另外核對）：

| 檔案 | 位元組 | SHA-256（十六進位） | SRI |
|---|---|---|---|
| qrcode.js | 56,694 | 18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780 | sha256-GK45n4EYK8nekW6cd7GV3yDMWNby1VpisIWimfG/F4A=<br>sha512-6WOG76AXc8rlgtGYLGhDg7lIzZG2Cc+VrSamvgpeBYgxauGuoMua6uKll4OsZ0JvVSt12lRX/9uCmXzkt3/wfg== |

- 更新版本時：換成新目錄（例如 `qrcode-generator-2.0.4/`），同步改 `index.html` 和 `sw.js` 的路徑，並重新核對雜湊。
