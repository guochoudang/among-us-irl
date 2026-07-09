/* global io, L */

// PWA install support only — no caching (see sw.js for why).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Some Android browsers launch an installed standalone PWA with a stale
// zoom level left over from wherever the engine last was, showing the page
// zoomed in until something forces a recalculation (a manual reload does
// it, which is the symptom this works around). Rewriting the viewport
// meta's content — off, then back on a frame later — forces that
// recalculation.
function forceZoomRecalc() {
  const vp = document.querySelector('meta[name=viewport]');
  if (!vp) return;
  vp.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=yes');
  requestAnimationFrame(() => {
    vp.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no');
  });
}
// Only actually touch anything if the page is genuinely rendering zoomed in
// (visualViewport.scale away from 1) — cheap to check, and avoids poking the
// DOM on every trigger when nothing's wrong. Falls back to just always
// correcting on browsers old enough to lack the Visual Viewport API.
function checkAndFixZoom() {
  if (!window.visualViewport || Math.abs(window.visualViewport.scale - 1) > 0.02) {
    forceZoomRecalc();
  }
}
// The bad zoom can show up slightly after any of these fire (the OS/engine
// applies its stale scale asynchronously), so check at every plausible
// trigger point AND a couple of short delays after each, rather than trusting
// any single moment to be late enough.
function checkZoomSoon() {
  checkAndFixZoom();
  setTimeout(checkAndFixZoom, 300);
  setTimeout(checkAndFixZoom, 1000);
}
window.addEventListener('load', checkZoomSoon);
window.addEventListener('pageshow', checkZoomSoon);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkZoomSoon(); });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', checkAndFixZoom);
}

// ---------- identity ----------
function makeKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
const KEY = localStorage.getItem('auKey') || (localStorage.setItem('auKey', makeKey()), localStorage.getItem('auKey'));

const socket = io();
let state = null;
let lastPhase = null;
let myPos = null; // freshest GPS fix from this phone
let roleShownFor = 0; // counter so the role card shows once per game start
let killScreenShownFor = 0; // counter so the kill screen shows once per game start
let gameCount = 0;
let voteChoice = null; // meeting: name tapped but not yet confirmed
let killReadyPrev = false; // was a kill available last tick (for the ready buzz)
let reportReadyPrev = false; // was a reportable body in range last tick (for the ready buzz)
let roundBase = null; // { secondsLeft, receivedAt, paused } snapshot from the last server state
let mapFittedForGame = -1; // counter so the game map's zoom/bounds are (re)fit once per game start, not every state tick

const $ = (id) => document.getElementById(id);

// Chrome/Android normally shows its own install banner automatically, but
// dismissing (or backing out of) it once makes the browser stop offering it
// again for a long while. Capturing the event ourselves and driving our own
// button sidesteps that — the button just stays hidden until the browser
// tells us installing is possible again. (iOS Safari has no such event at
// all; there, "Add to Home Screen" from the Share menu is the only route,
// so the button simply never appears there.)
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $('btn-install-app').classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('btn-install-app').classList.add('hidden');
});
$('btn-install-app').onclick = async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('btn-install-app').classList.add('hidden');
};

// Solo-test mode helpers
let fakeMode = false;   // host spoofed their own location by tapping the map
let placingMe = false;  // next map tap sets the host's fake location
let botLayer = null;
const botMarkers = new Map();
let seeLocationLayer = null;
let seeLocationShownUntil = 0; // the reveal's "until" we've already drawn, so we don't re-schedule its clear timer

// Block Location: lobby drawing tool + in-game picking/rendering
let drawingSegment = false;   // host (lobby) is tracing a new street section
let draftSegment = [];        // points of the section currently being traced, as [lat,lng] pairs
let draftSegmentLayer = null;
let segmentLayer = null;      // lobby-only: saved street sections, editable
let placingBlock = false;     // impostor: next map tap picks which section to block
let pickerLayer = null;       // impostor-only: temporary preview lines while choosing
let activeBlockLayer = null;  // everyone: red highlight for currently-blocked sections
const announcedBlockIds = new Set(); // block ids whose big popup has already fired
let inBlockZonePrev = false;  // edge-trigger for the "you're in a blocked-off area" modal
let blockBannerTimer = null;

// Meeting call spots: lobby drawing tool + read-only markers on the game map
let addingMeetingLocation = false; // host (lobby): next map tap adds a spot
const meetingLocLayers = { lobby: null, game: null };
const lastMeetingLocHash = { lobby: '', game: '' };

// ---------- helpers ----------
function feetBetween(a, b) {
  const R = 20902231;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Local-flat feet projection, accurate enough at neighborhood scale, used to
// find the nearest drawn street section to a tap and to check whether a
// player's GPS fix falls inside a blocked section's line.
function toLocalFeet(origin, p) {
  const x = feetBetween(origin, { lat: origin.lat, lng: p.lng }) * (p.lng < origin.lng ? -1 : 1);
  const y = feetBetween(origin, { lat: p.lat, lng: origin.lng }) * (p.lat < origin.lat ? -1 : 1);
  return { x, y };
}
function pointToSegmentFeet(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? (apx * abx + apy * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}
function distanceToPolylineFeet(point, points) {
  if (!points || !points.length) return Infinity;
  const origin = points[0];
  const p = toLocalFeet(origin, point);
  if (points.length === 1) return Math.hypot(p.x, p.y);
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = toLocalFeet(origin, points[i]);
    const b = toLocalFeet(origin, points[i + 1]);
    min = Math.min(min, pointToSegmentFeet(p, a, b));
  }
  return min;
}

// In-app replacements for prompt()/confirm(): those built-in popups are
// blocked in embedded webviews and some phone browsers.
let dialogResolve = null;
function openDialog(title, withInput, body = '', hideCancel = false) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    $('dialog-title').textContent = title;
    $('dialog-body').textContent = body;
    $('dialog-body').classList.toggle('hidden', !body);
    $('dialog-cancel').classList.toggle('hidden', hideCancel);
    const inp = $('dialog-input');
    inp.classList.toggle('hidden', !withInput);
    inp.value = '';
    $('dialog').classList.remove('hidden');
    if (withInput) setTimeout(() => inp.focus(), 50);
  });
}
function closeDialog(result) {
  $('dialog').classList.add('hidden');
  if (dialogResolve) dialogResolve(result);
  dialogResolve = null;
}
const askText = (title) => openDialog(title, true).then((ok) => (ok ? $('dialog-input').value.trim() : null));
const askYesNo = (title) => openDialog(title, false);
const showInfo = (title, body) => openDialog(title, false, body, true);

let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function showScreen(name) {
  for (const s of ['home', 'lobby', 'game', 'meeting', 'end']) {
    $('screen-' + s).classList.toggle('hidden', s !== name);
  }
}

// ---------- GPS ----------
if (!window.isSecureContext) {
  $('gps-warning').textContent =
    'Heads up: this page is not on HTTPS, so the phone will refuse to share GPS. Use the https link (see README).';
}

if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (fix) => {
      if (fakeMode) return; // spoofed test location wins over real GPS
      myPos = { lat: fix.coords.latitude, lng: fix.coords.longitude, ts: Date.now() };
      updateMeMarker();
      renderDynamic();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

setInterval(() => {
  if (fakeMode && myPos) myPos.ts = Date.now(); // spoofed location never goes stale
  if (myPos && state && Date.now() - myPos.ts < 10000) {
    socket.emit('pos', { lat: myPos.lat, lng: myPos.lng });
  }
}, 2000);

// ---------- wake lock (keep the screen on mid-game) ----------
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch (e) { /* not critical */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
    if (savedRoom()) rejoin();
  }
});

// ---------- join / rejoin ----------
const savedRoom = () => localStorage.getItem('auRoom');
const savedName = () => localStorage.getItem('auName') || '';
$('name-input').value = savedName();

function handleJoinAck(res) {
  if (res && res.error) {
    toast(res.error);
    localStorage.removeItem('auRoom');
    showScreen('home');
  } else if (res && res.code) {
    localStorage.setItem('auRoom', res.code);
  }
}

function rejoin() {
  socket.emit('join', { code: savedRoom(), name: savedName(), key: KEY }, (res) => {
    if (res && res.error) {
      localStorage.removeItem('auRoom');
      showScreen('home');
    }
  });
}

socket.on('connect', () => {
  if (savedRoom()) rejoin();
});

$('btn-create').onclick = () => {
  const name = $('name-input').value.trim();
  if (!name) return toast('Enter a name first.');
  localStorage.setItem('auName', name);
  socket.emit('create', { name, key: KEY }, handleJoinAck);
};

$('btn-join').onclick = () => {
  const name = $('name-input').value.trim();
  const code = $('code-input').value.trim().toUpperCase();
  if (!name) return toast('Enter a name first.');
  if (code.length !== 4) return toast('Room codes are 4 letters.');
  localStorage.setItem('auName', name);
  socket.emit('join', { code, name, key: KEY }, handleJoinAck);
};

socket.on('errorMsg', (msg) => toast(msg));

// ---------- maps ----------
let lobbyMap = null;
let gameMap = null;
let meMarker = null;
let taskLayer = null;
let lobbyLayer = null;
let lastTaskHash = '';

// Meeting-screen reference map: hidden by default, toggled on with a button.
// Read-only (no click handlers) — just a bigger view of already-public info
// (area, tasks, street sections, meeting spots, any still-active closures)
// so players can talk through where things are without leaving the vote.
let meetingMap = null;
let meetingMapLayer = null;
let meetingMapShown = false;

