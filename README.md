# Arena Duel

```
pnpm install
pnpm dev      # server :2567 + client :5173
pnpm smoke    # with server running: WebSocket ping/pong check
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

See docs/ for decisions. Built phase by phase per the master build prompt.

## Phase 2: training range

Open the client and press **Play**. Your mouse is only captured after you press Play or Resume.
**Esc or P releases it** at any time (the game also lets go when you switch window or tab, and pauses).
Quit to the start screen from the pause menu; to leave entirely, close the tab.

| Input | Action |
|---|---|
| WASD, Shift, Space, C, Q | move, sprint, jump, crouch, roll |
| Left / right mouse | fire / aim down sights |
| R | reload |
| 1-5 or wheel | Sidearm, Rattler, Vanguard, Breaker, Longshot |
| B / N | add or remove the bot / cycle its difficulty (easy, medium, hard) |
| U | toggle infinite reserve or floor reserves (restocks) |
| H | hold-to-fire on or off (on: hold left mouse to keep firing any weapon at its own rate) |
| V | reset the range |
| Esc or P | release the mouse and open the menu |

Dummies stand on the centre lane at 5, 15, 30 and 44 m. The panel on the right shows shots, accuracy,
headshots, the last hit (damage, distance, falloff, head or body) and time-to-kill.
All weapon numbers live in `packages/shared/src/balance.ts`.
