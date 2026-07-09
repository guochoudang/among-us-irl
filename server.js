const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
// no-store so phones always fetch the latest game code instead of reusing a
// cached copy from an earlier session on the same tunnel link.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;

// All distances are in feet, all times in seconds.
// Every one of these is a host-adjustable pre-game setting.
const DEFAULT_SETTINGS = {
  killCooldown: 120,  // wait between impostor kills
  killRange: 75,      // how close the impostor must be to kill; also the body-report range
  taskRange: 100,     // farther than this from a task, checking it off asks for confirmation
  impostorCount: 1,   // 1 or 2
  votingTime: 120,    // voting window during a meeting
  tasksPerPlayer: 4,  // total tasks per player (1 collaborative + the rest solo)
  roundLength: 1500,  // active-play seconds before the impostor auto-wins (pauses in meetings); 25 min default
  staleAfter: 15,     // no GPS ping for this long = phone counts as offline for kills/reports
  timerAutoStart: true, // if false, the round clock starts paused until the host manually releases it
  blockDuration: 120, // how long a "Block Location" street closure lasts
  blockCooldown: 180, // wait after a block ends before the same impostor can use it again
  meetingCallRange: 100, // how close to a meeting-call spot you must be to call an emergency meeting
  ghostChatCooldown: 60, // wait between ghost hint messages (Troll/Helper), per player
  ghostRolesEnabled: true, // Troll/Helper ghost roles + their private hint DMs, as one package
};

const SETTING_LIMITS = {
  killCooldown: [5, 600],
  killRange: [20, 500],
  taskRange: [20, 1000],
  impostorCount: [1, 2],
  votingTime: [process.env.TEST_MODE ? 3 : 30, 600], // 30s floor keeps real meetings sane; test hook only
  tasksPerPlayer: [1, 20],
  roundLength: [process.env.TEST_MODE ? 5 : 120, 3600], // 120s floor keeps real games sane; test hook only
  staleAfter: [5, 120],
  blockDuration: [10, 600],
  blockCooldown: [10, 600],
  meetingCallRange: [10, 500],
  ghostChatCooldown: [10, 300],
};

// tasksPerPlayer + round length scale with how many people are in the game.
// These are the defaults; the host can still override them in the lobby.
function recommendedFor(playerCount) {
  const n = Math.max(2, Math.min(10, playerCount));
  // Shifted +10 minutes from the original table so the 5-player case lands on
  // the requested 25-minute default, keeping the same relative scaling by size.
  const table = {
    2: { tasksPerPlayer: 3, roundLength: 1080 },  // 18 min
    3: { tasksPerPlayer: 3, roundLength: 1200 },  // 20 min
    4: { tasksPerPlayer: 4, roundLength: 1380 },  // 23 min
    5: { tasksPerPlayer: 4, roundLength: 1500 },  // 25 min
    6: { tasksPerPlayer: 4, roundLength: 1680 },  // 28 min
    7: { tasksPerPlayer: 5, roundLength: 1920 },  // 32 min
    8: { tasksPerPlayer: 5, roundLength: 2100 },  // 35 min
    9: { tasksPerPlayer: 5, roundLength: 2280 },  // 38 min
    10: { tasksPerPlayer: 6, roundLength: 2400 }, // 40 min
  };
  return table[n];
}

function applyAutoScale(room) {
  if (!room.autoScale || room.phase !== 'lobby') return;
  const rec = recommendedFor(Object.keys(room.players).length);
  room.settings.tasksPerPlayer = rec.tasksPerPlayer;
  room.settings.roundLength = rec.roundLength;
}

// Round timer that only ticks during active play (frozen during meetings).
function pauseTimer(room) {
  if (room.timerStartedAt) {
    room.timeLeftMs = Math.max(0, room.timeLeftMs - (now() - room.timerStartedAt));
    room.timerStartedAt = null;
  }
}
function resumeTimer(room) {
  if (room.phase === 'playing' && !room.timerStartedAt) room.timerStartedAt = now();
}
function timerRemainingMs(room) {
  let ms = room.timeLeftMs || 0;
  if (room.timerStartedAt) ms -= now() - room.timerStartedAt;
  return Math.max(0, ms);
}

// The built-in play area every new game starts with. This is the Baxley Court
// neighborhood in Cupertino: east edge traced along Santa Teresa Drive, north
// edge along Hyannisport Drive with a corridor covering all of Rae Lane, west
// edge along Linda Vista Drive with Baxley Court and Linda Vista Park bulging
// out west, south edge traced along Linda Vista Drive.
// To use a different map: replace these points (lat/lng corners, in order),
// or set it to [] and draw the area by hand in the lobby. The host can always
// press Clear in the lobby to override this default for one game.
const DEFAULT_AREA = [
  { lat: 37.30594, lng: -122.05673 }, // Linda Vista Dr x Santa Teresa Dr
  { lat: 37.30670, lng: -122.05672 }, // tracing Santa Teresa Drive north
  { lat: 37.30817, lng: -122.05671 },
  { lat: 37.30901, lng: -122.05667 },
  { lat: 37.30951, lng: -122.05667 },
  { lat: 37.30967, lng: -122.05663 },
  { lat: 37.31023, lng: -122.05647 },
  { lat: 37.31084, lng: -122.05647 },
  { lat: 37.31157, lng: -122.05646 }, // Hyannisport Dr x Santa Teresa Dr
  { lat: 37.31162, lng: -122.05955 }, // Hyannisport x Linda Vista x Rae Ln
  { lat: 37.31191, lng: -122.05995 }, // Rae Lane corridor, north side
  { lat: 37.31192, lng: -122.06083 },
  { lat: 37.31206, lng: -122.06131 },
  { lat: 37.31232, lng: -122.06162 },
  { lat: 37.31287, lng: -122.06227 }, // around the Rae Lane dead end
  { lat: 37.31283, lng: -122.06245 },
  { lat: 37.31259, lng: -122.06229 }, // Rae Lane corridor, south side
  { lat: 37.31205, lng: -122.06168 },
  { lat: 37.31180, lng: -122.06136 },
  { lat: 37.31163, lng: -122.06085 },
  { lat: 37.31161, lng: -122.05997 },
  { lat: 37.31150, lng: -122.05955 }, // rejoin Linda Vista Drive
  { lat: 37.31057, lng: -122.05956 }, // south along Linda Vista Drive
  { lat: 37.31011, lng: -122.05955 },
  { lat: 37.30976, lng: -122.05955 },
  { lat: 37.30945, lng: -122.05954 }, // Baxley Court bump
  { lat: 37.30945, lng: -122.06090 },
  { lat: 37.30884, lng: -122.06090 }, // south end of the bump
  { lat: 37.30884, lng: -122.05955 }, // back to Linda Vista Drive (Linda Vista Park is excluded)
  { lat: 37.30667, lng: -122.05951 }, // continue south along Linda Vista Drive (old park-entrance spot; the entrance task stays here)
  { lat: 37.30602, lng: -122.05836 }, // tracing Linda Vista Drive southeast
  { lat: 37.30596, lng: -122.05809 },
  { lat: 37.30594, lng: -122.05680 }, // closes at the Santa Teresa corner
];