// Play-area drawing (host, lobby) and display (everyone)
let drawingArea = false;
let draftArea = [];
let draftLayer = null;
const areaLayers = { lobby: null, game: null };
const lastAreaHash = { lobby: '', game: '' };

function renderArea(map, which) {
  if (!map || !state) return;
  const pts = (state.area || []).map((p) => [p.lat, p.lng]);
  const hash = JSON.stringify(pts);
  if (lastAreaHash[which] === hash) return;
  lastAreaHash[which] = hash;
  if (areaLayers[which]) {
    map.removeLayer(areaLayers[which]);
    areaLayers[which] = null;
  }
  if (pts.length >= 3) {
    areaLayers[which] = L.polygon(pts, {
      color: '#3ecf6e', weight: 3, fillColor: '#3ecf6e', fillOpacity: 0.15,
    }).addTo(map);
  }
}

function updateDraft() {
  if (draftLayer) {
    lobbyMap.removeLayer(draftLayer);
    draftLayer = null;
  }
  if (draftArea.length) {
    draftLayer = L.polygon(draftArea, {
      color: '#ffa502', weight: 2, dashArray: '6 6', fillColor: '#ffa502', fillOpacity: 0.1,
    }).addTo(lobbyMap);
  }
}

function setDrawButtons() {
  $('btn-area-draw').textContent = drawingArea ? `Corners: ${draftArea.length} (tap map)` : '✏️ Draw: tap corners';
  $('btn-area-save').classList.toggle('hidden', !drawingArea);
}

function tiles() {
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  });
}

// Where a map should look before GPS kicks in: the room's play area if one
// is set, else the player's own position, else a wide fallback view.
function defaultView(map) {
  if (state && state.area && state.area.length >= 3) {
    map.fitBounds(L.latLngBounds(state.area.map((p) => [p.lat, p.lng])).pad(0.03));
  } else if (myPos) {
    map.setView([myPos.lat, myPos.lng], 17);
  } else {
    map.setView([37.3087, -122.0604], 13);
  }
}

function initLobbyMap() {
  if (lobbyMap) return;
  lobbyMap = L.map('lobby-map');
  defaultView(lobbyMap);
  tiles().addTo(lobbyMap);
  lobbyLayer = L.layerGroup().addTo(lobbyMap);
  segmentLayer = L.layerGroup().addTo(lobbyMap);
  meetingLocLayers.lobby = L.layerGroup().addTo(lobbyMap);
  lobbyMap.on('click', async (e) => {
    if (drawingArea) {
      draftArea.push([e.latlng.lat, e.latlng.lng]);
      updateDraft();
      setDrawButtons();
      return;
    }
    if (drawingSegment) {
      draftSegment.push([e.latlng.lat, e.latlng.lng]);
      updateSegmentDraft();
      setSegmentDrawButtons();
      return;
    }
    if (addingMeetingLocation) {
      const name = await askText('Name this meeting spot:');
      if (!name) return;
      const locations = state.meetingLocations.map((m) => ({ name: m.name, lat: m.lat, lng: m.lng }));
      locations.push({ name, lat: e.latlng.lat, lng: e.latlng.lng });
      socket.emit('setMeetingLocations', locations);
      return;
    }
    const name = await askText('Name this task:');
    if (!name) return;
    const explanation = await askText('Detailed instructions (optional — Cancel to skip):');
    const tasks = state.tasks.map((t) => ({ name: t.name, lat: t.lat, lng: t.lng, explanation: t.explanation, photo: t.photo }));
    tasks.push({ name, lat: e.latlng.lat, lng: e.latlng.lng, explanation: explanation || '' });
    socket.emit('setTasks', tasks);
  });
}

function renderLobbyTasks() {
  if (!lobbyMap) return;
  lobbyLayer.clearLayers();
  for (const t of state.tasks) {
    if (t.anywhere) continue; // wild-card tasks have no fixed spot
    const m = L.circleMarker([t.lat, t.lng], {
      radius: 5, color: '#fff', weight: 1.5, fillColor: '#4e6cff', fillOpacity: 1,
    }).addTo(lobbyLayer).bindTooltip(t.name);
    m.on('click', async (e) => {
      L.DomEvent.stopPropagation(e);
      if (!(await askYesNo(`Remove task "${t.name}"?`))) return;
      const tasks = state.tasks.filter((x) => x.id !== t.id).map((x) => ({ name: x.name, lat: x.lat, lng: x.lng, explanation: x.explanation, photo: x.photo }));
      socket.emit('setTasks', tasks);
    });
  }
  $('task-count').textContent = state.tasks.length;
}

function renderStreetSegments() {
  if (!lobbyMap) return;
  segmentLayer.clearLayers();
  for (const seg of state.streetSegments) {
    const line = L.polyline(seg.points.map((p) => [p.lat, p.lng]), {
      color: '#ffa502', weight: 4, opacity: 0.9,
    }).addTo(segmentLayer).bindTooltip(seg.name);
    line.on('click', async (e) => {
      L.DomEvent.stopPropagation(e);
      if (!(await askYesNo(`Remove street section "${seg.name}"?`))) return;
      const segments = state.streetSegments.filter((s) => s.id !== seg.id).map((s) => ({ name: s.name, points: s.points }));
      socket.emit('setStreetSegments', segments);
    });
  }
  $('segment-count').textContent = state.streetSegments.length;
}

// Shared between the lobby map (editable, host-only) and the game map
// (read-only, everyone) so crew can see where they're allowed to call a
// meeting from. `which` keys the per-map layer/hash like renderArea does.
function renderMeetingLocations(map, which) {
  if (!map) return;
  const locs = state.meetingLocations || [];
  const hash = JSON.stringify(locs);
  if (lastMeetingLocHash[which] === hash) return;
  lastMeetingLocHash[which] = hash;
  if (!meetingLocLayers[which]) meetingLocLayers[which] = L.layerGroup().addTo(map);
  meetingLocLayers[which].clearLayers();
  for (const m of locs) {
    const dot = L.circleMarker([m.lat, m.lng], {
      radius: 7, color: '#fff', weight: 1.5, fillColor: '#a55eea', fillOpacity: 1,
    }).addTo(meetingLocLayers[which]).bindTooltip(m.name);
    if (which === 'lobby') {
      dot.on('click', async (e) => {
        L.DomEvent.stopPropagation(e);
        if (!(await askYesNo(`Remove meeting spot "${m.name}"?`))) return;
        const locations = locs.filter((x) => x.id !== m.id).map((x) => ({ name: x.name, lat: x.lat, lng: x.lng }));
        socket.emit('setMeetingLocations', locations);
      });
    }
  }
  $('meetingloc-count') && ($('meetingloc-count').textContent = locs.length);
}

function updateSegmentDraft() {
  if (draftSegmentLayer) {
    lobbyMap.removeLayer(draftSegmentLayer);
    draftSegmentLayer = null;
  }
  if (!draftSegment.length) return;
  draftSegmentLayer = L.layerGroup().addTo(lobbyMap);
  draftSegment.forEach((pt, i) => {
    const dot = L.circleMarker(pt, {
      radius: 7, color: '#fff', weight: 2, fillColor: '#ffa502', fillOpacity: 1,
    }).addTo(draftSegmentLayer).bindTooltip('Tap to remove this point');
    dot.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      draftSegment.splice(i, 1);
      updateSegmentDraft();
      setSegmentDrawButtons();
    });
  });
  if (draftSegment.length >= 2) {
    L.polyline(draftSegment, { color: '#ffa502', weight: 3, dashArray: '6 6' }).addTo(draftSegmentLayer);
  }
}

function setSegmentDrawButtons() {
  $('btn-segment-draw').textContent = drawingSegment ? `Points: ${draftSegment.length} (tap map)` : '✏️ Draw: tap points';
  $('btn-segment-save').classList.toggle('hidden', !drawingSegment);
}

// The server only recomputes/broadcasts activeBlocks when something else
// happens (a pos update, a kill, etc.) — on an otherwise quiet stretch, a
// block's real-world endsAt can pass with no broadcast to tell the client.
// Filtering by time locally (same idea as the round timer's local ticking)
// means the red highlight and the nudge below never outlive the real window.
function liveBlocks() {
  // During a meeting, a block's remaining time is frozen server-side (see
  // blockEffectiveEndsAt in server.js) — the endsAt we're holding is only a
  // snapshot from the last broadcast, and nothing else necessarily triggers
  // another one while everyone's just voting. Decaying it locally against
  // Date.now() would make it look expired well before the server actually
  // considers it so, so trust the server's list as-is until play resumes.
  if (state.phase === 'meeting') return state.activeBlocks || [];
  return (state.activeBlocks || []).filter((b) => b.endsAt > Date.now());
}

// Red highlight on the game map for every currently-active block, visible to
// everyone. Small list, cheap to just clear and redraw each tick.
function renderActiveBlocks() {
  if (!gameMap) return;
  if (!activeBlockLayer) activeBlockLayer = L.layerGroup().addTo(gameMap);
  activeBlockLayer.clearLayers();
  for (const b of liveBlocks()) {
    L.polyline(b.points.map((p) => [p.lat, p.lng]), {
      color: '#ff4757', weight: 6, opacity: 0.9,
    }).addTo(activeBlockLayer).bindTooltip(b.name);
  }
}

