# Arena Duel

```
pnpm install
pnpm dev      # server :2567 + client :5173
pnpm smoke    # with server running: WebSocket ping/pong check
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

See docs/ for decisions. Built phase by phase per the master build prompt.

## Phase 2: free-for-all on Foundry

Open the client, **pick your weapon**, set how many bots you want and their difficulty, then press **Play**.
Your mouse is only captured after you press Play or Resume. **Esc or P releases it** at any time (the game also
lets go when you switch window or tab, and pauses). Quit to the start screen from the pause menu; to leave
entirely, close the tab.

Everyone fights everyone: bots hunt you and each other, pick up floor weapons, and respawn after 3 s.

| Input | Action |
|---|---|
| WASD, Shift, Space, C, Q | move, sprint, jump, crouch, roll |
| Left / right mouse | fire (hold to keep firing) / aim down sights |
| R | reload |
| 1, 2 or mouse wheel | switch between your weapon (1, unlimited ammo) and the one you picked up (2) |
| E | swap with the weapon you are standing on (walking over one into an empty slot picks it up) |
| X | drop your picked-up weapon |
| B / K | add a bot / remove a bot (up to 10) |
| N | cycle the difficulty of bots you add next |
| H | hold-to-fire on or off |
| V | restart the fight with the menu settings |
| Esc or P | release the mouse and open the menu |
| 1-5 while dead | choose your weapon for the next life |

Seven pads on the map hold random weapons (white Common, blue Rare, purple Epic: x1.15 / x1.3 damage and bigger
magazines). A pad refills 25 s after it is taken. Picked-up weapons have limited ammo and vanish when empty, and
the one you carry drops where you die. All weapon numbers live in `packages/shared/src/balance.ts`.