// Street sections every new game starts with, for the impostor's "Block
// Location" ability (each is a named polyline of lat/lng points). Drawn by
// the host in the lobby's "Street sections" tool. The host can still
// add/remove more per-room on top of these.
const DEFAULT_STREET_SEGMENTS = [
  {
    name: 'Northern Santa Teresa',
    points: [
      { lat: 37.31150723180763, lng: -122.05643087630962 },
      { lat: 37.31044910773156, lng: -122.05640405421947 },
      { lat: 37.310225107781285, lng: -122.05642551189159 },
      { lat: 37.3094955033162, lng: -122.05662131314969 },
      { lat: 37.30905531941484, lng: -122.05660164367148 },
      { lat: 37.30910225352324, lng: -122.05670356761404 },
      { lat: 37.30952465918059, lng: -122.05673038970419 },
      { lat: 37.310249996692164, lng: -122.05653727065511 },
      { lat: 37.310450529945925, lng: -122.05652654181905 },
      { lat: 37.31152572039698, lng: -122.05653727065511 },
      { lat: 37.311491587603115, lng: -122.05637633811422 },
    ],
  },
  {
    name: 'Southern Santa Teresa',
    points: [
      { lat: 37.3082161895126, lng: -122.05674737697338 },
      { lat: 37.30601449566175, lng: -122.05677866946647 },
      { lat: 37.305997428015736, lng: -122.05665528785177 },
      { lat: 37.30818632200411, lng: -122.05661237250754 },
      { lat: 37.30820765593997, lng: -122.05681085597463 },
    ],
  },
  {
    name: 'Columbus',
    points: [
      { lat: 37.30827450225476, lng: -122.05948054795954 },
      { lat: 37.30820623369945, lng: -122.0594859123776 },
      { lat: 37.308204100306085, lng: -122.05683857207988 },
      { lat: 37.30829583616560, lng: -122.05685198312497 },
      { lat: 37.30828090242866, lng: -122.05945909028742 },
    ],
  },
  {
    name: 'Hyannisport',
    points: [
      { lat: 37.311497276414, lng: -122.05938935301677 },
      { lat: 37.31166794021547, lng: -122.05937862418071 },
      { lat: 37.31162740759769, lng: -122.05653816467021 },
      { lat: 37.31154420899803, lng: -122.05653011804318 },
      { lat: 37.31148874321375, lng: -122.05934822570273 },
    ],
  },
];

// Spots every new game starts with, where an emergency meeting can be called
// from (each just a named point). Empty by default — draw these once in the
// lobby's "Meeting call spots" tool for the locked-in map, then they'll be
// here for every future game the same way DEFAULT_AREA/DEFAULT_TASKS are.
// If a room ends up with none set, meeting calls fall back to unrestricted
// (see tryCallVote) so this never silently disables an existing feature.
const DEFAULT_MEETING_LOCATIONS = [];

// Tasks every new game starts with (name, location, and detailed
// instructions shown by the task's Explain button). Fill these in as the
// task list for the locked-in map takes shape.
const DEFAULT_TASKS = [
  {
    name: '5 questions (Hyannisport x Linda Vista)',
    lat: 37.311621,
    lng: -122.0595495, // the Hyannisport / Linda Vista / Rae Lane corner
    explanation:
      'You will complete this task with a friend. You will select a non-human object within your line of sight, and your friend will have 5 questions to guess what it is. If they guess wrong, you must try again.',
    collaborative: true,
  },
  {
    name: 'Circular Lap (Baxley Court)',
    lat: 37.30925,
    lng: -122.06055,
    explanation:
      'Take one whole lap around Baxley Court without leaving the sidewalk at all.',
  },
  {
    name: 'Spin and Identify (Bel Aire Court)',
    lat: 37.30752,
    lng: -122.05764,
    explanation:
      'Stand in the center of Bel Aire Court, and pick a house. Then, close your eyes and spin in a circle until you are dizzy. Then, without opening your eyes, try to point at the house you selected. Try again until succeeded.',
  },
  {
    name: 'Win in Tic-Tac-Toe (Hyannisport x Santa Teresa)',
    lat: 37.31157,
    lng: -122.05646,
    explanation:
      'Using any sticks, rocks, grass etc. you find in the area, play a game of tic-tac-toe with someone else at the intersection. You must win the game, or play again.',
    collaborative: true,
  },
  {
    name: 'Sticks and Stones and Words (Linda Vista Park Entrance)',
    lat: 37.30667,
    lng: -122.05951, // park entrance where it meets Linda Vista Drive (sign confirmed here)
    explanation:
      'Using surrounding leaves, sticks, rocks etc. recreate any word on the Linda Vista Park entrance sign longer than 3 letters long (Don\'t do this in the middle of the road!).',
  },
  {
    name: 'Finding Garbage (Rae Lane)',
    lat: 37.31199,
    lng: -122.06060, // mid-Rae Lane
    explanation: 'Find a trash bin.',
  },
  {
    name: 'Rock Selfies (Linda Vista x Evulich)',
    lat: 37.31057,
    lng: -122.05956, // Evulich Court x Linda Vista Drive
    photo: true, // honor-system: one photo unlocks Done; instructions ask for two
    explanation:
      'Take two selfies sitting on two rocks. Your whole body must be on the rock during picture.',
  },
  {
    name: 'Become the Beatles (Linda Vista x Hyannisport)',
    lat: 37.31156,
    lng: -122.05888, // Hyannisport Dr x Linda Vista Dr (the two-way corner, not the Rae Lane one)
    explanation:
      'Walk across the crosswalk, pausing 4 times and posing like one of the 4 Beatles members in Abbey Road.',
  },
  {
    name: 'Do Kung-Fu on a stop sign (Linda Vista x Santa Teresa)',
    lat: 37.30594,
    lng: -122.05673, // south tip of the zone
    explanation:
      'Hit the stop sign with 10 punches (5 from each fist) and 10 kicks (5 from each foot). You must make kung-fu noises throughout.',
  },
  {
    name: 'Leaf From the Same Plant (Linda Vista x Columbus)',
    lat: 37.30824,
    lng: -122.05954,
    explanation:
      'Pick a leaf from a nearby plant without anyone seeing you, then show the leaf to another player. That player must identify correctly which plant you pulled the leaf from. Try again if failed.',
    collaborative: true,
  },
  {
    name: 'Rucker Math (Rucker Drive)',
    lat: 37.30903,
    lng: -122.05767, // mid-lane; ~540 ft long street
    explanation:
      'Pick 5 houses on this lane, and add up the last 2 digits of all of the houses you selected. If that number exceeds 250, try again.',
  },
  {
    name: 'Sidewalk Modeling (Shattuck Drive)',
    lat: 37.31082,
    lng: -122.05752, // mid-Shattuck
    photo: true,
    explanation:
      "Walk half the length of Shattuck Drive like you're a runway model (no smiling allowed!), and when you're done walking, pose for at least three seconds and take a selfie of yourself.",
  },
  {
    name: 'Go Pole Dancing (Dryden Avenue)',
    lat: 37.30993,
    lng: -122.05855, // mid-Dryden
    explanation:
      'Do some dance moves for fifteen seconds. At least one hand must be touching a light pole or tree trunk at all times. If you ever stop touching the pole, you must restart.',
  },
  {
    name: 'Rock, Paper, Scissors (Santa Teresa x Columbus)',
    lat: 37.30826,
    lng: -122.05671,
    explanation:
      'Play rock, paper, scissors with a friend at the Santa Teresa, Columbus intersection. You must win twice in a row without colluding.',
    collaborative: true,
  },
  {
    name: 'Brick, Wood, and Steel (La Paloma Drive)',
    lat: 37.30701,
    lng: -122.05847, // mid-La Paloma
    photo: true, // honor-system: one photo unlocks Done; instructions ask for three
    explanation:
      'Take a selfie of yourself next to something made of brick, something made of wood, and something made of steel. You must take 3 separate photos.',
  },
  {
    name: 'Spell that name backward (Leavesley Place)',
    lat: 37.31044,
    lng: -122.05753, // Leavesley cul-de-sac
    explanation:
      'Stand in Leavesley Place, and spell the word "Leavesley" backward without looking at a street sign.',
  },
  {
    name: 'Find that License Plate (Wild Card)',
    lat: 37.30950,
    lng: -122.05955, // unused: roam-anywhere task
    anywhere: true,
    explanation:
      'Find a car with a license plate containing the number {RANDOM_DIGIT} and the letter {RANDOM_LETTER}.',
  },
  {
    name: 'Find a lizard! (Wild Card)',
    lat: 37.30950,
    lng: -122.05955,
    anywhere: true,
    explanation: 'This neighborhood is filled with lizards! Spot one!',
  },
  {
    name: 'Find Water! (Wild Card)',
    lat: 37.30950,
    lng: -122.05955,
    anywhere: true,
    explanation: 'Find water in its liquid form anywhere that isn\'t from a human body.',
  },
  {
    name: 'The Color Purple (Wild Card)',
    lat: 37.30950,
    lng: -122.05955,
    anywhere: true,
    explanation: 'Find something purple that isn\'t a flower.',
  },
  {
    name: 'Find a spider web (Wild Card)',
    lat: 37.30950,
    lng: -122.05955,
    anywhere: true,
    explanation:
      "Find a spider web. You don't necessarily need to find a spider on the web.",
  },
];