// Impostor-only preview while choosing what to block: every drawn section,
// dimmed if this impostor already used it (can't pick it again this game).
function renderBlockPicker() {
  if (!gameMap) return;
  if (pickerLayer) { gameMap.removeLayer(pickerLayer); pickerLayer = null; }
  if (!placingBlock) return;
  pickerLayer = L.layerGroup().addTo(gameMap);
  const used = new Set((state.you.usedSegments || []));
  for (const seg of (state.streetSegments || [])) {
    const isUsed = used.has(seg.id);
    L.polyline(seg.points.map((p) => [p.lat, p.lng]), {
      color: isUsed ? '#666' : '#ffa502', weight: 5, dashArray: '8 6', opacity: 0.9,
    }).addTo(pickerLayer).bindTooltip(seg.name + (isUsed ? ' (already used)' : ''));
  }
}

function findNearestSegment(tapPoint, maxFeet = 60) {
  let best = null;
  let bestDist = Infinity;
  for (const seg of (state.streetSegments || [])) {
    const d = distanceToPolylineFeet(tapPoint, seg.points);
    if (d < bestDist) { bestDist = d; best = seg; }
  }
  return bestDist <= maxFeet ? best : null;
}

function showBlockBanner(b) {
  clearTimeout(blockBannerTimer);
  $('block-banner-name').textContent = b.name;
  const secsLeft = Math.max(0, Math.ceil((b.endsAt - Date.now()) / 1000));
  $('block-banner-sub').textContent = `for ${fmt(secsLeft)}`;
  $('block-banner').classList.remove('hidden');
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
  blockBannerTimer = setTimeout(() => $('block-banner').classList.add('hidden'), 6000);
}

// Pins the meeting map's furthest-zoomed-out view to the play area, since
// that map is only ever shown briefly during a vote and re-inits every time
// (see initMeetingMap). The main game map used to get this same treatment,
// but hard-locking pan/zoom to a rectangle computed once at init time made it
// fragile — the lock (and the map's cached tile layout) could go stale
// whenever the map's container was hidden behind another screen and shown
// again (e.g. after a meeting), so the game map now just uses defaultView()
// for its initial framing and otherwise behaves like a normal, freely
// pannable/zoomable map. The play area is still visible to everyone via the
// green polygon outline drawn by renderArea().
function lockMapBounds(map) {
  if (!state || !state.area || state.area.length < 3) return;
  const bounds = L.latLngBounds(state.area.map((p) => [p.lat, p.lng])).pad(0.03);
  map.setMaxBounds(bounds);
  map.setMinZoom(map.getZoom());
}

function initGameMap() {
  if (gameMap) return;
  // The map fills exactly the top half of the screen (see .map.grow in
  // style.css) and the task/kill panel below it scrolls independently, so
  // dragging/zooming the map doesn't fight with reaching buttons below it.
  gameMap = L.map('game-map', {
    zoomControl: true,
    dragging: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: false,
    keyboard: false,
  });
  defaultView(gameMap);
  tiles().addTo(gameMap);
  taskLayer = L.layerGroup().addTo(gameMap);
  botLayer = L.layerGroup().addTo(gameMap);
  seeLocationLayer = L.layerGroup().addTo(gameMap);
  gameMap.on('click', async (e) => {
    if (placingBlock) {
      const tap = { lat: e.latlng.lat, lng: e.latlng.lng };
      const seg = findNearestSegment(tap);
      if (!seg) return toast('Tap closer to one of the drawn (orange) street sections.');
      if ((state.you.usedSegments || []).includes(seg.id)) {
        return toast(`You've already blocked "${seg.name}" this game — pick a different section.`);
      }
      if (await askYesNo(`Block "${seg.name}" for ${fmt(state.settings.blockDuration)}?`)) {
        socket.emit('blockLocation', { segmentId: seg.id });
      }
      placingBlock = false;
      renderBlockPicker();
      return;
    }
    if (!placingMe) return;
    placingMe = false;
    fakeMode = true;
    myPos = { lat: e.latlng.lat, lng: e.latlng.lng, ts: Date.now() };
    socket.emit('pos', { lat: myPos.lat, lng: myPos.lng });
    updateMeMarker();
    toast('Test location set — you are the blue dot.');
    renderTestPanel('test-panel');
  });
  // The game map's container sits behind #screen-meeting (display:none) for
  // the whole meeting, then reappears at full size when play resumes.
  // Leaflet only reloads tiles for its actual container size when it's told
  // the size changed — a fixed setTimeout guess at "now it should be visible"
  // isn't reliable on slower devices where layout/paint can lag behind our
  // guess. ResizeObserver instead fires exactly when the container's real
  // pixel size changes, so this fires right when hiding/showing actually
  // finishes, whatever that takes.
  if (window.ResizeObserver) {
    new ResizeObserver(() => gameMap && gameMap.invalidateSize()).observe($('game-map'));
  }
}

function initMeetingMap() {
  if (meetingMap) return;
  meetingMap = L.map('meeting-map', {
    zoomControl: true, dragging: true, touchZoom: true, scrollWheelZoom: true,
    doubleClickZoom: true, boxZoom: false, keyboard: false, maxBoundsViscosity: 1.0,
  });
  defaultView(meetingMap);
  lockMapBounds(meetingMap);
  tiles().addTo(meetingMap);
  meetingMapLayer = L.layerGroup().addTo(meetingMap);
}

// Redraws everything on the meeting map from scratch. Only ever called while
// the map is actually visible, so there's no incremental-diff cost to worry
// about like the game map's renderGameTasks has.
function renderMeetingMapContents() {
  if (!meetingMap || !state) return;
  meetingMapLayer.clearLayers();
  for (const t of state.tasks || []) {
    if (t.anywhere) continue; // wild-card tasks have no fixed spot
    L.circleMarker([t.lat, t.lng], {
      radius: 4, color: '#fff', weight: 1, fillColor: '#777790', fillOpacity: 0.95,
    }).addTo(meetingMapLayer).bindTooltip(t.name);
  }
  // Street sections themselves are deliberately NOT drawn here — only actual
  // active closures (red, below) should ever show. Drawing every configured
  // section in orange would reveal the full set of blockable streets to
  // everyone during every meeting, which isn't otherwise public information.
  for (const m of state.meetingLocations || []) {
    L.circleMarker([m.lat, m.lng], {
      radius: 7, color: '#fff', weight: 1.5, fillColor: '#a55eea', fillOpacity: 1,
    }).addTo(meetingMapLayer).bindTooltip(m.name);
  }
  for (const b of liveBlocks()) {
    L.polyline(b.points.map((p) => [p.lat, p.lng]), {
      color: '#ff4757', weight: 6, opacity: 0.9,
    }).addTo(meetingMapLayer).bindTooltip(`🚫 ${b.name}`);
  }
}

// "See Location" reveal: private to this player, drawn once per use and
// cleared automatically once the server's 20-second window is up.
function renderSeeLocationReveal() {
  if (!seeLocationLayer || !state) return;
  const reveal = state.you.seeLocationReveal;
  if (!reveal || reveal.until <= seeLocationShownUntil) return; // already drawn (or expired) this reveal
  seeLocationShownUntil = reveal.until;
  seeLocationLayer.clearLayers();
  for (const q of reveal.players) {
    L.circleMarker([q.lat, q.lng], {
      radius: 8, color: '#fff', weight: 2, fillColor: '#d4537e', fillOpacity: 1,
    })
      .bindTooltip(q.name, { permanent: true, direction: 'top', offset: [0, -8], className: 'seeloc-label' })
      .addTo(seeLocationLayer);
  }
  const msLeft = Math.max(0, reveal.until - Date.now());
  setTimeout(() => seeLocationLayer.clearLayers(), msLeft);
  toast(`Revealed ${reveal.players.length} player location${reveal.players.length === 1 ? '' : 's'} for 20 seconds.`);
}

function renderBots() {
  if (!botLayer || !state) return;
  const bots = state.bots || [];
  const seen = new Set();
  for (const b of bots) {
    if (!b.pos) continue;
    seen.add(b.key);
    let m = botMarkers.get(b.key);
    if (!m) {
      m = L.marker([b.pos.lat, b.pos.lng], { draggable: true, opacity: 0.85 }).addTo(botLayer);
      m.bindTooltip('');
      m.on('dragstart', () => (m._held = true));
      m.on('dragend', () => {
        m._held = false;
        const ll = m.getLatLng();
        socket.emit('botPos', { botKey: b.key, lat: ll.lat, lng: ll.lng });
      });
      botMarkers.set(b.key, m);
    } else if (!m._held) {
      m.setLatLng([b.pos.lat, b.pos.lng]);
    }
    m.setTooltipContent(`${b.name}${b.alive ? '' : ' (dead)'} — drag to move`);
  }
  for (const [key, m] of botMarkers) {
    if (!seen.has(key)) {
      botLayer.removeLayer(m);
      botMarkers.delete(key);
    }
  }
}

