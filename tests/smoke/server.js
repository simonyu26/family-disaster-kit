// 冒煙測試用的小型靜態伺服器：只用 Node 內建模組，不多裝套件。
// root 可以是 repo，也可以是暫存的複本（「改版後離線」情境會改複本裡的檔案）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webmanifest': 'application/manifest+json'
};

function startServer(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.resolve(base, '.' + decodeURIComponent(url.pathname));
    // 只允許 root 底下的檔案：比對 path.relative，避免 /repo-evil 這類同前綴的路徑混過去（工程顧問）
    const rel = path.relative(base, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://localhost:${server.address().port}`, close: () => new Promise(r => server.close(r)) });
  }));
}

module.exports = { startServer };