// Fills task-explanation tokens with fresh random values when a task is dealt.
// Each occurrence is rolled independently, so per player, per game.
function fillTaskTokens(text) {
  return String(text || '')
    .replace(/\{RANDOM_DIGIT\}/g, () => String(1 + Math.floor(Math.random() * 9)))
    .replace(/\{RANDOM_LETTER\}/g, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]);
}

const rooms = {};
const now = () => Date.now();

function feetBetween(a, b) {
  const R = 20902231; // earth radius in feet
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms[code]);
  return code;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freshPos(room, p) {
  if (p.isBot) return !!p.pos; // test bots have no phone; their position is wherever the host put them
  return !!p.pos && now() - p.pos.ts <= room.settings.staleAfter * 1000;
}

function alivePlayers(room) {
  return Object.values(room.players).filter((p) => p.alive);
}
function aliveCrew(room) {
  return alivePlayers(room).filter((p) => p.role === 'crew');
}
function aliveImpostors(room) {
  return alivePlayers(room).filter((p) => p.role === 'impostor');
}

// Tasks are shared by "assignment": when a crewmate dies, copies of their tasks
// go to living crew, but all copies share one assignmentId. Progress counts each
// assignment once, and it's done if ANY holder completed it — so disbursing
// copies never changes the total.
function taskProgress(room) {
  const done = new Set();
  const all = new Set();
  for (const p of Object.values(room.players)) {
    for (const t of p.tasks) {
      if (t.fake) continue;
      all.add(t.assignmentId);
      if (t.done) done.add(t.assignmentId);
    }
  }
  return { done: done.size, total: all.size };
}

// What's actually shown on-screen includes the impostor's fake tasks too, so
// an impostor checking off their fake tasks moves the counter just like a
// real task would — otherwise the counter staying still while everyone
// else's climbs would be a dead giveaway. This is ONLY for display; the crew
// win condition still uses the crew-only taskProgress() above.
function displayedTaskProgress(room) {
  const done = new Set();
  const all = new Set();
  for (const p of Object.values(room.players)) {
    for (const t of p.tasks) {
      all.add(t.assignmentId);
      if (t.done) done.add(t.assignmentId);
    }
  }
  return { done: done.size, total: all.size };
}

function checkWin(room) {
  const { done, total } = taskProgress(room);
  if (total > 0 && done === total) return 'crew';
  const impostors = aliveImpostors(room).length;
  const crew = aliveCrew(room).length;
  if (impostors === 0) return 'crew';
  if (crew <= impostors) return 'impostor';
  return null;
}

function endGame(room, winner, reason) {
  if (room.meetingTimer) clearTimeout(room.meetingTimer);
  room.meetingTimer = null;
  room.meeting = null;
  pauseTimer(room);
  room.phase = 'ended';
  room.winner = winner;
  room.winReason = reason || null;
}

function startMeeting(room, reporter, victimName) {
  if (room.meetingTimer) clearTimeout(room.meetingTimer);
  pauseTimer(room); // the round clock freezes for the whole meeting
  // Any road closure still active also freezes for the meeting — see
  // blockEffectiveEndsAt / doTally for how it resumes afterward.
  for (const b of room.activeBlocks) {
    if (b.pausedRemainingMs == null && b.endsAt > now()) {
      b.pausedRemainingMs = b.endsAt - now();
    }
  }
  room.phase = 'meeting';
  room.meeting = {
    reporterName: reporter.name,
    victimName: victimName || null,
    endsAt: now() + room.settings.votingTime * 1000,
    votes: {},
  };
  room.meetingChat = []; // never carries over from a previous voting session
  room.meetingTimer = setTimeout(() => {
    doTally(room);
    broadcast(room);
  }, room.settings.votingTime * 1000);
}

function doTally(room) {
  if (!room.meeting) return;
  if (room.meetingTimer) clearTimeout(room.meetingTimer);
  room.meetingTimer = null;

  // Anyone alive who never cast a vote (the timer ran out on them) is counted
  // as an automatic skip vote, rather than simply not counting at all.
  for (const p of alivePlayers(room)) {
    if (room.meeting.votes[p.key] === undefined) room.meeting.votes[p.key] = 'skip';
  }

  const counts = { skip: 0 };
  for (const p of alivePlayers(room)) counts[p.key] = 0;
  for (const [voter, target] of Object.entries(room.meeting.votes)) {
    if (counts[target] !== undefined) counts[target]++;
  }

  let best = null;
  let bestCount = 0;
  let tied = false;
  for (const [target, n] of Object.entries(counts)) {
    if (n > bestCount) {
      best = target;
      bestCount = n;
      tied = false;
    } else if (n === bestCount && n > 0) {
      tied = true;
    }
  }

  const namedCounts = {};
  for (const [target, n] of Object.entries(counts)) {
    if (n === 0) continue;
    namedCounts[target === 'skip' ? 'Skip' : room.players[target].name] = n;
  }

  let text;
  if (!best || tied || best === 'skip' || bestCount === 0) {
    text = 'Nobody was ejected.';
  } else {
    const ejected = room.players[best];
    ejected.alive = false;
    ejected.ejected = true;
    text = `${ejected.name} was ejected.`;
  }
  room.lastVote = { text, counts: namedCounts, at: now() };
  room.meeting = null;

  const winner = checkWin(room);
  if (winner) {
    endGame(room, winner);
    return;
  }
  room.phase = 'playing';
  // Round clock resumes now that the meeting is over — unless the host has it
  // manually held, in which case it stays paused until they release it.
  if (!room.timerHeld) resumeTimer(room);
  // Any road closure that was frozen for the meeting picks back up with
  // however much time it had left.
  for (const b of room.activeBlocks) {
    if (b.pausedRemainingMs != null) {
      b.endsAt = now() + b.pausedRemainingMs;
      b.pausedRemainingMs = null;
    }
  }
  // Fresh kill cooldown after every meeting, like the real game.
  for (const p of Object.values(room.players)) {
    if (p.role === 'impostor') p.cooldownUntil = now() + room.settings.killCooldown * 1000;
  }
}

