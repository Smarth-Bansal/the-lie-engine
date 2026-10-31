# The Lie Engine

A real-time browser game for 3–12 players, based on the INTRAS rulebook. Players share a room code, take turns, compare historical clues, and privately predict the engine's three hidden dials.

## Run locally

Requires Node.js 20 or newer. The server has no third-party runtime dependencies.

```sh
npm start
```

Open `http://localhost:3000`. Create a room, then share the six-character code. The admin can start with one active player; up to twelve can play. Late arrivals can watch as spectators, and each new round rotates the first turn to the next active player.

## Deploy

The repository includes `render.yaml` and `railway.json`. Connect the repository to either Render or Railway; the service runs with `npm start` and listens on the platform-provided `PORT`. The `/health` endpoint is available for health checks. WebSockets use the same host as the web app.

The host's in-memory room state supports the intended single-instance game service. A server restart clears active rooms, so players should finish their game before redeploying. Do not increase the number of instances without adding shared room storage and WebSocket session routing.

## Rule implementation notes

- Version 0 starts with a random state; two setup cards create Versions 1 and 2. The public label is held at the round's starting version.
- Historical clues are generated from the actual stored state for that version. Each player starts with two Version 0 clues and one Version 1 clue.
- At the start of rounds 2–12, each player receives clues from the two versions immediately before the round's current version (the current version itself is excluded).
- A player never receives the same version/dial clue twice. New clues are shown separately from the collapsed archive of clues from earlier rounds; only fresh clues from the current round can be revealed.
- All card changes and interference actions advance the hidden version once. The automatic event resolves after scoring unless a player wins instantly.
- There is no points-to-win threshold: a perfect guess wins immediately; otherwise the highest score wins after the configured round limit (default 6). Admins can tune starting points, reveal reward, verify and interfere costs, Event Card reward, and one- and two-dial prediction rewards. These values can be changed during a game; starting points apply to the next game. A room can be created with a dedicated non-player admin. Admin access can be granted to or removed from participants, transferred, or left empty. Admins see the current hidden engine, private player details, and separate clue, action, and prediction logs. They can remove participants or move active players to spectator status. Spectators can join during a game. The shuffled Event Card deck scales with room size so every player starts with two cards. Playing `Quantum Jump` restores the chosen dial to its position in a previous version selected by the player; the other dials stay as they are. The result is recorded as a new version. Setup and automatic Quantum Jump events choose a dial and previous version at random. `Chaos Shift` chooses uniformly from any of the other three values.
- Scores, private clues, verification answers, action details, and predictions stay server-side except for the owning player and admins. The final dial values are broadcast after the game ends.

## Operational scope

This is ready for a single-process public deployment. It does not use accounts, a database, or durable storage. Room codes are intended for sharing with a table of friends. Anyone with a room code can join an open seat before the game starts or watch as a spectator after it begins.
