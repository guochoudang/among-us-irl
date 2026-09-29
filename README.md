# Neighborhood Among Us

**Among Us, played for real.** Everyone walks around an actual neighborhood with their phone. The phones handle the secret roles, kills, body reports, tasks, meetings, and voting. Your own two feet do the rest.

If you've never played Among Us, start at the top. If you have, skip to [How this version is different](#how-this-version-is-different).

---

## What is Among Us?

*Among Us* is a popular video game about teamwork and lying. A group of players is on a spaceship doing chores together, but **one of them is secretly a traitor**.

- **Crewmates** (most players) try to finish all their chores, called **tasks**, or figure out who the traitor is and vote them out.
- **The Impostor** (usually one player) pretends to be a crewmate, sneaks around **killing** people when nobody's watching, and tries not to get caught.

When someone finds a dead body, everyone gathers for a **meeting**. Players talk about who they saw and where, accuse each other, and **vote** someone off. The Impostor wins if they kill enough people without getting caught. The crew wins by finishing their tasks or voting out the Impostor.

This project turns that into an outdoor game: the "spaceship" is a few real streets, the tasks are silly real-world challenges, and "killing" someone just means getting close enough to them and tapping a button.

---

## What you need

- **Up to 10 players**, each with a smartphone. It's most fun with 5 or more.
- **Location (GPS) turned on**, with the game open in your phone's browser. There's nothing to download.
- **A group voice call** (for example Discord) for meetings, since players will be spread across the neighborhood.
- **One host** who creates the room and sets up the game.
- About **30–45 minutes** per round.

---

## How to play

### 1. Set up
1. The **host** opens the game link and creates a room. They get a **4-letter room code**.
2. Everyone else opens the same link and joins with that code.
3. Everyone joins the same voice call.
4. The host reviews the **settings**, the play area, and the task locations, then taps **Start**.

### 2. Find out your role
Your phone privately shows **CREWMATE** or **IMPOSTOR**. Don't let anyone see your screen. The top bar never shows your role, so a quick glance at your phone won't give you away.

If there are two Impostors, they see each other's names.

### 3. Play

**🧑‍🚀 If you're a Crewmate:**
- Your phone shows a **list of tasks**, each with a pin on the map. Walk there and do the challenge (for example, find a certain kind of leaf or take a silly photo). Then tap **Done**.
- The **task bar** at the top shows the whole crew's progress. When it's full, the crew wins.
- Keep an eye on people. Who was where? Who's hanging back and not doing tasks?

