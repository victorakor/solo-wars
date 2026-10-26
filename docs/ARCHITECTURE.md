# Architecture

## Layout

- `packages/shared`: the deterministic game rules and the pure netcode. Runs on both client and server.
  - `sim/`: movement, weapons, hitscan, damage, pickups, bots, `CombatSim`.
  - `net/`: codec, clock sync, prediction, interpolation, `NetClient`, link simulator.
- `apps/server`: Colyseus. `net/matchCore.ts` is the authoritative match (no framework, no sockets);
  `rooms/MatchRoom.ts` is a thin adapter.
- `apps/client`: Three.js renderer, HUD, input, and the Colyseus connection (`net/connection.ts`).

## Authority model (Phase 3)

Clients send **inputs only**. The server owns everything that matters: positions, health, ammo, hits, pickups, kills.

```
client (60 Hz)                         server (60 Hz)
 sample input
 quantise ──► predict (shared sim)
 batch last 4 inputs, 30 Hz ─────────► queue per player (cap 12)
                                        each tick: process queued inputs, 1 per tick plus catch-up credits (cap 8)
                                          CombatSim.stepActor(...)  same code as the client's prediction
                                          fire: targets rewound to the shooter's render time (<= 250 ms)
                                        record hitbox history (1 s ring)
 ◄──────────────────────────────────── snapshot 20 Hz: ack + own full state + other players (quantised)
 reconcile: reset to server state at `ack`, replay unacknowledged inputs, glide the visual error away (snap if >= 1.5 m)
 interpolate other players 100 ms behind the server clock
 ◄──────────────────────────────────── events (reliable): hits, damage, kills, pickups, pad state, match state
```

Why this is fair at 150 ms: what you aim at is what you see, i.e. the other player 100 ms (interpolation) plus
about half your round trip in the past. Each input carries that moment; the server rewinds the target to it and
judges the shot there. Rewinding is limited to 250 ms so a high-latency player cannot shoot around corners
indefinitely.

### Server input handling

- One input per player per tick, plus catch-up from saved credits after a lag spike. Total simulated time can never
  exceed real time, so sending extra inputs cannot speed a player up (tested).
- A starved player simply stalls; the server never invents inputs, so the client's replay stays exact.
- Per-client message budget (80/s, 4 pings/s); a relentless flood gets the client kicked. Every decoder is bounds
  checked and every JSON message is validated with zod, so malformed input is counted and ignored, never fatal.
- Silence for 3 s counts as a lost connection. The match pauses for up to 30 s waiting for the player (Colyseus
  reconnection token), then they forfeit. Traffic on a connection written off as lost counts as a reconnect.

### The client mirror

`NetClient` keeps a `CombatSim` with `authority = false`. The local player is stepped by the same shared code the
server runs (movement, weapon timers, ammo, recoil, shot rays for effects) but nothing is damaged or killed locally.
Other players are overwritten each frame from interpolated snapshots, and pickups follow server events. The renderer
and HUD read this mirror exactly as they read a local match, which is why `game.ts` works on either through a small
`Session` interface.

### Known limits

- 2 humans and 2 bots per room (bandwidth).
- The match lifecycle (countdown, timer, winner, rematch) is Phase 6; Phase 3 has live, paused and forfeit only.
- A bot-free duel needs both players to join before it goes live; the first player waits.
- Colyseus reliability is TCP, so real packet loss shows up as delay spikes rather than missing packets. The
  simulator reproduces both so the design is tested against the worst case.