function renderTestPanel(containerId) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = '';
  const bots = state.bots || [];
  if (!bots.length) return;

  const head = document.createElement('h3');
  head.textContent = '🧪 Test controls';
  el.append(head);

  if (state.phase === 'playing') {
    const moveMe = document.createElement('button');
    moveMe.className = 'small';
    moveMe.textContent = placingMe ? 'Now tap the map…' : '📍 Move me (tap the map after)';
    moveMe.onclick = () => {
      placingMe = true;
      toast('Tap the map to set your own test location.');
      renderTestPanel(containerId);
    };
    el.append(moveMe);
  }

  for (const b of bots) {
    const row = document.createElement('div');
    row.className = 'bot-row';

    const name = document.createElement('span');
    name.className = 'bot-name';
    name.textContent = b.name;
    const tag = document.createElement('span');
    tag.className = 'tag' + (b.role === 'impostor' ? ' impostor' : '');
    tag.textContent = b.alive
      ? (b.role || '')
      : b.ejected ? 'ejected' : b.foundDead ? 'found dead' : 'dead';
    row.append(name, tag);

    const act = (action, target) => () => socket.emit('botAction', { botKey: b.key, action, target });

    if (state.phase === 'playing') {
      if (myPos) {
        const toMe = document.createElement('button');
        toMe.textContent = 'To me';
        toMe.onclick = () => socket.emit('botPos', { botKey: b.key, lat: myPos.lat, lng: myPos.lng });
        row.append(toMe);
      }
      if ((b.alive || b.foundDead || b.ejected) && b.tasksLeft > 0) {
        const task = document.createElement('button');
        task.textContent = `Do task (${b.tasksLeft})`;
        task.onclick = act('task');
        row.append(task);
      }
      if (b.alive && b.role === 'impostor') {
        const kill = document.createElement('button');
        kill.className = 'danger';
        kill.textContent = '🔪 Kill nearest';
        kill.onclick = act('kill');
        row.append(kill);
      }
      if (b.alive && b.role === 'impostor' && Date.now() >= (b.blockCooldownUntil || 0)) {
        const available = (state.streetSegments || []).filter((s) => !(b.usedSegments || []).includes(s.id));
        if (available.length) {
          const blk = document.createElement('button');
          blk.className = 'danger';
          blk.textContent = '🚫 Block random section';
          const pick = available[Math.floor(Math.random() * available.length)];
          blk.onclick = act('blockLocation', pick.id);
          row.append(blk);
        }
      }
      if (b.alive) {
        const rep = document.createElement('button');
        rep.textContent = 'Report body';
        rep.onclick = act('report');
        row.append(rep);
      }
      if (b.alive && !b.calledMeeting) {
        const cv = document.createElement('button');
        cv.textContent = '🚨 Call meeting (1 use)';
        cv.onclick = act('callVote');
        row.append(cv);
      }
      if (b.alive && b.role !== 'impostor' && !b.usedSeeLocation) {
        const sl = document.createElement('button');
        sl.textContent = '👁 See location (1 use)';
        sl.onclick = act('seeLocation');
        row.append(sl);
      }
    }

    if (state.phase === 'meeting' && state.meeting && b.alive) {
      const voted = state.players.find((p) => p.key === b.key)?.voted;
      if (voted) {
        const done = document.createElement('span');
        done.className = 'tag';
        done.textContent = 'voted 🗳';
        row.append(done);
      } else {
        const sel = document.createElement('select');
        sel.append(new Option('Skip', 'skip'));
        for (const c of state.meeting.candidates) sel.append(new Option(c.name, c.key));
        const cast = document.createElement('button');
        cast.textContent = 'Cast vote';
        cast.onclick = () => socket.emit('botAction', { botKey: b.key, action: 'vote', target: sel.value });
        row.append(sel, cast);
      }
    }

    el.append(row);
  }
}

function updateMeMarker() {
  if (!gameMap || !myPos) return;
  if (!meMarker) {
    meMarker = L.circleMarker([myPos.lat, myPos.lng], {
      radius: 6, color: '#fff', weight: 1.5, fillColor: '#4e6cff', fillOpacity: 1,
    }).addTo(gameMap);
  } else {
    meMarker.setLatLng([myPos.lat, myPos.lng]);
  }
  // The game map is static (see initGameMap) — never recenters on the player,
  // so the whole play area stays visible and a scroll gesture near the map
  // can't accidentally drag/zoom it instead of the page.
}

function renderGameTasks() {
  if (!gameMap || !state) return;
  const mine = new Map(state.you.tasks.map((t) => [t.taskId, t]));
  const hash = JSON.stringify([state.tasks, state.you.tasks.map((t) => [t.taskId, t.done])]);
  if (hash === lastTaskHash) return;
  lastTaskHash = hash;
  taskLayer.clearLayers();
  for (const t of state.tasks) {
    if (t.anywhere) continue; // wild-card tasks have no fixed spot
    const my = mine.get(t.id);
    const color = my ? (my.done ? '#3ecf6e' : '#ffa502') : '#777790';
    L.circleMarker([t.lat, t.lng], {
      radius: 4, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.95,
    }).addTo(taskLayer).bindTooltip(`${t.name}${my ? ' (yours)' : ''}`);
  }
}

// ---------- settings form ----------
const SETTINGS_META = [
  ['killCooldown', 'Kill cooldown (seconds)'],
  ['killRange', 'Kill / report range (feet)'],
  ['taskRange', 'Task check-off range (feet)'],
  ['impostorCount', 'Impostors (1–2)'],
  ['votingTime', 'Voting time (seconds)'],
  ['tasksPerPlayer', 'Tasks per player'],
  ['roundLength', 'Round time limit (seconds)'],
  ['staleAfter', 'GPS offline after (seconds)'],
  ['blockDuration', 'Block Location duration (seconds)'],
  ['blockCooldown', 'Block Location cooldown after (seconds)'],
  ['meetingCallRange', 'Emergency meeting call range (feet)'],
  ['ghostChatCooldown', 'Ghost hint cooldown (seconds)'],
];
let settingsBuilt = false;

// Settings inputs re-sync from state.settings on every render — and renders
// happen every ~2s even in the lobby, because GPS position updates broadcast
// unconditionally regardless of phase (see the setInterval below that emits
// 'pos'). Guarding a resync with "is this input currently focused" isn't
// reliable on mobile (a checkbox tap doesn't always hold focus the way a
// mouse click does), so a broadcast that's still in flight from before the
// host's edit landed could otherwise snap a checkbox/number right back.
// Instead, once the host changes a setting, hold that value locally and keep
// showing it — ignoring incoming state — until the server's own broadcast
// confirms the same value, at which point trusting state again is safe.
const pendingSettingOverride = {};
function settingChanged(key, value) {
  pendingSettingOverride[key] = value;
  socket.emit('settings', { [key]: value });
}
// True if a control for `key` should keep showing its own pending value
// rather than being overwritten by state.settings right now.
function hasPendingSetting(key) {
  if (!(key in pendingSettingOverride)) return false;
  if (state.settings[key] === pendingSettingOverride[key]) {
    delete pendingSettingOverride[key]; // server caught up — safe to trust state again
    return false;
  }
  return true;
}

function buildSettingsForm() {
  if (settingsBuilt) return;
  settingsBuilt = true;
  const form = $('settings-form');

  const note = document.createElement('p');
  note.id = 'autoscale-note';
  note.className = 'hint';
  form.append(note);

  for (const [key, label] of SETTINGS_META) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.id = 'set-' + key;
    inp.onchange = () => settingChanged(key, Number(inp.value));
    row.append(lab, inp);
    form.append(row);
    if (key === 'roundLength') {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'small';
      resetBtn.textContent = 'Use recommended for this many players';
      resetBtn.onclick = () => socket.emit('resetAutoScale');
      form.append(resetBtn);
    }
  }
}

function fillSettingsForm() {
  for (const [key] of SETTINGS_META) {
    const inp = $('set-' + key);
    if (inp && document.activeElement !== inp && !hasPendingSetting(key)) inp.value = state.settings[key];
  }
  const note = $('autoscale-note');
  if (note) {
    note.textContent = state.autoScale
      ? `Tasks per player and round time are auto-set for ${state.players.length} players (adding/removing players updates them). Change either by hand to lock them in.`
      : 'Tasks per player and round time are locked in by hand — tap "Use recommended" to go back to auto.';
  }
  const autoStartBox = $('set-timerAutoStart');
  if (autoStartBox && document.activeElement !== autoStartBox && !hasPendingSetting('timerAutoStart')) autoStartBox.checked = state.settings.timerAutoStart;
  const ghostRolesBox = $('set-ghostRolesEnabled');
  if (ghostRolesBox && document.activeElement !== ghostRolesBox && !hasPendingSetting('ghostRolesEnabled')) ghostRolesBox.checked = state.settings.ghostRolesEnabled;
  const taskDisbursementBox = $('set-taskDisbursementEnabled');
  if (taskDisbursementBox && document.activeElement !== taskDisbursementBox && !hasPendingSetting('taskDisbursementEnabled')) taskDisbursementBox.checked = state.settings.taskDisbursementEnabled;
}

// ---------- main render ----------
socket.on('state', (s) => {
  state = s;
  if (typeof s.roundSecondsLeft === 'number') {
    roundBase = { secondsLeft: s.roundSecondsLeft, receivedAt: Date.now(), paused: !!s.roundPaused, held: !!s.roundHeld };
  }
  render();
});

socket.on('disconnect', () => toast('Connection lost — reconnecting…'));

function render() {
  if (!state) return;

  // Meeting begins: two firm buzzes + slam the camera shut so nobody misses it.
  if (state.phase === 'meeting' && lastPhase !== 'meeting') {
    voteChoice = null; // fresh selection each meeting
    if (!$('camera-overlay').classList.contains('hidden')) closeCamera();
    if (navigator.vibrate) navigator.vibrate([450, 250, 450]); // buzz — pause — buzz
  }
  // Any phase change other than an open camera during play should also close it.
  if (state.phase !== 'playing' && !$('camera-overlay').classList.contains('hidden')) {
    closeCamera();
  }
  if (state.phase === 'playing' && lastPhase === 'lobby') {
    gameCount++;
    seeLocationShownUntil = 0; // fresh game, allow a new reveal to draw
    if (seeLocationLayer) seeLocationLayer.clearLayers();
  }
  // The game map's container sits behind #screen-meeting (display:none) for
  // the whole meeting, which leaves Leaflet's cached tile layout stale — this
  // was the "map doesn't reload properly after a meeting" bug. Fix it in
  // place (no refit, so a player's pan/zoom isn't yanked around) whenever the
  // game screen comes back into view.
  const gameMapNeedsRefresh = state.phase === 'playing' && lastPhase === 'meeting';
  lastPhase = state.phase;

  // Kill screen: covers the whole screen the moment you've been killed (not
  // ejected — that has its own banner), and stays up until dismissed, once
  // per game, regardless of how many more state updates arrive in between.
  if (
    (state.phase === 'playing' || state.phase === 'meeting') &&
    !state.you.alive && !state.you.ejected &&
    killScreenShownFor !== gameCount
  ) {
    killScreenShownFor = gameCount;
    $('kill-modal').classList.remove('hidden');
  }

  // Host-only end-game-early arrow, reachable from either the game screen or
  // a meeting — fixed to the corner of the viewport regardless of which.
  $('btn-endgame-early').classList.toggle(
    'hidden',
    !(state.isHost && (state.phase === 'playing' || state.phase === 'meeting'))
  );

  if (state.phase === 'lobby') renderLobby();
  else if (state.phase === 'playing') renderGame(gameMapNeedsRefresh);
  else if (state.phase === 'meeting') renderMeeting();
  else if (state.phase === 'ended') renderEnd();
}

