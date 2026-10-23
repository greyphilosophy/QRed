// Service Worker for QRed — offline PWA support
// HTML: network-first (never stale verifier). JS/CSS/img: cache-first (content-hashed).
// Bump V string to invalidate existing installs.

const CACHE_VERSION = "v7";
const CACHE_NAME = `qred-${CACHE_VERSION}`;
const STATIC_ORIGINS = new Set([self.location.origin]);
const JS_CSS_ASSET_RE = /\.(?:m?js|css|woff2?|ttf|otf|pfb|bcmap|wasm|traineddata\.gz|png|jpg|jpeg|webp|svg|ico)$/i;
// Vite bundles include a content hash; PDF resources include the PDF.js version.
const VERSIONED_ASSET_RE = /^\/(?:assets\/|pdfjs\/[^/]+\/|ocr\/v\d+\/)/;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api");
}

function isNavigationRequest(request) {
  return request.mode === "navigate" || (request.method === "GET" && request.headers.get("accept")?.includes("text/html"));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // API calls: bypass SW entirely — verifier fetches /api/keys/* fresh
  if (isApiRequest(url)) return;

  // Navigations / HTML: network-first, cache fallback
  if (isNavigationRequest(request) || url.pathname.endsWith(".html") || url.pathname.endsWith(".htm")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cross-origin (e.g. CDN): network only
  if (!STATIC_ORIGINS.has(url.origin)) return;

  // Versioned assets need no background refresh: a changed version has a new
  // URL. Reusing these cached resources must not make network requests.
  // Other static assets retain background refresh for their unversioned URLs.
  if (JS_CSS_ASSET_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached && VERSIONED_ASSET_RE.test(url.pathname)) return cached;
          const fetchPromise = fetch(request)
            .then((response) => {
              if (response && response.ok) cache.put(request, response.clone());
              return response;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // Everything else: network-first with cache fallback
  event.respondWith(
    fetch(request).then((response) => {
      if (response && response.ok && JS_CSS_ASSET_RE.test(url.pathname)) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});
