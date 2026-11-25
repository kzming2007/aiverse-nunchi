// 로컬 확인용 정적 파일 서버 (실제 배포는 Vercel, 기록은 Supabase)
// 외부 패키지 없이 Node.js 내장 모듈만 사용합니다.  실행: node server.js → http://localhost:3000
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
// Vercel의 cleanUrls와 같게: /board → board.html
const PAGES = { '/': 'index.html', '/board': 'board.html' };

function notFound(res, status = 404) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(status === 404 ? 'Not found' : 'Bad request');
}

http
  .createServer((req, res) => {
    let file;
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      file = PAGES[pathname] || decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      return notFound(res, 400);
    }
    const full = path.resolve(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return notFound(res, 400);

    fs.readFile(full, (err, data) => {
      if (err) return notFound(res);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`\n로컬 확인용 서버 실행 중 (기록은 Supabase에 저장됩니다)\n`);
    console.log(`  게임    http://localhost:${PORT}/?station=1`);
    console.log(`  현황판  http://localhost:${PORT}/board\n`);
  });
