# Neighborhood Among Us

In-person Among Us played across a real neighborhood. Everyone opens a link on
their phone, joins a room with a 4-letter code, and the app handles roles,
proximity kills, body reports, tasks, voting, and win conditions. Voice chat
(discussion during meetings) happens on Discord, which keeps running in the
background while the game stays on screen.

## Run it

```bash
npm install
npm start          # serves on http://localhost:3000
```

## Getting it onto phones (important: HTTPS)

Phone browsers **only share GPS with HTTPS pages** (plain `http://192.168.x.x`
links will not work). Two easy options:

1. **Quick tunnel (best for a game day).** In a second terminal:
   ```bash
   brew install cloudflared          # one-time
   cloudflared tunnel --url http://localhost:3000
   ```
   It prints a `https://something.trycloudflare.com` link — everyone opens that
   link on their phone. Your laptop must stay on and online during the game.

2. **Deploy it (permanent link).** Push this folder to GitHub and deploy on a
   free Node host (Render, Railway, Fly.io). They give you an HTTPS URL
   automatically. Note: game state is in memory, so a server restart wipes a
   game in progress.

## How a game runs

1. **Host** creates the game, gets a room code, and on the lobby screen:
   - adjusts settings (all live-editable until start),
   - taps the map to place each task (name + location).
2. **Everyone else** joins with the code. Everyone joins one Discord voice call.
3. Host taps **Start**. Each phone privately shows CREWMATE or IMPOSTOR.
   Crewmates get real tasks drawn from the pool; impostors get fake ones from
   the same pool (their check-offs don't advance the crew's progress bar).
4. **Kills**: the impostor's kill button lights up only when a live-GPS
   crewmate is within kill range and the cooldown is up.
5. **Bodies**: a kill drops an invisible body at the victim's spot. Any living
   player who walks within range gets a report button. Reporting starts a
   meeting: talk on Discord, vote on the phone before the timer ends. Ties and
   skips eject nobody.
6. **Dead players** stay where they died, silent and muted on Discord.
   - If their body is reported, they're "found" and may finish their tasks.
   - If nobody finds them before the hand-off timer (default 3 min), they can
     hand their unfinished tasks to the remaining crew.
   - Ejected players keep doing tasks immediately.
7. **Game ends** automatically: crew wins when every real task is done or the
   impostor is ejected; the impostor wins when only one crewmate is left.

## Settings (host, pre-game)

| Setting | Default | Meaning |
|---|---|---|
| Kill cooldown | 60 s | Wait between impostor kills |
| Kill / report range | 75 ft | Distance for kills and body reports |
| Task check-off range | 100 ft | Farther away, the app asks "did you really?" |
| Impostors | 1 | Up to 2 (they see each other's names) |
| Voting time | 120 s | Meeting vote window |
| Tasks per player | 3 | Real tasks per crewmate, fakes per impostor |
| Dead task hand-off wait | 180 s | Unfound-dead timer before disbursing tasks |
| GPS offline after | 15 s | No ping for this long = phone can't kill / be killed / report |

Max 10 players per room.

## House rules the app can't enforce

- Dead players mute themselves on Discord and don't spectate out loud.
- The task confirmation popup is honor-system by design.
- Keep phones unlocked-ish: the app requests a screen wake lock, but if someone
  locks their phone, their GPS goes stale until they reopen it.