**🔪 If you're the Impostor:**
- You also get a task list, but your tasks are **fake**. Doing them doesn't fill the bar. Do them anyway so you blend in.
- When a crewmate is close to you (about 75 ft by default) and your cooldown is over, a **Kill** button appears. Tap it and they're out.
- You also have **sabotages** (see [Impostor tricks](#impostor-tricks)).

**💀 If you get killed:**
- Your screen tells you you're dead. **Stay exactly where you are and stay quiet.** Don't tell anyone, and mute yourself on the call.
- You're a "body" until a living player walks up to you and **reports** you.
- After your body is found, you can move around again and keep doing your tasks as a ghost.

### 4. Meetings
A meeting starts when someone **reports a body** (walks close to a dead player and taps **Report**) or **calls an emergency meeting** from one of the designated meeting spots.

When a meeting starts:
- Every phone buzzes and switches to the meeting screen.
- Everyone who's alive talks it over on the voice call (there's also a backup text chat on the phone).
- Everyone **votes** on the phone for who they think the Impostor is, or votes to skip. To vote, tap a name, then tap **Confirm vote**. If you don't vote before time runs out, it counts as a skip.
- The player with the most votes is **ejected**. On a tie, or if most people skip, nobody is ejected.
- The game clock pauses during meetings.
- When any meeting starts, every other dead player who hasn't been found yet is released too, so they can move around again.

### 5. How the game ends
**The crew wins if:**
- every real task gets done, **or**
- every Impostor has been voted out.

**The Impostor wins if:**
- there are as many Impostors left as crewmates, **or**
- nobody fixes a Reactor or O2 sabotage in time, **or**
- the round timer runs out (only if the host turned the timer on).

---

## Special abilities

### Crewmate: See Location
Once per game, a living crewmate can take a peek. For 20 seconds you see where **about half of the other players** are on the map, frozen at the moment you used it. The Impostor might be among them, but they aren't labeled.

### Ghosts: Troll or Helper
When you die, you're secretly made a **👼 Helper** or a **😈 Troll** ghost. After your body is found, you can send one living player a short hint in fixed wording, naming a location. Helpers try to help the crew. Trolls can lie. The living player never knows which kind of ghost sent it.

### Impostor tricks
- **Block Location:** close off a street section for 2 minutes. It turns red on everyone's map and nobody is allowed to walk on it.
- **Reactor:** two *different* people must go to two *different* spots and type in a code within 5 minutes, or the Impostor wins.
- **O2:** one person must go to a certain spot and type in a code within 4 minutes, or the Impostor wins.
- **Comms:** blacks out the map for everyone and disables emergency meetings until someone fixes it at its spot. It has no time limit.

Only one sabotage or road block can be active at a time.

---

## How this version is different

If you've played the video game, here's what changes when it's played outdoors:

| Video game | This version |
|---|---|
| Spaceship map | A real neighborhood, drawn on a real map (the host can draw their own area) |
| Bodies lie on the floor | The dead player **physically stays put** until someone finds them |
| Kill when standing next to someone | Kill when your GPS puts you within kill range |
| Mini-game tasks | Real-world challenges: photo tasks, scavenger hunts, and **collaborative tasks** that need a second person |
| Emergency button in the cafeteria | Call a meeting from designated real-world **meeting spots** (5-minute cooldown between calls) |
| Chat | Voice call for talking, plus a backup text chat during meetings |

Some task types to know:
- **Collaborative task:** you need another player to help. Each player gets exactly one.
- **Chain task:** "Task A + Task B". Do A, then walk to B.
- **Wild-card task:** can be done anywhere, for example "find a spider web."
- **Photo task:** take a picture with the in-game camera. Photos aren't saved anywhere.

---

## Host settings

The host can change these in the lobby before the game starts. Distances are in feet.

| Setting | Default | What it means |
|---|---|---|
| Impostors | 1 | Up to 2 |
| Kill cooldown | 120 s | Wait between kills (the first kill only needs a 15 s wait) |
| Kill / report range | 75 ft | How close you need to be to kill or report |
| Task range | 100 ft | Tapping Done from farther away asks "are you sure?" |
| Tasks per player | 4 | 1 collaborative task plus solo tasks |
| Voting time | 150 s | How long meetings last |
| Round timer | Off | If on, the Impostor wins when time runs out |
| Emergency meeting cooldown | 300 s | Wait between emergency meetings |
| Ghost roles (Troll/Helper) | On | Turn off to keep death simple |
| Hand off dead players' tasks | Off | Gives a dead player's tasks to a living crewmate (this tips off the crew that someone died) |
| Sabotage timers / cooldowns | Various | Reactor 5 min, O2 4 min, sabotage cooldown 10 min, Comms cooldown 5 min |

The host can also draw the **play area**, place **tasks**, add **meeting spots**, and mark **street sections** the Impostor can block. The built-in map, tasks, and spots are set up for one specific Cupertino neighborhood. Playing somewhere else means drawing your own.

**Solo testing:** the host can add **test bots** in the lobby to try the game alone before a real game day.

---

## House rules (the honor system)

The app can't check everything, so agree on these before you start:

- **Dead means silent.** Stay where you died, mute yourself, and don't give hints outside the app.
- **Don't fake tasks.** The Done button trusts you.
- **Don't peek at other people's phones.**
- **Keep your phone awake with the game open.** If your screen locks, your GPS stops updating, and you can't kill, be killed, or report until you reopen the game.
- **Stay safe.** Watch for cars, stay inside the play area, and don't go into anyone's yard.

---

## Running it yourself (for the tech-savvy)

It's a small Node.js app: `server.js` runs the game, and `public/` holds the phone web page. The map uses Leaflet and OpenStreetMap.

```bash
npm install
npm start          # serves on http://localhost:3000
```

**Phones need an HTTPS link.** Phone browsers only share GPS with secure (`https://`) pages, so a plain `http://192.168.x.x` address won't work. Two options:

1. **Quick tunnel (good for one game day):**
   ```bash
   brew install cloudflared          # one-time
   cloudflared tunnel --url http://localhost:3000
   ```
   Share the `https://….trycloudflare.com` link it prints. Your computer has to stay on during the game.

2. **Deploy it (permanent link):** this repo includes a `render.yaml` for [Render](https://render.com)'s free tier. Railway or Fly.io work too.

Game state is kept in memory, so restarting the server ends any game in progress.

More detail on the rules and code is in [`PROJECT_SUMMARY.md`](PROJECT_SUMMARY.md).

---

*Fan-made project inspired by [Among Us](https://www.innersloth.com/games/among-us/) by Innersloth. Not affiliated with or endorsed by Innersloth.*
