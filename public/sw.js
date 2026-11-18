// Service worker do On track: guarda a app para abrir sem internet.
// Os dados não passam por aqui: o Firestore tem a sua própria cópia offline.
const VERSION = "__V__";
const CACHE = "ontrack-" + VERSION;
const SHELL = ["./", "./index.html", "./app.js?v=" + VERSION, "./styles.css?v=" + VERSION, "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("ontrack-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!same && !fonts) return; // Firebase e o resto seguem direto para a rede
  if (req.mode === "navigate"){
    // Página: tenta a rede (para apanhar versões novas), senão usa a cópia.
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)); return r; })
      .catch(() => caches.match("./index.html").then(r => r || caches.match("./"))));
    return;
  }
  // Ficheiros: cópia primeiro, e atualiza em segundo plano.
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")){ const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