function renderLobby() {
  showScreen('lobby');
  lastTaskHash = '';
  $('lobby-code').textContent = state.code;
  $('players-count').textContent = `${state.players.length} / ${state.maxPlayers}`;

  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of state.players) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `<span class="dot ${p.connected ? '' : 'off'}"></span><span>${esc(p.name)}</span>` +
      (p.isHost ? '<span class="host-tag">host</span>' : '') +
      (p.isBot ? '<span class="dead-tag">bot</span>' : '');
    if (p.isBot && state.isHost) {
      const rm = document.createElement('button');
      rm.className = 'bot-remove';
      rm.textContent = '✕';
      rm.onclick = () => socket.emit('removeBot', { botKey: p.key });
      row.append(rm);
    }
    list.append(row);
  }

  $('host-panel').classList.toggle('hidden', !state.isHost);
  $('waiting-msg').classList.toggle('hidden', state.isHost);
  if (state.isHost) {
    buildSettingsForm();
    fillSettingsForm();
    initLobbyMap();
    setTimeout(() => lobbyMap && lobbyMap.invalidateSize(), 50);
    renderLobbyTasks();
    renderStreetSegments();
    renderMeetingLocations(lobbyMap, 'lobby');
    renderArea(lobbyMap, 'lobby');
    $('area-pill').textContent = (state.area || []).length >= 3 ? 'set ✓' : 'none';
    setDrawButtons();
    setSegmentDrawButtons();
    $('btn-meetingloc-add').textContent = addingMeetingLocation ? 'Adding… (tap map)' : '📍 Add spot: tap map';
  }
}

function renderGame(needsRefresh) {
  showScreen('game');
  keepAwake();
  initGameMap();
  // Only re-fit the view once per new game (not on every state tick) — now
  // that the map can be zoomed/panned, refitting on every broadcast would
  // keep yanking a player's view back while they're looking around.
  if (mapFittedForGame !== gameCount) {
    mapFittedForGame = gameCount;
    setTimeout(() => {
      if (!gameMap) return;
      gameMap.invalidateSize();
      defaultView(gameMap);
    }, 50);
  } else if (needsRefresh) {
    // Returning from a meeting: same map, same view, just needs Leaflet to
    // notice its container is visible again (see the note above lockMapBounds).
    setTimeout(() => gameMap && gameMap.invalidateSize(), 50);
  }
  updateMeMarker();
  renderGameTasks();
  renderArea(gameMap, 'game');
  renderMeetingLocations(gameMap, 'game');

  const you = state.you;

  // Show the role card once per game start. It stays up for at least 1.5s so
  // players are sure of their role before they can dismiss it.
  if (roleShownFor !== gameCount) {
    roleShownFor = gameCount;
    const impostor = you.role === 'impostor';
    $('role-modal-title').textContent = impostor ? 'IMPOSTOR' : 'CREWMATE';
    $('role-modal-title').style.color = impostor ? '#ff4757' : '#4e6cff';
    let sub = impostor
      ? 'Blend in. Pretend to do your (fake) tasks. Get close to kill.'
      : 'Finish your tasks. Report any body you find.';
    if (impostor && state.fellowImpostors && state.fellowImpostors.length) {
      sub += ` Your fellow impostor: ${state.fellowImpostors.join(', ')}.`;
    }
    $('role-modal-sub').textContent = sub;
    $('role-modal').classList.remove('hidden');
    const ok = $('role-modal-ok');
    ok.disabled = true;
    ok.textContent = 'Wait…';
    setTimeout(() => { ok.disabled = false; ok.textContent = 'Got it'; }, 1500);
  }

  // No persistent role label in the top bar — a glance at someone's phone
  // shouldn't reveal whether they're the impostor.
  $('progress-chip').textContent = `Tasks ${state.taskProgress.done}/${state.taskProgress.total}`;

  // Both buttons vanish entirely (not just disabled) once used, or if dead.
  const canCallMeeting = you.alive && !you.calledMeeting && state.phase === 'playing' && you.nearMeetingLocation;
  $('btn-callvote').classList.toggle('hidden', !canCallMeeting);
  const canSeeLocation = you.alive && you.role !== 'impostor' && !you.usedSeeLocation && state.phase === 'playing';
  $('btn-seelocation').classList.toggle('hidden', !canSeeLocation);
  // Block Location sits in the same slot for the impostor instead — unlike
  // See Location it's repeatable, so it only fully disappears when dead/the
  // round ends; while on cooldown it stays visible but shows a countdown
  // (handled live in renderDynamic, since that ticks every 500ms).
  const canBlockLocation = you.alive && you.role === 'impostor' && state.phase === 'playing';
  $('btn-blocklocation').classList.toggle('hidden', !canBlockLocation);
  if (!canBlockLocation && placingBlock) { placingBlock = false; renderBlockPicker(); }

  renderBots();
  renderSeeLocationReveal();
  renderTestPanel('test-panel');
  renderDeadArea();
  renderGhostInbox('ghost-log-game');
  renderTaskList();
  renderDynamic(); // report + kill corners, gps chip, countdowns
}

function renderDeadArea() {
  const you = state.you;
  const area = $('dead-area');
  if (you.alive) {
    area.innerHTML = '';
    return;
  }
  // Reuse the existing banner/composer nodes across renders instead of
  // wiping and rebuilding them every state tick (renders happen every ~2s
  // even mid-game from GPS pos updates) — rebuilding the ghost composer's
  // <input> every tick was destroying whatever the player had typed and
  // stealing focus before they could finish a hint.
  let div = area.querySelector('.banner');
  if (!div) {
    div = document.createElement('div');
    area.append(div);
  }
  if (you.ejected) {
    div.className = 'banner info';
    div.textContent = 'You were ejected. Keep quietly finishing your tasks.';
  } else if (you.foundDead) {
    div.className = 'banner info';
    div.textContent = 'Your body was found. You may finish your tasks now (stay muted!).';
  } else {
    div.className = 'banner dead';
    div.id = 'dead-banner';
    div.textContent = 'You are DEAD. Stay where you are and stay quiet. Your tasks were shared with the crew.';
  }
  if (you.foundDead && you.ghostRole) {
    renderGhostComposer(area);
  } else {
    const existing = area.querySelector('.ghost-composer');
    if (existing) existing.remove();
  }
}

// Troll/Helper hint composer: the only "chat" a ghost has, and it's not free
// text — the wording is fixed, the player only fills in a location and picks
// exactly one living player to DM it to (never a broadcast). One send at a
// time, then a cooldown (see renderDynamic for the live countdown).
//
// Builds its DOM once per container and reuses it on later calls, only
// diffing the target dropdown's option list — never touching the text input
// — so a re-render (which happens every ~2s from GPS traffic alone) can't
// wipe what the player is mid-typing or steal focus out from under them.
function renderGhostComposer(container) {
  const living = (state.players || []).filter((p) => !p.dead && p.key !== state.you.key);
  let wrap = container.querySelector('.ghost-composer');

  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'ghost-composer';
    const label = document.createElement('p');
    label.className = 'hint';
    label.textContent = 'Send a private hint to one living player — you can only fill in who and the location:';
    wrap.append(label);

    const targetRow = document.createElement('div');
    targetRow.className = 'ghost-input-row';
    const targetLabel = document.createElement('span');
    targetLabel.textContent = 'Send to:';
    const select = document.createElement('select');
    select.id = 'ghost-hint-target';
    targetRow.append(targetLabel, select);
    wrap.append(targetRow);

    const row = document.createElement('div');
    row.className = 'ghost-input-row';
    const prefix = document.createElement('span');
    prefix.textContent = 'The imposter is headed toward:';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'ghost-hint-input';
    input.maxLength = 60;
    input.placeholder = 'e.g. the park';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'small';
    sendBtn.id = 'ghost-hint-send';
    sendBtn.textContent = 'Send';
    sendBtn.onclick = () => {
      const stillLiving = (state.players || []).filter((p) => !p.dead && p.key !== state.you.key);
      if (!stillLiving.length) return toast('No living players to send to right now.');
      const loc = input.value.trim();
      if (!loc) return toast('Type a location first.');
      socket.emit('ghostHint', { location: loc, targetKey: select.value });
      input.value = '';
    };
    row.append(prefix, input, sendBtn);
    wrap.append(row);
    container.append(wrap);
  }

  // Only rebuild the dropdown's options if the actual set of living players
  // changed, and preserve whichever one was already selected if it's still valid.
  const select = wrap.querySelector('#ghost-hint-target');
  const livingKey = living.map((p) => p.key).join(',');
  if (select.dataset.livingKey !== livingKey) {
    const prevValue = select.value;
    select.innerHTML = '';
    for (const p of living) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.name;
      select.append(opt);
    }
    select.dataset.livingKey = livingKey;
    if (living.some((p) => p.key === prevValue)) select.value = prevValue;
  }
}

