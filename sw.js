// Tabby service worker · app shell cache-first
// ⚠️ 改了任何前端文件后必须 bump 这个版本号，否则旧缓存不会更新。
const CACHE = 'tabby-shell-v30';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/dates.js',
  './js/protocol.js',
  './js/cycle.js',
  './js/db.js',
  './js/ai.js',
  './js/checklist.js',
  './js/symptoms.js',
  './js/chat.js',
  './js/mock.js',
  './fonts/press-start-2p.woff2',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 页面问版本号：回答正在运行的缓存版本（页脚显示用）
self.addEventListener('message', (e) => {
  if (e.data === 'version') e.source?.postMessage({ version: CACHE });
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只接管 same-origin 的 GET（app shell）。
  // Supabase / Edge Function 是跨域请求，从不拦截——数据永远走网络。
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
