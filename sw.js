// Intentionally minimal service worker: exists only to satisfy install
// criteria on older Chrome. No fetch interception, no caching — live scores
// must never be served stale, so everything rides the network as usual.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