// Private inbox of ghost hints sent TO this player, shown only on the regular
// game screen — never during a meeting. Sender name shown (they're already
// publicly dead), never their Troll/Helper alignment.
function renderGhostInbox(containerId) {
  const el = $(containerId);
  if (!el || !state) return;
  const msgs = state.you.ghostInbox || [];
  el.innerHTML = '';
  if (!msgs.length) return;
  el.className = 'ghost-log';
  const h = document.createElement('h3');
  h.textContent = '👻 A ghost hint, just for you';
  el.append(h);
  for (const m of msgs.slice(-5).reverse()) {
    const row = document.createElement('div');
    row.className = 'ghost-log-row';
    row.textContent = `${m.senderName}: The imposter is headed toward ${m.location}`;
    el.append(row);
  }
}

// Backup text chat for the living during a meeting, in case the voice call
// drops. Everyone present can read it (dead players can watch, like the vote
// list), but only living players get the input box. Never carries over
// between meetings — the server clears it the instant a new one starts.
function renderMeetingChat() {
  const log = $('meeting-chat-log');
  log.innerHTML = '';
  for (const m of (state.meetingChat || [])) {
    const row = document.createElement('div');
    row.className = 'meeting-chat-row';
    row.textContent = `${m.senderName}: ${m.text}`;
    log.append(row);
  }
  log.scrollTop = log.scrollHeight;
  $('meeting-chat-compose').classList.toggle('hidden', !state.you.alive);
}

// Report button lives in the bottom-left corner of the map; it's rebuilt from
// renderDynamic so it appears/vanishes live as you approach a body.
function renderReportOverlay(online) {
  const overlay = $('report-overlay');
  const bodies = (online && state && state.you.alive && state.phase === 'playing') ? (state.nearbyBodies || []) : [];
  // Buzz the moment a reportable body comes into range, same as the kill button.
  const reportReady = bodies.length > 0;
  if (reportReady && !reportReadyPrev && navigator.vibrate) navigator.vibrate([60, 40, 60]);
  reportReadyPrev = reportReady;
  const key = bodies.map((b) => b.key).join(',');
  if (overlay.dataset.key === key) return;
  overlay.dataset.key = key;
  overlay.innerHTML = '';
  for (const b of bodies) {
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = `⚠️ REPORT ${b.name.toUpperCase()}`;
    btn.onclick = () => socket.emit('report', { bodyKey: b.key });
    overlay.append(btn);
  }
}

// ---------- in-app camera (photo tasks) ----------
// Photos are shown on screen only and saved nowhere. The player never leaves
// the game, so meeting alerts and GPS keep working while they snap.
let cameraStream = null;
let cameraFacing = 'user';
let cameraTaskId = null; // assignmentId of the task being photographed
const photoTaken = new Set(); // assignmentIds that have a captured photo this session

async function startCameraStream() {
  stopCameraStream();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacing },
      audio: false,
    });
    $('camera-video').srcObject = cameraStream;
  } catch (e) {
    toast('Camera unavailable — allow camera access to do photo tasks.');
    closeCamera();
  }
}

function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
}

function openCamera(task) {
  cameraTaskId = task.assignmentId;
  $('camera-overlay').classList.remove('hidden');
  $('camera-review').classList.add('hidden');
  $('camera-controls').classList.remove('hidden');
  $('camera-photo').classList.add('hidden');
  $('camera-video').classList.remove('hidden');
  startCameraStream();
}

function closeCamera() {
  stopCameraStream();
  $('camera-photo').src = ''; // discard the image — nothing is saved
  $('camera-overlay').classList.add('hidden');
  cameraTaskId = null;
}

function snapPhoto() {
  const v = $('camera-video');
  if (!v.videoWidth) return;
  const c = $('camera-canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  if (cameraFacing === 'user') {
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1); // un-mirror so the saved frame matches what they saw
  }
  ctx.drawImage(v, 0, 0, c.width, c.height);
  $('camera-photo').src = c.toDataURL('image/jpeg', 0.8);
  $('camera-photo').classList.remove('hidden');
  $('camera-video').classList.add('hidden');
  $('camera-controls').classList.add('hidden');
  $('camera-review').classList.remove('hidden');
  stopCameraStream(); // freeze the preview
}

function keepPhoto() {
  if (cameraTaskId != null) photoTaken.add(cameraTaskId);
  closeCamera();
  renderTaskList();
  toast('Photo taken — now tap Done to finish the task.');
}

$('camera-close').onclick = closeCamera;
$('camera-shutter').onclick = snapPhoto;
$('camera-flip').onclick = () => {
  cameraFacing = cameraFacing === 'user' ? 'environment' : 'user';
  $('camera-video').style.transform = cameraFacing === 'user' ? 'scaleX(-1)' : 'none';
  startCameraStream();
};
$('camera-retake').onclick = () => {
  $('camera-review').classList.add('hidden');
  $('camera-controls').classList.remove('hidden');
  $('camera-photo').classList.add('hidden');
  $('camera-video').classList.remove('hidden');
  startCameraStream();
};
$('camera-keep').onclick = keepPhoto;

// Tasks are collapsed rows; tapping one reveals Location / Explain / Done so
// a stray tap can't accidentally complete a task.
let expandedTaskId = null;
let pinnedTaskId = null;
let pinMarker = null;

function setPin(t) {
  clearPin();
  pinnedTaskId = t.assignmentId;
  if (gameMap) {
    pinMarker = L.circleMarker([t.lat, t.lng], {
      radius: 7, color: '#fff', weight: 1.5, fillColor: '#ff4757', fillOpacity: 1,
    }).addTo(gameMap).bindTooltip(t.name);
    // Map is static (never pans/zooms) — the pin just appears in place on the
    // already-visible play area instead of the view jumping to it.
  }
}

function clearPin() {
  if (pinMarker && gameMap) gameMap.removeLayer(pinMarker);
  pinMarker = null;
  pinnedTaskId = null;
}

function renderTaskList() {
  const list = $('task-list');
  list.innerHTML = '';
  const you = state.you;
  if (!you.tasks.length) return;
  const head = document.createElement('h3');
  head.textContent = you.role === 'impostor' ? 'Your "tasks"' : 'Your tasks';
  list.append(head);
  for (const t of you.tasks) {
    const row = document.createElement('div');
    row.className = 'task-row' + (t.done ? ' done' : '') + (expandedTaskId === t.assignmentId ? ' expanded' : '');
    const name = document.createElement('span');
    name.className = 'task-name';
    name.textContent = (t.done ? '✓ ' : '') + t.name + (t.shared ? ' 🤝' : '');
    const dist = document.createElement('span');
    dist.className = 'task-dist';
    if (t.anywhere) {
      dist.textContent = 'anywhere'; // wild-card task, no fixed spot
    } else {
      dist.dataset.lat = t.lat;
      dist.dataset.lng = t.lng;
    }
    row.append(name, dist);

    // Both finished and unfinished tasks expand — a finished one just shows
    // Explain + Undo instead of Location/Photo/Done, so a mistaken tap on
    // Done can be walked back.
    row.onclick = () => {
      expandedTaskId = expandedTaskId === t.assignmentId ? null : t.assignmentId;
      renderTaskList();
      renderDynamic();
    };
    if (expandedTaskId === t.assignmentId) {
      const actions = document.createElement('div');
      actions.className = 'task-actions';

      const expBtn = document.createElement('button');
      expBtn.textContent = '❓ Explain';
      expBtn.onclick = (e) => {
        e.stopPropagation();
        const extra = t.shared ? '\n\n(Shared from a fallen crewmate — either of you finishing it completes the task.)' : '';
        showInfo(t.name, (t.explanation || 'No detailed instructions have been added for this task yet.') + extra);
      };

      const btns = [];

      if (t.done) {
        // Undo sits in the exact spot the Done button used to occupy.
        const undoBtn = document.createElement('button');
        undoBtn.className = 'undo';
        undoBtn.textContent = '↩ Unfinish';
        undoBtn.onclick = (e) => {
          e.stopPropagation();
          expandedTaskId = null;
          socket.emit('untask', { assignmentId: t.assignmentId });
        };
        btns.push(expBtn, undoBtn);
      } else {
        // Wild-card tasks have no location, so no Location button.
        let locBtn = null;
        if (!t.anywhere) {
          locBtn = document.createElement('button');
          const pinned = pinnedTaskId === t.assignmentId;
          locBtn.className = pinned ? '' : 'loc';
          locBtn.textContent = pinned ? 'Unpin location' : '📍 Location';
          locBtn.onclick = (e) => {
            e.stopPropagation();
            if (pinned) clearPin(); else setPin(t);
            renderTaskList();
          };
        }

        let photoBtn = null;
        if (t.photo) {
          photoBtn = document.createElement('button');
          const has = photoTaken.has(t.assignmentId);
          photoBtn.textContent = has ? '📷 Retake' : '📷 Photo';
          if (has) photoBtn.classList.add('go');
          photoBtn.onclick = (e) => {
            e.stopPropagation();
            openCamera(t);
          };
        }

        const doneBtn = document.createElement('button');
        doneBtn.className = 'go';
        doneBtn.textContent = '✔ Done';
        doneBtn.onclick = async (e) => {
          e.stopPropagation();
          if (t.photo && !photoTaken.has(t.assignmentId)) {
            toast('Take your photo first, then tap Done.');
            openCamera(t);
            return;
          }
          const far = !t.anywhere && (!myPos || feetBetween(myPos, t) > state.settings.taskRange);
          if (far && !(await askYesNo(`You don't seem to be at "${t.name}". Did you actually complete this task?`))) return;
          if (pinnedTaskId === t.assignmentId) clearPin();
          expandedTaskId = null;
          socket.emit('task', { assignmentId: t.assignmentId });
        };

        if (locBtn) btns.push(locBtn);
        btns.push(expBtn);
        if (photoBtn) btns.push(photoBtn);
        btns.push(doneBtn);
      }

      actions.append(...btns);
      row.append(actions);
    }
    list.append(row);
  }
}

