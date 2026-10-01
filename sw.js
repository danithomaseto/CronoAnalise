/* Service worker: permite abrir o CronoAnálise sem internet.
   Estratégia "rede primeiro": online, sempre pega a versão mais nova (e atualiza
   o cache); offline ou rede muito lenta, usa a cópia em cache.
   Requisições ao Supabase (outro domínio) não passam por aqui.
   Ao mudar a lista de arquivos, incremente CACHE_VERSION. */

const CACHE_VERSION = 'cronoanalise-v9.1';
const NETWORK_TIMEOUT_MS = 4000;

const APP_SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/theme-init.js',
  'js/main.js',
  'js/config.js',
  'js/storage.js',
  'js/cloud.js',
  'js/auth.js',
  'js/ui.js',
  'js/editor.js',
  'js/dashboard.js',
  'js/core/format.js',
  'js/core/timer.js',
  'js/core/stats.js',
  'js/core/csv.js',
  'js/core/model.js',
  'vendor/supabase-js-2.117.2.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('cronoanalise-') && k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const network = fetch(req).then(res => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  });
  network.catch(() => {}); // se o cache responder antes, não deixa erro solto
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (e) { /* offline: cai no cache */ }
  const cached = await cache.match(req, { ignoreSearch: true })
    || (req.mode === 'navigate' ? await cache.match('index.html') : null);
  if (cached) return cached;
  return network; // sem cache: espera a rede (ou propaga o erro)
}
