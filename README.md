# The Lie Engine

A real-time browser game for 3–6 players, based on the INTRAS rulebook. Players share a room code, take turns, compare historical clues, and privately predict the engine's three hidden dials.

## Run locally

Requires Node.js 20 or newer. The server has no third-party runtime dependencies.

```sh
npm start
```

Open `http://localhost:3000`. Create a room, then share the six-character code. Three players are required before the host can start; six can join.

## Deploy

The repository includes `render.yaml` and `railway.json`. Connect the repository to either Render or Railway; the service runs with `npm start` and listens on the platform-provided `PORT`. The `/health` endpoint is available for health checks. WebSockets use the same host as the web app.

The host's in-memory room state supports the intended single-instance game service. A server restart clears active rooms, so players should finish their game before redeploying. Do not increase the number of instances without adding shared room storage and WebSocket session routing.

## Rule implementation notes

- Version 0 starts with a random state; two setup cards create Versions 1 and 2. The public label is held at the round's starting version.
- Historical clues are generated from the actual stored state for that version. Each player starts with two Version 0 clues and one Version 1 clue.
- At the start of rounds 2–6, each player receives clues for the two most recent existing versions.
- All card changes and interference actions advance the hidden version once. The automatic event resolves after scoring unless a player wins instantly.
- The 24-card deck uses three copies of the eight printed card types. `Quantum Jump` is defined here as a randomly chosen one-step shift forward or backward, while `Chaos Shift` chooses uniformly from any of the other three values. Both always change the target dial.
- Scores, clues, verification answers, the engine state, and locked predictions are held on the server; the engine state and card identities are never sent to clients.

## Operational scope

This is ready for a single-process public deployment. It does not use accounts, a database, moderation tools, or durable storage. Room codes are intended for sharing with a table of friends. Anyone with a code can join an open seat before the host starts the game.