// Core game actions, shared by real players (socket handlers) and host-driven
// test bots. Return an error string, or null on success.
function tryKill(room, actor, targetKey) {
  if (room.phase !== 'playing' || actor.role !== 'impostor' || !actor.alive) return 'You cannot kill right now.';
  if (now() < (actor.cooldownUntil || 0)) return 'Kill is still on cooldown.';
  if (!freshPos(room, actor)) return 'Your GPS signal dropped — wait for it to come back.';
  let target = targetKey ? room.players[targetKey] : null;
  if (!target) {
    // no explicit target: nearest eligible victim (used by test bots)
    let bestD = Infinity;
    for (const q of alivePlayers(room)) {
      if (q.role === 'impostor' || !freshPos(room, q)) continue;
      const d = feetBetween(actor.pos, q.pos);
      if (d < bestD) { target = q; bestD = d; }
    }
  }
  if (!target || !target.alive || target.role === 'impostor') return 'No one there to kill.';
  if (!freshPos(room, target)) return "Their phone isn't reporting a live position right now.";
  if (feetBetween(actor.pos, target.pos) > room.settings.killRange) return 'They slipped out of range.';

  target.alive = false;
  target.deathAt = now();
  // Ghost role is assigned instantly on death (the client only reveals it
  // after the victim dismisses the kill screen — see the kill-modal-ok
  // handler in app.js), but the ability to actually send a hint only
  // unlocks once their body is found (see tryGhostHint). Skipped entirely
  // if the host has turned the whole Troll/Helper package off.
  if (room.settings.ghostRolesEnabled) {
    target.ghostRole = Math.random() < 0.5 ? 'troll' : 'helper';
  }
  // No body is pinned to the map. The victim physically stays put, and reports
  // key off their phone's live position instead of a frozen (GPS-inaccurate) spot.
  disburseTasks(room, target); // hand copies of their tasks to living crew
  actor.cooldownUntil = now() + room.settings.killCooldown * 1000;
  const winner = checkWin(room);
  if (winner) endGame(room, winner);
  return null;
}

// A killed-but-not-yet-found player is reportable. (Ejected players have no
// body to find; already-found players can't be reported twice.)
function isReportable(room, q, actor) {
  return !q.alive && !q.foundDead && !q.ejected && q.key !== actor.key;
}

function tryReport(room, actor, bodyKey) {
  if (room.phase !== 'playing' || !actor.alive) return 'You cannot report right now.';
  if (!freshPos(room, actor)) return 'Your GPS signal dropped — wait for it to come back.';
  let target = bodyKey ? room.players[bodyKey] : null;
  if (target && !isReportable(room, target, actor)) target = null;
  if (!target) {
    let bestD = Infinity;
    for (const q of Object.values(room.players)) {
      if (!isReportable(room, q, actor) || !freshPos(room, q)) continue;
      const d = feetBetween(actor.pos, q.pos);
      if (d < bestD) { target = q; bestD = d; }
    }
  }
  if (!target) return 'No body nearby.';
  if (!freshPos(room, target)) return "That player's phone isn't reporting a position right now.";
  if (feetBetween(actor.pos, target.pos) > room.settings.killRange) return 'Get a little closer to the body.';

  target.foundDead = true; // now publicly dead; can't be reported again
  startMeeting(room, actor, target.name);
  return null;
}

// Troll/Helper ghost hint: the only "chat" a ghost has, and it's deliberately
// not free text — the message is always the fixed phrase below with just a
// location the player fills in, so a ghost can never type a player's name or
// role. Sent to exactly one living player at a time (a private DM, not a
// broadcast), only unlocks once the ghost's body is actually found, and is
// rate-limited per player.
function tryGhostHint(room, actor, location, targetKey) {
  if (!room.settings.ghostRolesEnabled) return 'Ghost hints are turned off for this game.';
  if (room.phase !== 'playing' && room.phase !== 'meeting') return 'Not right now.';
  if (actor.alive || !actor.foundDead) return 'You can only send a ghost hint once your body has been found.';
  if (now() < (actor.ghostChatCooldownUntil || 0)) return 'You need to wait before sending another hint.';
  const target = room.players[targetKey];
  if (!target || !target.alive) return 'Pick a living player to send it to.';
  const clean = String(location || '').trim().slice(0, 60);
  if (!clean) return 'Enter a location for the hint.';
  actor.ghostChatCooldownUntil = now() + room.settings.ghostChatCooldown * 1000;
  room.ghostMessages.push({
    id: room.nextGhostMessageId++,
    senderName: actor.name,
    recipientKey: target.key,
    location: clean,
    ts: now(),
  });
  room.ghostMessages = room.ghostMessages.slice(-40); // bounded log, oldest fall off
  return null;
}

// Backup text chat for the living during a meeting, in case the voice call
// drops — plain free text (unlike the ghost hint), since it's just a stand-in
// for talking out loud among people who could already hear each other. Wiped
// at the start of every new meeting (see startMeeting) so it never carries
// over between voting sessions.
function tryMeetingChat(room, actor, text) {
  if (room.phase !== 'meeting') return 'Chat is only available during a meeting.';
  if (!actor.alive) return 'Only living players can use this chat.';
  const clean = String(text || '').trim().slice(0, 200);
  if (!clean) return 'Type something first.';
  room.meetingChat.push({
    id: room.nextMeetingChatId++,
    senderName: actor.name,
    text: clean,
    ts: now(),
  });
  room.meetingChat = room.meetingChat.slice(-100);
  return null;
}

function tryTask(room, actor, assignmentId) {
  if (room.phase !== 'playing' && room.phase !== 'meeting') return 'Not right now.';
  if (!actor.alive && !actor.ejected && !actor.foundDead) return "You haven't been found yet — stay put.";
  const t = assignmentId
    ? actor.tasks.find((x) => x.assignmentId === assignmentId && !x.done)
    : actor.tasks.find((x) => !x.done);
  if (!t) return 'No unfinished tasks.';
  // Completing one holder's copy completes every copy of the same assignment.
  for (const p of Object.values(room.players)) {
    for (const x of p.tasks) {
      if (x.assignmentId === t.assignmentId) x.done = true;
    }
  }
  if (!t.fake) {
    const winner = checkWin(room);
    if (winner) endGame(room, winner);
  }
  return null;
}

// Undo a task completion. Uncompleting can never trigger a win (only
// completing can), so there's no checkWin here — just the mirror image of
// tryTask's "mark every copy of this assignment" logic.
function tryUntask(room, actor, assignmentId) {
  if (room.phase !== 'playing' && room.phase !== 'meeting') return 'Not right now.';
  const t = actor.tasks.find((x) => x.assignmentId === assignmentId && x.done);
  if (!t) return 'That task is not marked done.';
  for (const p of Object.values(room.players)) {
    for (const x of p.tasks) {
      if (x.assignmentId === t.assignmentId) x.done = false;
    }
  }
  return null;
}

