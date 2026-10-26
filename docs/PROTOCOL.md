# Match room protocol

Room name: `match` (clients with the same `code` join option meet in one room). Transport: Colyseus over WebSocket.
All hot-path messages are binary, little-endian, and every decoder bounds-checks (`CodecError`). The reference
implementation is `packages/shared/src/net/codec.ts`; its tests pin every layout below.

## Messages

| Name | Direction | Reliability | Payload |
|---|---|---|---|
| `in` | client to server | unreliable-style (redundant) | binary input batch, 30 Hz |
| `ping` | client to server | unreliable-style | JSON `{ t }` (client ms), validated with zod |
| `hello` | client to server | reliable | `{}`: asks for the welcome again |
| `welcome` | server to client | reliable | JSON `Welcome` (you, seed, sceneId, serverTime, roster, pickups) |
| `roster` | server to client | reliable | JSON `{ roster }` when players or bots join or leave |
| `snap` | server to client | unreliable-style | binary snapshot, 20 Hz |
| `ev` | server to client | reliable | binary event batch |
| `pong` | server to client | unreliable-style | JSON `{ t, serverTime }` |

WebSocket itself is reliable and ordered, so "unreliable-style" means we never retransmit or wait: inputs carry
redundancy and snapshots are self-contained, so a late or missing packet costs nothing. The in-game network
simulator and the tests model loss on those and model "loss" on reliable messages as a retransmission delay.

Fire, reload, weapon switch, pickup, drop and dodge are **flags inside the input frame**, not separate messages,
so they are ordered with movement and predicted identically on both sides.

## Input batch (`in`)

```
u8  type = 1
u8  count            1..5 (clients send 4)
u16 serverTimeLow    low 16 bits of the client's estimate of the server clock (ms) at its newest input
u16 firstSeq         sequence number of the first input; the rest are consecutive (16-bit, 0 is never used)
count x input:
  u16 flags          bit0 jump, 1 sprint, 2 crouch, 3 dodge, 4 ads, 5 fire, 6 firePressed, 7 reload,
                     8 interact, 9 drop, 10 hasAim, 11 hasSlot, 12-14 slot
  i8  moveX          / 127
  i8  moveZ          / 127
  u16 yaw            x 2*pi / 65536
  i16 pitch          x (pi/2) / 32767
  [3 bytes aim]      only if hasAim: two signed 12-bit values, yaw and pitch offset from the view,
                     x 0.6 / 2047 rad. Only present on inputs that fire.
```

The client simulates with the *quantised* values (`quantizeInput`), so its prediction is bit-identical to what the
server decodes. Each batch repeats the previous inputs (every input rides in two batches), so one lost batch loses
nothing. The server resolves `serverTimeLow` against its own clock; with the 100 ms interpolation delay subtracted it
is the "render time" used for lag compensation, clamped to the last 250 ms.

## Snapshot (`snap`)

```
u8  type = 2
u32 serverTime       ms since the room started
u16 tick             snapshot counter, wraps; gaps measure packet loss
u16 ack              newest input of the receiver the server has processed
u8  flags            bit0 = own state present
u8  actorCount       other actors (max 16)
[own body]           f32 pos x,y,z; f32 vel x,y,z; u8 flags (0 onGround, 1 crouched, 2 sprinting, 3 rolling);
                     f32 stamina, sinceSprint, sprintRecover, rollT, rollCd; [f32 rollDirX, rollDirZ if rolling]
[own combat]         u16 hp x100; u8 alive; i16 protectT ms; i16 respawnT ms; u8 slot; u32 shotCounter;
                     f32 recoil pitch, yaw, hold; u8 weaponCount;
                     per weapon: u8 id, u8 rarity, u8 reloading, u8 mag, u8 magSize, u16 reserve (0xFFFF = unlimited),
                                 f32 cooldown, reloadT, equipT, adsT, buffer
actors x n:
  u8  id; u8 mask (bit0 = slow fields present)
  i16 x, y, z        / 256   (4 mm)
  i8  vx / 16;  i8 vy / 3;  i8 vz / 16
  u16 yaw            x 2*pi / 65536
  i8  pitch          x (pi/2) / 127
  u8  flags          0 onGround, 1 crouched, 2 sprinting, 3 rolling, 4 alive, 5 reloading, 6 ads, 7 protected
  [slow: u8 hp, u8 weapon | rarity << 3, u8 mag, u8 stamina]
```

The owner's own body and combat state are always sent in full, with exact floats for every timer, so it can rewind
its prediction to the acknowledged input and replay the rest. (Millisecond-rounded timers were tried and made predicted
shots flip a tick early or late; see DECISIONS 31.) Other players' slow fields are sent when they change and always
every 10th snapshot, so a lost one heals within 0.5 s.

## Events (`ev`)

`u8 type = 3, u8 count`, then per event a tag byte and payload. Tags: `1 shot` (effects for other players' shots),
`2 hit` (to the shooter), `3 dmg` (to the victim, with direction), `4 kill`, `5 pickup`, `6 pad` (stocked or taken),
`7 drop`, `8 dropGone`, `9 respawn`, `10 note`, `11 stats` (once a second), `12 match` (waiting, live, paused with a
countdown, forfeit). Layouts are in `codec.ts` (`writeEvent`).

## Budgets (measured by the network tests, 150 ms RTT, 5% loss)

| Case | Down | Up |
|---|---|---|
| Duel, both moving | 22.0 kbps | 11.7 kbps |
| Duel, continuous fire with aim | 23.5 kbps | 14.5 kbps |
| 2 humans + 2 bots | 28.4 kbps | 11.7 kbps |

Budget: 30 kbps down, 15 kbps up (counting 8 to 10 bytes of framing per message). Each extra actor costs about
3 kbps downstream, which is why a room holds at most 2 humans and 2 bots.
