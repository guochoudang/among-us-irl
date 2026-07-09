// Deliberately does NOT cache anything. This game only works with a live
// connection to the server (GPS positions and game state stream over a
// socket in real time), so there's nothing useful it could do offline —
// and caching the game files would risk phones running stale code after an
// update, which is exactly the kind of bug this app's server already goes
// out of its way to avoid (see the no-store header in server.js). This file
// exists only so phones treat the site as an installable app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // no-op: every request just falls through to the network
