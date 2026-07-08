/* global io, L */

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
let roundBase = null; // { secondsLeft, receivedAt, paused } snapshot from the last server state

const $ = (id) => document.getElementById(id);

// Solo-test mode helpers
let fakeMode = false;   // host spoofed their own location by tapping the map
let placingMe = false;  // next map tap sets the host's fake location
let botLayer = null;
const botMarkers = new Map();
let seeLocationLayer = null;
let seeLocationShownUntil = 0; // the reveal's "until" we've already drawn, so we don't re-schedule its clear timer

// ---------- helpers ----------
function feetBetween(a, b) {
  const R = 20902231;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
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
  lobbyMap.on('click', async (e) => {
    if (drawingArea) {
      draftArea.push([e.latlng.lat, e.latlng.lng]);
      updateDraft();
      setDrawButtons();
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
    m.on('click', async () => {
      if (!(await askYesNo(`Remove task "${t.name}"?`))) return;
      const tasks = state.tasks.filter((x) => x.id !== t.id).map((x) => ({ name: x.name, lat: x.lat, lng: x.lng, explanation: x.explanation, photo: x.photo }));
      socket.emit('setTasks', tasks);
    });
  }
  $('task-count').textContent = state.tasks.length;
}

function initGameMap() {
  if (gameMap) return;
  // Static map: framed once on the play area and never pannable/zoomable, so a
  // scroll gesture that starts over the map scrolls the page instead — and the
  // impostor can always reach the kill button below without a stray map drag.
  gameMap = L.map('game-map', {
    zoomControl: false,
    dragging: false,
    touchZoom: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
  });
  defaultView(gameMap);
  tiles().addTo(gameMap);
  taskLayer = L.layerGroup().addTo(gameMap);
  botLayer = L.layerGroup().addTo(gameMap);
  seeLocationLayer = L.layerGroup().addTo(gameMap);
  gameMap.on('click', (e) => {
    if (!placingMe) return;
    placingMe = false;
    fakeMode = true;
    myPos = { lat: e.latlng.lat, lng: e.latlng.lng, ts: Date.now() };
    socket.emit('pos', { lat: myPos.lat, lng: myPos.lng });
    updateMeMarker();
    toast('Test location set — you are the blue dot.');
    renderTestPanel('test-panel');
  });
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
];
let settingsBuilt = false;

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
    inp.onchange = () => socket.emit('settings', { [key]: Number(inp.value) });
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
    if (inp && document.activeElement !== inp) inp.value = state.settings[key];
  }
  const note = $('autoscale-note');
  if (note) {
    note.textContent = state.autoScale
      ? `Tasks per player and round time are auto-set for ${state.players.length} players (adding/removing players updates them). Change either by hand to lock them in.`
      : 'Tasks per player and round time are locked in by hand — tap "Use recommended" to go back to auto.';
  }
  const autoStartBox = $('set-timerAutoStart');
  if (autoStartBox && document.activeElement !== autoStartBox) autoStartBox.checked = state.settings.timerAutoStart;
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
  else if (state.phase === 'playing') renderGame();
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
    renderArea(lobbyMap, 'lobby');
    $('area-pill').textContent = (state.area || []).length >= 3 ? 'set ✓' : 'none';
    setDrawButtons();
  }
}

function renderGame() {
  showScreen('game');
  keepAwake();
  initGameMap();
  setTimeout(() => { if (gameMap) { gameMap.invalidateSize(); defaultView(gameMap); } }, 50);
  updateMeMarker();
  renderGameTasks();
  renderArea(gameMap, 'game');

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
  const canCallMeeting = you.alive && !you.calledMeeting && state.phase === 'playing';
  $('btn-callvote').classList.toggle('hidden', !canCallMeeting);
  const canSeeLocation = you.alive && you.role !== 'impostor' && !you.usedSeeLocation && state.phase === 'playing';
  $('btn-seelocation').classList.toggle('hidden', !canSeeLocation);

  renderBots();
  renderSeeLocationReveal();
  renderTestPanel('test-panel');
  renderDeadArea();
  renderTaskList();
  renderDynamic(); // report + kill corners, gps chip, countdowns
}

function renderDeadArea() {
  const you = state.you;
  const area = $('dead-area');
  area.innerHTML = '';
  if (you.alive) return;
  const div = document.createElement('div');
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
  area.append(div);
}

// Report button lives in the bottom-left corner of the map; it's rebuilt from
// renderDynamic so it appears/vanishes live as you approach a body.
function renderReportOverlay(online) {
  const overlay = $('report-overlay');
  const bodies = (online && state && state.you.alive && state.phase === 'playing') ? (state.nearbyBodies || []) : [];
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

  // meeting countdown
  if (state.phase === 'meeting' && state.meeting) {
    const left = Math.max(0, Math.ceil((state.meeting.endsAt - Date.now()) / 1000));
    $('meeting-timer').textContent = fmt(left);
  }
}
setInterval(renderDynamic, 500);

function renderMeeting() {
  showScreen('meeting');
  const m = state.meeting;
  if (!m) return;
  $('meeting-info').textContent = m.victimName
    ? `${m.reporterName} reported ${m.victimName}'s body.`
    : `${m.reporterName} called an emergency vote.`;

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
$('set-timerAutoStart').onchange = (e) => socket.emit('settings', { timerAutoStart: e.target.checked });

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
$('role-modal-ok').onclick = () => $('role-modal').classList.add('hidden');
$('kill-modal-ok').onclick = () => $('kill-modal').classList.add('hidden');
$('btn-confirm-vote').onclick = () => {
  if (voteChoice === null) return;
  socket.emit('vote', { target: voteChoice });
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