function tryVote(room, actor, target) {
  if (room.phase !== 'meeting' || !room.meeting) return 'No meeting in progress.';
  if (!actor.alive) return 'Dead players cannot vote.';
  if (room.meeting.votes[actor.key] !== undefined) return 'Vote already cast.';
  const valid = target === 'skip' || (room.players[target] && room.players[target].alive);
  if (!valid) return 'Invalid vote.';
  room.meeting.votes[actor.key] = target;
  if (Object.keys(room.meeting.votes).length >= alivePlayers(room).length) {
    doTally(room);
  }
  return null;
}

// Every player (impostor included) gets exactly one emergency-meeting call for
// the whole game. Once used, the button is gone from their screen for good.
function tryCallVote(room, actor) {
  if (room.phase !== 'playing') return 'You can only call a meeting during play.';
  if (!actor.alive) return 'You must be alive to call a meeting.';
  if (actor.calledMeeting) return 'You already used your one emergency meeting this game.';
  // If the host hasn't set any meeting-call spots, calling stays unrestricted
  // (old behavior) instead of silently becoming impossible.
  if (room.meetingLocations.length > 0) {
    if (!actor.pos) return 'You need a GPS fix to call a meeting.';
    const nearSpot = room.meetingLocations.some((m) => feetBetween(actor.pos, m) <= room.settings.meetingCallRange);
    if (!nearSpot) return 'You must be near a designated meeting-call spot to do that.';
  }
  actor.calledMeeting = true;
  startMeeting(room, actor, null);
  return null;
}

// Crewmates (never the impostor) get exactly one "See Location" use per game,
// only while alive. It reveals half (rounded up) of the other living players —
// impostor included, without labeling them as such — frozen at their position
// the instant the power is used, visible to the caller alone for 20 seconds.
function trySeeLocation(room, actor) {
  if (room.phase !== 'playing') return 'Not right now.';
  if (!actor.alive) return 'You must be alive to do that.';
  if (actor.role === 'impostor') return 'Not available to the impostor.';
  if (actor.usedSeeLocation) return 'You already used your one See Location power this game.';
  const others = alivePlayers(room).filter((q) => q.key !== actor.key);
  const withPos = others.filter((q) => q.pos);
  // Never burn the one-time power on an empty reveal (e.g. test bots that were
  // never placed on the map). Refuse and leave the power unused.
  if (!withPos.length) return "No player locations are known right now — your power wasn't used.";
  actor.usedSeeLocation = true;
  const count = Math.ceil(others.length / 2);
  const chosen = shuffled(withPos).slice(0, Math.min(count, withPos.length));
  actor.seeLocationReveal = {
    until: now() + 20000,
    players: chosen.map((q) => ({ key: q.key, name: q.name, lat: q.pos.lat, lng: q.pos.lng })),
  };
  return null;
}

// How long an active block has left, honoring a meeting-freeze: while a
// meeting is in progress, a block's remaining time is captured once (see
// startMeeting) and this keeps recomputing an endsAt that drifts forward in
// lockstep with real time, so the countdown appears frozen to every client
// without needing to touch them again until the meeting actually ends (see
// doTally, which converts pausedRemainingMs back into a real endsAt).
function blockEffectiveEndsAt(room, b) {
  return b.pausedRemainingMs != null ? now() + b.pausedRemainingMs : b.endsAt;
}

// Impostor-only, repeatable: closes off a host-drawn street section for
// blockDuration seconds, then locks the SAME impostor out of THAT section
// (not the ability itself, and not other impostors) for the rest of the
// game — tracked in actor.usedSegments. The reuse cooldown runs on wall-clock
// time same as kill (a meeting never pauses it), but the ACTIVE closure
// itself does freeze for the duration of any meeting — see
// blockEffectiveEndsAt. Purely a visual/social signal to everyone (there's no
// way to actually block a real road), enforced by the red map highlight and
// a big alert, not by game logic.
function tryBlockLocation(room, actor, segmentId) {
  if (room.phase !== 'playing') return 'Not right now.';
  if (actor.role !== 'impostor') return 'Not available to crew.';
  if (!actor.alive) return 'You must be alive to do that.';
  if (now() < (actor.blockCooldownUntil || 0)) return 'Block Location is still on cooldown.';
  const segment = room.streetSegments.find((s) => s.id === segmentId);
  if (!segment) return 'That street section no longer exists.';
  if ((actor.usedSegments || []).includes(segmentId)) return "You've already blocked that section this game.";
  const s = room.settings;
  actor.usedSegments = [...(actor.usedSegments || []), segmentId];
  actor.blockCooldownUntil = now() + (s.blockDuration + s.blockCooldown) * 1000;
  room.activeBlocks = room.activeBlocks.filter((b) => blockEffectiveEndsAt(room, b) > now());
  room.activeBlocks.push({
    id: room.nextBlockId++,
    segmentId: segment.id,
    name: segment.name,
    points: segment.points.map((p) => ({ ...p })),
    endsAt: now() + s.blockDuration * 1000,
    pausedRemainingMs: null, // set while a meeting freezes this block's countdown
  });
  return null;
}

// On death, immediately hand a COPY of each of the dead player's real,
// unfinished tasks to a living crewmate (never the impostor). The dead player
// keeps their own copy, so either of them completing it finishes the task.
// Recipients are chosen at random but balanced: a player only gets a second
// task from this dead player once every other living crewmate has one from them.
function disburseTasks(room, dead) {
  dead.disbursedTo = dead.disbursedTo || {}; // recipientKey -> count from this dead player
  for (const t of dead.tasks) {
    if (t.fake || t.done) continue;
    // living crew who don't already hold this exact assignment (a copy of
    // this exact dead player's task) — a redisbursed task (see below) can
    // die again and hop to a third player, since the dead player who's
    // holding it is excluded from aliveCrew() automatically.
    const assignmentHolders = new Set();
    // Players who already have this same original task (by taskId) from a
    // *different* assignment — e.g. two players independently dealt the same
    // collaborative task at game start. Best-effort avoided below, but not at
    // the cost of leaving nobody to disburse to.
    const taskIdHolders = new Set();
    for (const p of Object.values(room.players)) {
      for (const x of p.tasks) {
        if (x.assignmentId === t.assignmentId) assignmentHolders.add(p.key);
        if (x.taskId === t.taskId) taskIdHolders.add(p.key);
      }
    }
    let cands = aliveCrew(room).filter((p) => !assignmentHolders.has(p.key));
    if (!cands.length) continue;
    const preferred = cands.filter((p) => !taskIdHolders.has(p.key));
    if (preferred.length) cands = preferred;
    const minCount = Math.min(...cands.map((p) => dead.disbursedTo[p.key] || 0));
    cands = cands.filter((p) => (dead.disbursedTo[p.key] || 0) === minCount);
    const recipient = cands[Math.floor(Math.random() * cands.length)];
    dead.disbursedTo[recipient.key] = (dead.disbursedTo[recipient.key] || 0) + 1;
    recipient.tasks.push({ ...t, done: false, shared: true });
  }
}