// Everything that ticks: cooldowns, distances, GPS chip, kill buttons.
// Host-only round-timer pause popover: tapping the clock reveals a single
// Pause/Unpause/Start button whose label always matches the current state.
let roundPopoverOpen = false;
function updateRoundPopoverButton(roundLeftNow) {
  const btn = $('btn-toggle-timer');
  if (!btn || !state) return;
  if (!state.isHost || (state.phase !== 'playing' && state.phase !== 'meeting')) {
    roundPopoverOpen = false;
    $('round-popover').classList.add('hidden');
    return;
  }
  const held = !!(roundBase && roundBase.held);
  const neverStarted = held && roundLeftNow === state.settings.roundLength;
  btn.textContent = held ? (neverStarted ? '▶ Start Timer' : '▶ Unpause Timer') : '⏸ Pause Timer';
}

function renderDynamic() {
  if (!state || state.phase === 'lobby') return;
  const you = state.you;

  // If the socket has dropped (screen lock, backgrounded tab, dead signal),
  // everything below is stale — surface that persistently instead of a toast
  // that fades in 3.5s, and don't act on data we can no longer trust.
  const online = socket.connected;
  const gps = $('gps-chip');
  const gpsOk = online && myPos && Date.now() - myPos.ts < 15000 && you.gpsFresh !== false;
  gps.textContent = !online ? 'OFFLINE' : gpsOk ? 'GPS ✓' : 'GPS…';
  gps.className = 'chip ' + (online && gpsOk ? 'ok' : 'bad');

  // Round clock: visible to everyone, freezes during meetings, ticks locally
  // between server updates so it doesn't need a push every second. A host-held
  // pause (or "not started yet") shows green; a plain meeting-freeze is orange.
  const round = $('round-chip');
  let roundLeftNow = null;
  if (round && roundBase && (state.phase === 'playing' || state.phase === 'meeting')) {
    const elapsed = roundBase.paused ? 0 : Math.floor((Date.now() - roundBase.receivedAt) / 1000);
    roundLeftNow = Math.max(0, roundBase.secondsLeft - elapsed);
    round.textContent = roundBase.paused ? `⏸ ${fmt(roundLeftNow)}` : `⏱ ${fmt(roundLeftNow)}`;
    round.className = 'chip ' + (roundBase.held ? 'held' : roundBase.paused ? 'paused' : roundLeftNow <= 60 ? 'low' : '');
  }
  updateRoundPopoverButton(roundLeftNow);

  // live task distances
  document.querySelectorAll('.task-dist').forEach((el) => {
    if (el.dataset.lat === undefined) return; // wild-card task, shows "anywhere"
    if (!myPos) { el.textContent = ''; return; }
    const d = feetBetween(myPos, { lat: Number(el.dataset.lat), lng: Number(el.dataset.lng) });
    el.textContent = `${Math.round(d)} ft`;
  });

  // Report button in the bottom-left corner, live.
  renderReportOverlay(online);

  // Kill buttons at the bottom of the panel (below the fold). They appear ONLY
  // when a victim is in range AND the cooldown is up — nothing shows otherwise,
  // and there's no countdown, so a glance at the phone never outs the impostor.
  const panel = $('kill-panel');
  const offCooldown = Date.now() >= (you.cooldownUntil || 0);
  const targets = (online && you.role === 'impostor' && you.alive && state.phase === 'playing' && offCooldown)
    ? (state.killTargets || []) : [];
  // Private buzz the moment a kill becomes available, so the impostor knows to
  // flick down to the button without staring at the screen. (No-op on iPhones,
  // which don't support web vibration — there the button is still one flick away.)
  const killReady = targets.length > 0;
  if (killReady && !killReadyPrev && navigator.vibrate) navigator.vibrate([60, 40, 60]);
  killReadyPrev = killReady;
  const panelKey = targets.map((t) => t.key).join(',');
  if (panel.dataset.key !== panelKey) {
    panel.dataset.key = panelKey;
    panel.innerHTML = '';
    if (targets.length) {
      // A spacer keeps the kill button below the visible fold, so the impostor
      // must scroll down to it — nobody spots it glancing at the phone.
      const spacer = document.createElement('div');
      spacer.className = 'kill-spacer';
      panel.append(spacer);
      for (const t of targets) {
        const btn = document.createElement('button');
        btn.className = 'danger';
        btn.textContent = `🔪 KILL ${t.name.toUpperCase()}`;
        btn.onclick = () => socket.emit('kill', { targetKey: t.key });
        panel.append(btn);
      }
    }
  }

  // Block Location button: unlike kill/report it's fine to show its own
  // cooldown countdown — it's a repeatable ability only the impostor ever
  // sees, there's no bystander-glancing-at-the-phone concern like with kill.
  const blockBtn = $('btn-blocklocation');
  if (!blockBtn.classList.contains('hidden')) {
    const blockReady = online && Date.now() >= (you.blockCooldownUntil || 0);
    blockBtn.disabled = !blockReady;
    blockBtn.textContent = blockReady
      ? '🚫 Block Location'
      : `🚫 Block Location (${fmt(Math.max(0, Math.ceil((you.blockCooldownUntil - Date.now()) / 1000)))})`;
  }

  // Ghost hint send button: same live-countdown treatment as Block Location.
  const ghostSendBtn = $('ghost-hint-send');
  if (ghostSendBtn) {
    const ghostReady = online && Date.now() >= (you.ghostChatCooldownUntil || 0);
    ghostSendBtn.disabled = !ghostReady;
    const ghostInput = $('ghost-hint-input');
    if (ghostInput) ghostInput.disabled = !ghostReady;
    ghostSendBtn.textContent = ghostReady
      ? 'Send'
      : `Wait (${fmt(Math.max(0, Math.ceil((you.ghostChatCooldownUntil - Date.now()) / 1000)))})`;
  }

  // Active road closures: red highlight for everyone, plus a big popup the
  // instant a new one appears (once per block, tracked by its id).
  renderActiveBlocks();
  for (const b of (state.activeBlocks || [])) {
    if (!announcedBlockIds.has(b.id)) {
      announcedBlockIds.add(b.id);
      showBlockBanner(b);
    }
  }

  // Fairness heads-up for everyone but the impostor who set it: there's no
  // way to actually stop a player from walking through a blocked section, so
  // this is just an honest notice. Edge-triggered so it only pops up once on
  // entry (not every tick while standing in the zone), and requires tapping
  // "I understand" rather than fading on its own like the public banner does.
  if (you.role !== 'impostor' && myPos) {
    const zonesHere = liveBlocks().filter((b) => distanceToPolylineFeet(myPos, b.points) <= 40);
    const inZone = zonesHere.length > 0;
    if (inZone && !inBlockZonePrev) {
      $('redzone-modal-sub').textContent = zonesHere.map((b) => b.name).join(', ');
      $('redzone-modal').classList.remove('hidden');
    }
    inBlockZonePrev = inZone;
  } else {
    inBlockZonePrev = false;
  }

  // meeting countdown
  if (state.phase === 'meeting' && state.meeting) {
    const left = Math.max(0, Math.ceil((state.meeting.endsAt - Date.now()) / 1000));
    $('meeting-timer').textContent = fmt(left);
  }

  // Keep the meeting map's active-closure highlights accurate in real time
  // (same reasoning as liveBlocks() elsewhere: a closure can expire between
  // server broadcasts).
  if (state.phase === 'meeting' && meetingMapShown && meetingMap) {
    renderMeetingMapContents();
  }
}
setInterval(renderDynamic, 500);

