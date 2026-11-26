# QRCode.js 1.0.0（自行託管）

- 來源：原作者 GitHub 倉庫 davidshimjs/qrcodejs 的 `qrcode.min.js`（cdnjs `ajax/libs/qrcodejs/1.0.0/` 收錄的就是這個檔）。和 npm 套件 `qrcodejs@1.0.0` 裡的同名檔逐位元組一致（19,927 位元組）。
- 授權：MIT，見 `LICENSE`。
- 為什麼自行託管：S-07，不從 cdnjs 載入，離線時由 Service Worker 預存，緊急卡的 QR 碼沒網路也畫得出來。
- 雜湊（E-11 用這些數字核對線上檔；開發環境連不到 cdnjs，和 cdnjs 公布 SRI 的比對由工程顧問另外核對）：

| 檔案 | SHA-256（十六進位） | SRI |
|---|---|---|
| qrcode.min.js | c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36 | sha256-xUHvBjJ4hahBW8qN9gceFBibSFUzbe9PNttUvehITzY=<br>sha512-CNgIRecGo7nphbeZ04Sc13ka07paqdeTu0WR1IM4kNcpmBAUSHSQX0FslNhTDadL4O5SAGapGt4FodqL8My0mA== |

- 更新版本時：換成新目錄（例如 `qrcodejs-1.0.1/`），同步改 `index.html` 和 `sw.js` 的路徑，並重新核對雜湊。