function viewFor(room, p) {
  const s = room.settings;
  const publiclyDead = (q) => !q.alive && (q.foundDead || q.ejected);
  const inLobby = room.phase === 'lobby';

  const view = {
    code: room.code,
    phase: room.phase,
    settings: s,
    maxPlayers: MAX_PLAYERS,
    isHost: p.key === room.hostKey,
    winner: room.winner,
    winReason: room.winReason || null,
    lastVote: room.lastVote || null,
    taskProgress: displayedTaskProgress(room),
    tasks: room.tasks,
    area: room.area,
    streetSegments: room.streetSegments,
    meetingLocations: room.meetingLocations,
    // Backup text chat for the living during a meeting (voice-call fallback).
    // Visible to everyone present (dead players can watch, like the vote
    // list), but only living players can actually send to it — see
    // tryMeetingChat. Wiped at the start of every new meeting.
    meetingChat: room.phase === 'meeting' ? room.meetingChat : [],
    // Public to everyone — a block is a visible, announced event, same as a
    // body being found. Never includes who placed it (that stays server-side
    // only, in each player's own usedSegments, so it can't out the impostor).
    activeBlocks: room.activeBlocks
      .filter((b) => blockEffectiveEndsAt(room, b) > now())
      .map((b) => ({ id: b.id, name: b.name, points: b.points, endsAt: blockEffectiveEndsAt(room, b) })),
    autoScale: !!room.autoScale,
    roundSecondsLeft: Math.ceil(timerRemainingMs(room) / 1000),
    roundPaused: room.phase === 'meeting' || !!room.timerHeld,
    roundHeld: !!room.timerHeld, // specifically a host-controlled pause/hold (vs. just a meeting freeze)
    players: Object.values(room.players).map((q) => ({
      key: q.key,
      name: q.name,
      connected: q.connected,
      isHost: q.key === room.hostKey,
      isBot: !!q.isBot,
      dead: publiclyDead(q),
      voted: room.meeting ? room.meeting.votes[q.key] !== undefined : false,
    })),
    you: {
      key: p.key,
      name: p.name,
      role: inLobby ? null : p.role,
      alive: p.alive,
      ejected: p.ejected,
      foundDead: p.foundDead,
      tasks: p.tasks,
      cooldownUntil: p.cooldownUntil || 0,
      gpsFresh: freshPos(room, p),
      calledMeeting: !!p.calledMeeting,
      usedSeeLocation: !!p.usedSeeLocation,
      blockCooldownUntil: p.blockCooldownUntil || 0,
      usedSegments: p.usedSegments || [],
      // Private to this player alone — living players and other ghosts never
      // learn who's Troll vs Helper, only the fixed-format hints they send.
      ghostRole: p.ghostRole || null,
      ghostChatCooldownUntil: p.ghostChatCooldownUntil || 0,
      // Ghost hints are DMs: only the one player a hint was sent to ever sees
      // it, and only on the game screen (never during a meeting).
      ghostInbox: room.ghostMessages.filter((m) => m.recipientKey === p.key),
      // Whether calling an emergency meeting is currently allowed by location.
      // No spots configured at all = unrestricted, so this feature can never
      // silently disable meetings for a room the host hasn't set spots up in.
      nearMeetingLocation: room.meetingLocations.length === 0
        || (room.phase === 'playing' && p.alive && freshPos(room, p)
          && room.meetingLocations.some((m) => feetBetween(p.pos, m) <= s.meetingCallRange)),
    },
    killTargets: [],
    nearbyBodies: [],
  };

  // See Location reveal: private to the caller, and only for the 10 seconds
  // it's valid. Once expired, drop the stored data so it can't be replayed.
  if (p.seeLocationReveal) {
    if (now() < p.seeLocationReveal.until) {
      view.you.seeLocationReveal = {
        until: p.seeLocationReveal.until,
        players: p.seeLocationReveal.players,
      };
    } else {
      p.seeLocationReveal = null;
    }
  }

  if (!inLobby && p.role === 'impostor') {
    view.fellowImpostors = Object.values(room.players)
      .filter((q) => q.role === 'impostor' && q.key !== p.key)
      .map((q) => q.name);
    // Targets show whenever someone is in range; the client decides whether the
    // kill button is active or still cooling down, so nothing appears unless the
    // impostor is actually near a victim.
    if (room.phase === 'playing' && p.alive && freshPos(room, p)) {
      view.killTargets = alivePlayers(room)
        .filter((q) => q.role !== 'impostor' && freshPos(room, q) && feetBetween(p.pos, q.pos) <= s.killRange)
        .map((q) => ({ key: q.key, name: q.name }));
    }
  }

  if (room.phase === 'playing' && p.alive && freshPos(room, p)) {
    view.nearbyBodies = Object.values(room.players)
      .filter((q) => isReportable(room, q, p) && freshPos(room, q) && feetBetween(p.pos, q.pos) <= s.killRange)
      .map((q) => ({ key: q.key, name: q.name }));
  }

  // The host sees and drives test bots. Roles are exposed on purpose:
  // bots exist for solo testing, not for real games.
  if (p.key === room.hostKey) {
    const bots = Object.values(room.players).filter((q) => q.isBot);
    if (bots.length) {
      view.bots = bots.map((b) => ({
        key: b.key,
        name: b.name,
        role: inLobby ? null : b.role,
        alive: b.alive,
        ejected: b.ejected,
        foundDead: b.foundDead,
        pos: b.pos ? { lat: b.pos.lat, lng: b.pos.lng } : null,
        tasksLeft: b.tasks.filter((t) => !t.done).length,
        cooldownUntil: b.cooldownUntil || 0,
        calledMeeting: !!b.calledMeeting,
        usedSeeLocation: !!b.usedSeeLocation,
        blockCooldownUntil: b.blockCooldownUntil || 0,
        usedSegments: b.usedSegments || [],
      }));
    }
  }

  if (room.meeting) {
    view.meeting = {
      reporterName: room.meeting.reporterName,
      victimName: room.meeting.victimName,
      endsAt: room.meeting.endsAt,
      yourVote: room.meeting.votes[p.key] !== undefined ? room.meeting.votes[p.key] : null,
      candidates: alivePlayers(room).map((q) => ({ key: q.key, name: q.name })),
    };
  }

  return view;
}

function broadcast(room) {
  for (const p of Object.values(room.players)) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('state', viewFor(room, p));
    }
  }
}

function makePlayer(key, name, socketId) {
  return {
    key,
    name,
    socketId,
    isBot: false,
    connected: true,
    role: null,
    alive: true,
    ejected: false,
    foundDead: false,
    deathAt: null,
    disbursedTo: {},
    pos: null,
    tasks: [],
    cooldownUntil: 0,
    calledMeeting: false,   // each player gets exactly one emergency-meeting call per game
    usedSeeLocation: false, // each crewmate gets exactly one See Location use per game
    seeLocationReveal: null,
    blockCooldownUntil: 0, // impostor-only: wall-clock time Block Location becomes available again
    usedSegments: [],      // impostor-only: street section ids this player has already blocked this game (never reusable)
    ghostRole: null,           // 'troll' or 'helper', assigned the instant this player is killed
    ghostChatCooldownUntil: 0, // wall-clock time this ghost can send another hint
  };
}

