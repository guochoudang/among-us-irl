# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A phone-browser (no app store) version of Among Us played in person around a real
neighborhood. Everyone opens a link on their phone, joins a room with a 4-letter
code, and the server handles roles, GPS-proximity kills, body reports, tasks,
voting, and win conditions. Voice discussion during meetings happens on Discord
(outside this app, running in the background).

Read `PROJECT_SUMMARY.md` first in any new session — it is the authoritative,
up-to-date log of exact game rules, UI/privacy behavior, and open items,
maintained across sessions. This CLAUDE.md covers commands and architecture;
PROJECT_SUMMARY.md covers game-design detail and history. Keep PROJECT_SUMMARY.md
updated as behavior changes.

The user (Maximilian) has no coding background — explain things in plain,
on-screen terms, no jargon.

## Commands

```bash
npm install
npm start          # runs server.js, serves on http://localhost:3000
```

There is no build step, bundler, linter, or test framework wired into `package.json`
— this is plain Node + vanilla JS/HTML/CSS served directly. `socket.io-client` is a
devDependency used only for ad hoc test scripts (see Testing below), not an npm
test script.

Phones only share GPS over HTTPS. For real device testing, tunnel the local
server (`cloudflared tunnel --url http://localhost:3000`) — see README.md for
full instructions. `.claude/launch.json` runs `npm start` for the preview tool.

### Testing

There is no formal test suite. The established pattern (see PROJECT_SUMMARY.md
"Testing approach") is:

1. Spin up a second server instance on a separate port with `TEST_MODE=1` set,
   e.g.: `PORT=3123 TEST_MODE=1 node server.js`. `TEST_MODE` lowers the
   `votingTime` and `roundLength` minimums (see `SETTING_LIMITS` in server.js)
   so scripts don't have to wait out real 30s/120s floors. It has zero effect
   under plain `npm start`.
2. Write a throwaway Node script using `socket.io-client` to connect as
   multiple simulated players against that instance and assert on the `state`
   events it receives. Put these scripts in the scratchpad dir, not the repo.
3. Separately, do a visual pass driving the real browser client (e.g. via the
   Claude Code preview tool) against the normal `npm start` instance on 3000.

Use both: the socket script checks exact state transitions, the browser pass
checks that the UI actually reflects them.

## Architecture

Three files, no framework:

- `server.js` — Express + Socket.IO backend. Single source of truth for all
  game state, held in memory (`rooms` object keyed by 4-letter room code; state
  is lost on server restart). Every player action is a socket event handled
  here (`create`, `join`, `pos`, `start`, `kill`, `report`, `vote`, `task`,
  `seeLocation`, `addBot`/`botAction` for host test bots, etc. — see the
  `socket.on(...)` list starting around line 800).
- `public/app.js` — the entire frontend: a single vanilla-JS file with no
  build step. Renders whichever screen (`lobby` / `playing` / `meeting` /
  `ended`) the server says the room is in, using Leaflet + OpenStreetMap tiles
  for the map. Reads the player's device GPS and streams it to the server via
  the `pos` socket event.
- `public/index.html`, `public/style.css` — markup/styling shell for app.js.

**Server-authoritative, per-player filtered view.** The client never computes
game logic (roles, win conditions, kill eligibility, meeting tallies) — it only
renders whatever `server.js`'s `viewFor(room, player)` (server.js:656) decides
that specific player is allowed to see, and pushes it over the `state` socket
event via `broadcast()` (server.js:770). This is the key mechanic for keeping
the game honest on shared/visible phones: e.g. `viewFor` strips role labels for
crewmates, only exposes `killTargets`/`fellowImpostors` to the impostor's own
socket, only reveals bot debug info to the host, and expires `seeLocationReveal`
server-side. When adding a feature, decide what each role is allowed to know
*in `viewFor`*, not in the client.

**Room/player state shape.** A room holds `settings` (host-adjustable, see
`DEFAULT_SETTINGS` / `SETTING_LIMITS` near the top of server.js), `area`
(polygon boundary), `tasks` (pool used to deal real/fake tasks), `players`
keyed by a persistent per-device `key` (not `socketId`, so a phone can
reconnect/rejoin without losing its identity — see `localStorage`-based `auKey`
in app.js), and phase-specific state (`meeting`, timers, `winner`).

**Timers run on wall-clock time**, independent of the round countdown — kill
cooldowns and report state are computed from real timestamps
(`pauseTimer`/`resumeTimer`/`timerRemainingMs`, server.js:69-90), so pausing the
round clock for a meeting never pauses a cooldown. Round countdown auto-pauses
during meetings and can also be manually held by the host (`holdTimer` /
`releaseTimer` events) independent of that.

**Distances are feet, times are seconds**, throughout both server and client;
`feetBetween()` (server.js:300) is the one distance calculation, used for kill
range, report range, task-check range, and see-location.

**Solo-testing test bots.** The host can add up to `MAX_PLAYERS` fake players
("test bots") that count as real players for role/task dealing, driven from a
host-only panel (`renderTestPanel` in app.js) via `botPos`/`botAction` socket
events. This lets one person manually exercise a full game. Bot state/role is
only ever included in `viewFor` when `p.key === room.hostKey` — never sent to
other players or exposed in real games.

## Editing `DEFAULT_AREA` / `DEFAULT_TASKS`

These two constants in server.js (~line 92 and ~131) are the neighborhood
polygon and the hardcoded task pool for the current deployment. They're a
concrete configuration, not generic app logic — the host can also draw a
custom area or add tasks per-room from the lobby UI regardless of these
defaults. See PROJECT_SUMMARY.md for what the current map/tasks represent
before changing them.