let lastMeetingKey = null; // resets the map toggle back to hidden for each new meeting
function renderMeeting() {
  showScreen('meeting');
  const m = state.meeting;
  if (!m) return;
  const meetingKey = `${m.reporterName}|${m.victimName}|${m.endsAt}`;
  if (meetingKey !== lastMeetingKey) {
    lastMeetingKey = meetingKey;
    meetingMapShown = false;
    $('meeting-map').classList.add('hidden');
    $('btn-meeting-map-toggle').textContent = '🗺️ Show Map';
  }
  $('meeting-info').textContent = m.victimName
    ? `${m.reporterName} reported ${m.victimName}'s body.`
    : `${m.reporterName} called an emergency vote.`;
  renderMeetingChat();

  const you = state.you;
  const list = $('vote-list');
  list.innerHTML = '';
  const canVote = you.alive && m.yourVote === null;
  // Tapping a name only SELECTS it (highlight); the vote isn't sent until the
  // player presses Confirm. Once voted, the server's yourVote wins.
  const chosen = m.yourVote !== null ? m.yourVote : voteChoice;
  for (const c of m.candidates) {
    const btn = document.createElement('button');
    btn.className = chosen === c.key ? 'selected' : '';
    const voted = state.players.find((p) => p.key === c.key)?.voted;
    btn.innerHTML = `<span>${esc(c.name)}</span><span>${voted ? '🗳' : ''}</span>`;
    btn.disabled = !canVote;
    btn.onclick = () => { voteChoice = c.key; renderMeeting(); };
    list.append(btn);
  }
  const skip = document.createElement('button');
  skip.className = 'skip' + (chosen === 'skip' ? ' selected' : '');
  skip.textContent = 'Skip vote';
  skip.disabled = !canVote;
  skip.onclick = () => { voteChoice = 'skip'; renderMeeting(); };
  list.append(skip);

  const confirm = $('btn-confirm-vote');
  confirm.classList.toggle('hidden', !canVote);
  confirm.disabled = voteChoice === null;
  if (voteChoice === 'skip') confirm.textContent = 'Confirm skip';
  else if (voteChoice) {
    const name = m.candidates.find((c) => c.key === voteChoice);
    confirm.textContent = name ? `Confirm vote: ${name.name}` : 'Confirm vote';
  } else {
    confirm.textContent = 'Pick someone, then confirm';
  }

  $('meeting-status').textContent = !you.alive
    ? 'You are dead — you can watch, but not vote.'
    : m.yourVote !== null
      ? 'Vote cast. Waiting for the others…'
      : '';
  const ghostComposerMeeting = $('ghost-composer-meeting');
  if (!you.alive && you.foundDead && you.ghostRole) {
    renderGhostComposer(ghostComposerMeeting);
  } else {
    ghostComposerMeeting.innerHTML = '';
  }
  renderTestPanel('meeting-test');
  renderDynamic();
}

function renderEnd() {
  showScreen('end');
  if (state.winner === null) {
    $('end-title').textContent = 'GAME ENDED';
    $('end-title').style.color = 'var(--muted)';
    $('end-sub').textContent = 'The host ended this game early.';
    $('btn-again').classList.toggle('hidden', !state.isHost);
    return;
  }
  const crewWon = state.winner === 'crew';
  $('end-title').textContent = crewWon ? 'CREW WINS' : 'IMPOSTOR WINS';
  $('end-title').style.color = crewWon ? '#4e6cff' : '#ff4757';
  let sub;
  if (crewWon) sub = 'All tasks done or every impostor voted out.';
  else if (state.winReason === 'timeout') sub = "Time ran out before the impostor was caught.";
  else sub = 'The crew has fallen.';
  // The last vote's result ("Nobody was ejected.", etc.) only makes sense as
  // context for a crew win via ejection — it's just noise on an impostor win.
  if (crewWon && state.lastVote) sub += ` (${state.lastVote.text})`;
  $('end-sub').textContent = sub;
  $('btn-again').classList.toggle('hidden', !state.isHost);
}

// vote result flash when returning from a meeting
let lastVoteAt = 0;
socket.on('state', (s) => {
  if (s.lastVote && s.lastVote.at !== lastVoteAt && s.phase !== 'ended') {
    lastVoteAt = s.lastVote.at;
    const parts = Object.entries(s.lastVote.counts).map(([n, c]) => `${n}: ${c}`);
    toast(`${s.lastVote.text}${parts.length ? ' — ' + parts.join(', ') : ''}`, 6000);
  }
});

$('btn-start').onclick = () => socket.emit('start');
$('btn-addbot').onclick = () => socket.emit('addBot');
$('set-timerAutoStart').onchange = (e) => settingChanged('timerAutoStart', e.target.checked);
$('set-ghostRolesEnabled').onchange = (e) => settingChanged('ghostRolesEnabled', e.target.checked);
$('set-taskDisbursementEnabled').onchange = (e) => settingChanged('taskDisbursementEnabled', e.target.checked);

$('round-chip').onclick = () => {
  if (!state || !state.isHost) return;
  roundPopoverOpen = !roundPopoverOpen;
  $('round-popover').classList.toggle('hidden', !roundPopoverOpen);
};
$('btn-toggle-timer').onclick = () => {
  const held = !!(roundBase && roundBase.held);
  socket.emit(held ? 'releaseTimer' : 'holdTimer');
  roundPopoverOpen = false;
  $('round-popover').classList.add('hidden');
};

let playersTabOpen = false;
$('btn-players-tab').onclick = () => {
  playersTabOpen = !playersTabOpen;
  $('lobby-players').classList.toggle('hidden', !playersTabOpen);
  $('btn-players-tab').querySelector('.chevron').textContent = playersTabOpen ? '▴' : '▾';
};
$('btn-area-draw').onclick = () => {
  if (drawingArea) return;
  drawingArea = true;
  draftArea = [];
  updateDraft();
  setDrawButtons();
  toast('Tap the map at each corner of your play area, then press Finish.');
};
$('btn-area-save').onclick = () => {
  if (draftArea.length < 3) return toast('Tap at least 3 corners on the map first.');
  socket.emit('setArea', draftArea.map(([lat, lng]) => ({ lat, lng })));
  drawingArea = false;
  draftArea = [];
  updateDraft();
  setDrawButtons();
};
$('btn-area-clear').onclick = () => {
  drawingArea = false;
  draftArea = [];
  updateDraft();
  setDrawButtons();
  socket.emit('setArea', []);
};
$('btn-segment-draw').onclick = () => {
  if (drawingSegment) return;
  drawingSegment = true;
  draftSegment = [];
  updateSegmentDraft();
  setSegmentDrawButtons();
  toast('Tap the map along the street, then press Finish.');
};
$('btn-segment-save').onclick = async () => {
  if (draftSegment.length < 2) return toast('Tap at least 2 points on the map first.');
  const name = await askText('Name this street section:');
  if (!name) return;
  const segments = state.streetSegments.map((s) => ({ name: s.name, points: s.points }));
  segments.push({ name, points: draftSegment.map(([lat, lng]) => ({ lat, lng })) });
  socket.emit('setStreetSegments', segments);
  drawingSegment = false;
  draftSegment = [];
  updateSegmentDraft();
  setSegmentDrawButtons();
};
$('btn-meetingloc-add').onclick = () => {
  addingMeetingLocation = !addingMeetingLocation;
  $('btn-meetingloc-add').textContent = addingMeetingLocation ? 'Adding… (tap map)' : '📍 Add spot: tap map';
  if (addingMeetingLocation) toast('Tap the map to add a meeting spot. Tap the button again to stop.');
};
$('btn-again').onclick = () => socket.emit('again');
$('btn-endgame-early').onclick = async () => {
  if (await askYesNo('Are you sure you want to end this game early?')) socket.emit('endEarly');
};
$('btn-callvote').onclick = async () => {
  if (await askYesNo("This is your ONE emergency meeting call for the whole game. Use it now?")) socket.emit('callVote');
};
$('btn-seelocation').onclick = async () => {
  if (await askYesNo('This is your ONE See Location use for the whole game. Reveal some players\' locations now?')) socket.emit('seeLocation');
};
$('btn-blocklocation').onclick = () => {
  if ($('btn-blocklocation').disabled) return;
  placingBlock = !placingBlock;
  renderBlockPicker();
  if (placingBlock) toast('Tap a drawn (orange) street section on the map to block it.');
};
$('role-modal-ok').onclick = () => $('role-modal').classList.add('hidden');
// The ghost-role card appears right after the kill screen is dismissed
// (never stacked on top of it), once per game — ghostRole is set server-side
// in the same instant as the kill, so it's already there by the time the
// kill screen first shows.
let ghostRoleShownFor = 0;
$('kill-modal-ok').onclick = () => {
  $('kill-modal').classList.add('hidden');
  if (state && state.you.ghostRole && ghostRoleShownFor !== gameCount) {
    ghostRoleShownFor = gameCount;
    const isTroll = state.you.ghostRole === 'troll';
    $('ghost-modal-title').textContent = isTroll ? "You're now a 😈 TROLL ghost!" : "You're now a 👼 HELPER ghost!";
    $('ghost-modal-title').style.color = isTroll ? '#ff4757' : '#4e6cff';
    $('ghost-modal-sub').textContent = isTroll
      ? 'Once your body is found, you can send one fixed-wording hint at a time — and it doesn\'t have to be true. Have fun misleading the living!'
      : 'Once your body is found, you can send one fixed-wording hint at a time to nudge the living crew toward the truth.';
    $('ghost-modal').classList.remove('hidden');
  }
};
$('redzone-modal-ok').onclick = () => $('redzone-modal').classList.add('hidden');
$('ghost-modal-ok').onclick = () => $('ghost-modal').classList.add('hidden');
$('block-banner').onclick = () => {
  clearTimeout(blockBannerTimer);
  $('block-banner').classList.add('hidden');
};
$('btn-confirm-vote').onclick = () => {
  if (voteChoice === null) return;
  socket.emit('vote', { target: voteChoice });
};
$('meeting-chat-send').onclick = () => {
  const input = $('meeting-chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('meetingChat', { text });
  input.value = '';
};
$('meeting-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('meeting-chat-send').click();
});
$('btn-meeting-map-toggle').onclick = () => {
  meetingMapShown = !meetingMapShown;
  $('meeting-map').classList.toggle('hidden', !meetingMapShown);
  $('btn-meeting-map-toggle').textContent = meetingMapShown ? '🗺️ Hide Map' : '🗺️ Show Map';
  if (meetingMapShown) {
    initMeetingMap();
    setTimeout(() => {
      meetingMap.invalidateSize();
      defaultView(meetingMap);
      renderArea(meetingMap, 'meeting');
      renderMeetingMapContents();
    }, 50);
  }
};
$('dialog-ok').onclick = () => closeDialog(true);
$('dialog-cancel').onclick = () => closeDialog(false);
$('dialog-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeDialog(true);
});

function fmt(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