io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return {};
    return { room, player: room.players[socket.data.playerKey] };
  };
  const fail = (msg) => socket.emit('errorMsg', msg);

  socket.on('create', ({ name, key }, ack) => {
    name = String(name || '').trim().slice(0, 16);
    if (!name || !key) return ack && ack({ error: 'Enter a name first.' });
    const code = makeCode();
    const room = {
      code,
      hostKey: key,
      settings: { ...DEFAULT_SETTINGS },
      phase: 'lobby',
      tasks: [],
      area: DEFAULT_AREA.map((p) => ({ ...p })),
      players: {},
      meeting: null,
      meetingTimer: null,
      lastVote: null,
      winner: null,
      nextTaskId: 1,
      nextAssignmentId: 1,
      nextSegmentId: 1,
      nextBlockId: 1,
      nextMeetingLocationId: 1,
      nextGhostMessageId: 1,
      nextMeetingChatId: 1,
      streetSegments: [],
      activeBlocks: [],
      meetingLocations: [],
      ghostMessages: [],
      meetingChat: [],
      autoScale: true, // tasksPerPlayer + roundLength track player count until the host edits them
      timeLeftMs: 0,
      timerStartedAt: null,
      timerHeld: false, // host-controlled manual pause/hold, independent of the meeting-freeze
    };
    room.tasks = DEFAULT_TASKS.map((t) => ({
      id: room.nextTaskId++,
      name: t.name,
      lat: t.lat,
      lng: t.lng,
      explanation: t.explanation || '',
      photo: !!t.photo,
      anywhere: !!t.anywhere,
      collaborative: !!t.collaborative,
    }));
    room.streetSegments = DEFAULT_STREET_SEGMENTS.map((s) => ({
      id: room.nextSegmentId++,
      name: s.name,
      points: s.points.map((p) => ({ ...p })),
    }));
    room.meetingLocations = DEFAULT_MEETING_LOCATIONS.map((m) => ({
      id: room.nextMeetingLocationId++,
      name: m.name,
      lat: m.lat,
      lng: m.lng,
    }));
    room.players[key] = makePlayer(key, name, socket.id);
    applyAutoScale(room);
    rooms[code] = room;
    socket.data.roomCode = code;
    socket.data.playerKey = key;
    ack && ack({ code });
    broadcast(room);
  });

  socket.on('join', ({ code, name, key }, ack) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 16);
    const room = rooms[code];
    if (!room) return ack && ack({ error: 'No game with that code.' });
    const existing = room.players[key];
    if (!existing) {
      if (!name) return ack && ack({ error: 'Enter a name first.' });
      if (room.phase !== 'lobby') return ack && ack({ error: 'That game already started.' });
      if (Object.keys(room.players).length >= MAX_PLAYERS)
        return ack && ack({ error: 'That game is full (10 players max).' });
      room.players[key] = makePlayer(key, name, socket.id);
      applyAutoScale(room);
    } else {
      existing.socketId = socket.id;
      existing.connected = true;
      if (name) existing.name = name;
    }
    socket.data.roomCode = code;
    socket.data.playerKey = key;
    ack && ack({ code });
    broadcast(room);
  });

  socket.on('pos', ({ lat, lng }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    player.pos = { lat, lng, ts: now() };
    broadcast(room);
  });

  socket.on('settings', (partial) => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return fail('Settings can only change before the game starts.');
    for (const [k, range] of Object.entries(SETTING_LIMITS)) {
      if (partial[k] === undefined) continue;
      const v = Math.round(Number(partial[k]));
      if (!Number.isFinite(v)) continue;
      room.settings[k] = Math.min(range[1], Math.max(range[0], v));
      // The host touched a player-count-scaled setting by hand — stop auto-adjusting it.
      if (k === 'tasksPerPlayer' || k === 'roundLength') room.autoScale = false;
    }
    if (typeof partial.timerAutoStart === 'boolean') room.settings.timerAutoStart = partial.timerAutoStart;
    if (typeof partial.ghostRolesEnabled === 'boolean') room.settings.ghostRolesEnabled = partial.ghostRolesEnabled;
    broadcast(room);
  });

  socket.on('resetAutoScale', () => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return;
    room.autoScale = true;
    applyAutoScale(room);
    broadcast(room);
  });

  socket.on('setTasks', (tasks) => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return fail('Tasks can only change before the game starts.');
    if (!Array.isArray(tasks)) return;
    room.tasks = tasks.slice(0, 50).map((t) => ({
      id: room.nextTaskId++,
      name: String(t.name || 'Task').trim().slice(0, 40),
      lat: Number(t.lat),
      lng: Number(t.lng),
      explanation: String(t.explanation || '').trim().slice(0, 600),
      photo: !!t.photo,
      anywhere: !!t.anywhere,
      collaborative: !!t.collaborative,
    })).filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng));
    broadcast(room);
  });

  socket.on('setArea', (pts) => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return fail('The play area can only change before the game starts.');
    if (!Array.isArray(pts)) return;
    room.area = pts.slice(0, 100)
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    broadcast(room);
  });

  socket.on('setStreetSegments', (segments) => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return fail('Street sections can only change before the game starts.');
    if (!Array.isArray(segments)) return;
    room.streetSegments = segments.slice(0, 50).map((s) => ({
      id: room.nextSegmentId++,
      name: String(s.name || 'Street section').trim().slice(0, 60),
      points: (Array.isArray(s.points) ? s.points : [])
        .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    })).filter((s) => s.points.length >= 2);
    broadcast(room);
  });

  socket.on('setMeetingLocations', (locations) => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return fail('Meeting call spots can only change before the game starts.');
    if (!Array.isArray(locations)) return;
    room.meetingLocations = locations.slice(0, 50).map((m) => ({
      id: room.nextMeetingLocationId++,
      name: String(m.name || 'Meeting spot').trim().slice(0, 60),
      lat: Number(m.lat),
      lng: Number(m.lng),
    })).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));
    broadcast(room);
  });

  socket.on('start', () => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return;
    const players = Object.values(room.players);
    const s = room.settings;
    if (players.length < s.impostorCount + 1)
      return fail(`Need at least ${s.impostorCount + 1} players.`);
    if (room.tasks.length === 0) return fail('Add at least one task on the map first.');

    const collabPool = room.tasks.filter((t) => t.collaborative);
    const soloPool = room.tasks.filter((t) => !t.collaborative);
    const toTask = (t) => ({
      taskId: t.id,
      assignmentId: 'a' + (room.nextAssignmentId++),
      name: t.name,
      lat: t.lat,
      lng: t.lng,
      explanation: fillTaskTokens(t.explanation),
      photo: !!t.photo,
      anywhere: !!t.anywhere,
      collaborative: !!t.collaborative,
    });

    const order = shuffled(players);
    order.forEach((p, i) => {
      p.role = i < s.impostorCount ? 'impostor' : 'crew';
      p.alive = true;
      p.ejected = false;
      p.foundDead = false;
      p.deathAt = null;
      p.disbursedTo = {};
      p.calledMeeting = false;
      p.usedSeeLocation = false;
      p.seeLocationReveal = null;
      p.blockCooldownUntil = 0;
      p.usedSegments = [];
      p.ghostRole = null;
      p.ghostChatCooldownUntil = 0;
      // Short opening grace instead of a full cooldown: long enough that nobody
      // gets knifed while role cards are still on screen, but the impostor can
      // hunt right away. (After that, kills use the full cooldown as usual.)
      // Runs on wall-clock time — pausing the round timer never touches it.
      p.cooldownUntil = now() + Math.min(15, s.killCooldown) * 1000;

      // Every player gets exactly one collaborative task (drawn independently,
      // so two players may land on the same one and do it together), then the
      // rest of their list is solo tasks.
      const dealt = [];
      if (collabPool.length) dealt.push(collabPool[Math.floor(Math.random() * collabPool.length)]);
      const soloCount = Math.max(0, Math.min(s.tasksPerPlayer, room.tasks.length) - dealt.length);
      dealt.push(...shuffled(soloPool).slice(0, soloCount));

      p.tasks = dealt.map((t) => ({ ...toTask(t), fake: p.role === 'impostor', done: false }));
    });
    // Test bots have no phone feeding the game GPS, so any bot that was never
    // placed gets a starting spot automatically: scattered a few hundred feet
    // around the host (or the middle of the play area), outside kill range.
    // The host can still drag their pins anywhere afterwards.
    const host = room.players[room.hostKey];
    let center = host && host.pos ? host.pos : null;
    if (!center && room.area.length >= 3) {
      center = {
        lat: room.area.reduce((a, p) => a + p.lat, 0) / room.area.length,
        lng: room.area.reduce((a, p) => a + p.lng, 0) / room.area.length,
      };
    }
    if (center) {
      for (const p of Object.values(room.players)) {
        if (!p.isBot || p.pos) continue;
        const ang = Math.random() * Math.PI * 2;
        const ft = 150 + Math.random() * 250;
        p.pos = {
          lat: center.lat + (Math.sin(ang) * ft) / 364000,
          lng: center.lng + (Math.cos(ang) * ft) / 288000,
          ts: now(),
        };
      }
    }

    room.lastVote = null;
    room.winner = null;
    room.activeBlocks = [];
    room.ghostMessages = [];
    room.timeLeftMs = s.roundLength * 1000;
    if (s.timerAutoStart) {
      room.timerStartedAt = now();
      room.timerHeld = false;
    } else {
      // Deal roles/tasks now, but leave the clock held until the host releases
      // it — gives them time to answer questions before time starts running.
      room.timerStartedAt = null;
      room.timerHeld = true;
    }
    room.phase = 'playing';
    broadcast(room);
  });

  socket.on('kill', ({ targetKey }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryKill(room, player, targetKey);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('report', ({ bodyKey }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryReport(room, player, bodyKey);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('ghostHint', ({ location, targetKey }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryGhostHint(room, player, location, targetKey);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('meetingChat', ({ text }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryMeetingChat(room, player, text);
    if (err) return fail(err);
    broadcast(room);
  });

  // Host safety valve: start a vote even when no body has been found.
  // Host-only manual round-clock hold. Independent of the meeting freeze, so
  // the host can pause (or delay the very first start) whenever they want.
  socket.on('holdTimer', () => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'playing' && room.phase !== 'meeting') return;
    room.timerHeld = true;
    pauseTimer(room);
    broadcast(room);
  });

  socket.on('releaseTimer', () => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'playing' && room.phase !== 'meeting') return;
    room.timerHeld = false;
    if (room.phase === 'playing') resumeTimer(room); // if mid-meeting, resumes once the meeting itself ends
    broadcast(room);
  });

  socket.on('callVote', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryCallVote(room, player);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('seeLocation', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = trySeeLocation(room, player);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('blockLocation', ({ segmentId }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryBlockLocation(room, player, segmentId);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('vote', ({ target }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryVote(room, player, target);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('task', ({ assignmentId }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryTask(room, player, assignmentId);
    if (err) return fail(err);
    broadcast(room);
  });

  socket.on('untask', ({ assignmentId }) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    const err = tryUntask(room, player, assignmentId);
    if (err) return fail(err);
    broadcast(room);
  });

  // Host safety valve: end the game right now, no winner declared.
  socket.on('endEarly', () => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'playing' && room.phase !== 'meeting') return;
    endGame(room, null, 'ended_early');
    broadcast(room);
  });

  // ----- solo-testing bots (host-controlled fake players) -----

  socket.on('addBot', () => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return fail('Bots can only be added in the lobby.');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return fail('Room is full.');
    let n = 1;
    while (room.players['bot-' + n]) n++;
    const bot = makePlayer('bot-' + n, 'Bot ' + n, null);
    bot.isBot = true;
    room.players[bot.key] = bot;
    applyAutoScale(room);
    broadcast(room);
  });

  socket.on('removeBot', ({ botKey }) => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'lobby') return fail('Bots can only be removed in the lobby.');
    const bot = room.players[botKey];
    if (!bot || !bot.isBot) return;
    delete room.players[botKey];
    applyAutoScale(room);
    broadcast(room);
  });

  socket.on('botPos', ({ botKey, lat, lng }) => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    const bot = room.players[botKey];
    if (!bot || !bot.isBot) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    bot.pos = { lat, lng, ts: now() };
    broadcast(room);
  });

  socket.on('botAction', ({ botKey, action, target }) => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    const bot = room.players[botKey];
    if (!bot || !bot.isBot) return;
    let err = 'Unknown action.';
    if (action === 'kill') err = tryKill(room, bot, target);
    else if (action === 'report') err = tryReport(room, bot, target);
    else if (action === 'task') err = tryTask(room, bot, target);
    else if (action === 'vote') err = tryVote(room, bot, target);
    else if (action === 'callVote') err = tryCallVote(room, bot);
    else if (action === 'seeLocation') err = trySeeLocation(room, bot);
    else if (action === 'blockLocation') err = tryBlockLocation(room, bot, target);
    if (err) return fail(`${bot.name}: ${err}`);
    broadcast(room);
  });

  socket.on('again', () => {
    const { room, player } = ctx();
    if (!room || !player || player.key !== room.hostKey) return;
    if (room.phase !== 'ended') return;
    room.phase = 'lobby';
    room.winner = null;
    room.winReason = null;
    room.meeting = null;
    room.lastVote = null;
    room.timeLeftMs = 0;
    room.timerStartedAt = null;
    room.timerHeld = false;
    for (const p of Object.values(room.players)) {
      p.role = null;
      p.alive = true;
      p.ejected = false;
      p.foundDead = false;
      p.deathAt = null;
      p.disbursedTo = {};
      p.calledMeeting = false;
      p.usedSeeLocation = false;
      p.seeLocationReveal = null;
      p.tasks = [];
      p.cooldownUntil = 0;
    }
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    if (player.socketId === socket.id) {
      player.connected = false;
      player.socketId = null;
    }
    broadcast(room);
  });
});

// Round clock: ends the game as an impostor win the moment active-play time
// runs out (it doesn't tick during meetings, so this only fires from real
// mid-round play). If the crew had finished all tasks, checkWin would already
// have ended the game as a crew win before this ever sees zero.
setInterval(() => {
  for (const room of Object.values(rooms)) {
    if (room.phase !== 'playing') continue;
    if (timerRemainingMs(room) <= 0) {
      endGame(room, 'impostor', 'timeout');
      broadcast(room);
    }
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`Neighborhood Among Us running on http://localhost:${PORT}`);
});
