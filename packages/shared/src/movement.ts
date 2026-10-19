import { MOVE } from './balance';
import type { Box, CollisionWorld, Vec3 } from './collision';

export interface PlayerState {
  pos: Vec3; vel: Vec3; onGround: boolean; crouched: boolean; sprinting: boolean;
  stamina: number; sinceSprint: number; sprintRecover: number;
  rollT: number; rollCd: number; rollDirX: number; rollDirZ: number;
}
export interface MoveInput {
  moveX: number; moveZ: number; yaw: number; pitch: number;
  jump: boolean; sprint: boolean; crouch: boolean; dodge: boolean; ads: boolean;
  speedMult?: number;
}
const EPS = 1e-4, SUB = 0.1, R = MOVE.radius;

export const newPlayer = (x = 0, y = 0, z = 0): PlayerState => ({
  pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, onGround: false, crouched: false, sprinting: false,
  stamina: MOVE.stamina.max, sinceSprint: 99, sprintRecover: 0, rollT: 0, rollCd: 0, rollDirX: 0, rollDirZ: 0,
});
export const clonePlayer = (s: PlayerState): PlayerState =>
  ({ ...s, pos: { ...s.pos }, vel: { ...s.vel } });
export const heightOf = (s: PlayerState): number => (s.crouched ? MOVE.heightCrouch : MOVE.heightStand);
export const eyeHeightOf = (s: PlayerState): number => (s.crouched ? MOVE.eyeCrouch : MOVE.eyeStand);
export const isRolling = (s: PlayerState): boolean => s.rollT > 0;
/** Firing/aiming is blocked while sprinting, rolling or in sprint recovery. */
export const canShoot = (s: PlayerState): boolean => !s.sprinting && s.rollT <= 0 && s.sprintRecover <= 0;

const lo = { x: 0, y: 0, z: 0 }, hi = { x: 0, y: 0, z: 0 }, hits: Box[] = [];
function hitsAt(w: CollisionWorld, s: PlayerState, h: number): Box[] {
  lo.x = s.pos.x - R; hi.x = s.pos.x + R; lo.z = s.pos.z - R; hi.z = s.pos.z + R;
  lo.y = s.pos.y; hi.y = s.pos.y + h;
  return w.query(lo, hi, hits);
}

function moveHoriz(w: CollisionWorld, s: PlayerState, axis: 'x' | 'z', d: number, h: number): void {
  if (d === 0) return;
  s.pos[axis] += d;
  const b = hitsAt(w, s, h);
  if (!b.length) return;
  if (s.onGround) { // auto step-up
    let top = -Infinity;
    for (const x of b) top = Math.max(top, x.max.y);
    if (top - s.pos.y <= MOVE.maxStep + EPS) {
      const oy = s.pos.y;
      s.pos.y = top;
      if (!hitsAt(w, s, h).length) return;
      s.pos.y = oy;
    }
  }
  let edge = d > 0 ? Infinity : -Infinity;
  for (const x of hitsAt(w, s, h)) edge = d > 0 ? Math.min(edge, x.min[axis]) : Math.max(edge, x.max[axis]);
  s.pos[axis] = d > 0 ? edge - R - EPS : edge + R + EPS;
  s.vel[axis] = 0;
}

function moveVert(w: CollisionWorld, s: PlayerState, d: number, h: number): void {
  s.pos.y += d;
  const b = hitsAt(w, s, h);
  if (!b.length) return;
  if (d < 0) {
    let top = -Infinity;
    for (const x of b) top = Math.max(top, x.max.y);
    s.pos.y = top; s.onGround = true;
  } else {
    let bot = Infinity;
    for (const x of b) bot = Math.min(bot, x.min.y);
    s.pos.y = bot - h;
  }
  s.vel.y = 0;
}

/** Deterministic fixed-step player update. Mutates `s`. */
export function stepPlayer(s: PlayerState, inp: MoveInput, dt: number, w: CollisionWorld): void {
  const wasGround = s.onGround;
  s.rollCd = Math.max(0, s.rollCd - dt);
  const sinY = Math.sin(inp.yaw), cosY = Math.cos(inp.yaw);
  let mx = inp.moveX, mz = inp.moveZ;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  const moving = ml > 0.01;
  const wx = mx * cosY - mz * sinY, wz = -mx * sinY - mz * cosY; // right=(cos,0,-sin) fwd=(-sin,0,-cos)

  // roll
  if (inp.dodge && s.rollT <= 0 && s.rollCd <= 0 && s.onGround) {
    s.rollT = MOVE.roll.duration; s.rollCd = MOVE.roll.cooldown; s.crouched = true; s.sprinting = false;
    s.rollDirX = moving ? wx / ml : sinY; s.rollDirZ = moving ? wz / ml : cosY; // backward = (sin,cos)
  }
  const rolling = s.rollT > 0;

  // crouch / stand (needs headroom)
  if (!rolling) {
    if (inp.crouch) s.crouched = true;
    else if (s.crouched) {
      s.crouched = false;
      if (hitsAt(w, s, MOVE.heightStand).length) s.crouched = true;
    }
  }

  // sprint & stamina
  const st = MOVE.stamina;
  const wantSprint = inp.sprint && moving && !s.crouched && !inp.ads && !rolling;
  if (wantSprint && (s.sprinting || s.stamina >= st.minToStart) && s.stamina > 0) {
    s.sprinting = true; s.sinceSprint = 0; s.stamina = Math.max(0, s.stamina - st.drain * dt);
  } else {
    if (s.sprinting) s.sprintRecover = MOVE.sprintRecovery;
    s.sprinting = false;
    s.sinceSprint += dt;
    if (s.sinceSprint >= st.regenDelay) s.stamina = Math.min(st.max, s.stamina + st.regen * dt);
  }
  s.sprintRecover = Math.max(0, s.sprintRecover - dt);

  // horizontal velocity
  if (rolling) {
    s.vel.x = s.rollDirX * MOVE.roll.speed; s.vel.z = s.rollDirZ * MOVE.roll.speed;
  } else {
    let max = s.sprinting ? MOVE.sprint : s.crouched ? MOVE.crouch : MOVE.walk;
    if (inp.ads) max *= MOVE.adsMult;
    max *= inp.speedMult ?? 1;
    const tx = moving ? (wx / ml) * ml * max : 0, tz = moving ? (wz / ml) * ml * max : 0;
    const rate = moving ? max / MOVE.accelTime : MOVE.walk / MOVE.stopTime;
    const a = rate * (s.onGround ? 1 : MOVE.airControl) * dt;
    const dx = tx - s.vel.x, dz = tz - s.vel.z, dl = Math.hypot(dx, dz);
    if (dl > 0) { const k = Math.min(1, a / dl); s.vel.x += dx * k; s.vel.z += dz * k; }
  }

  // vertical velocity
  if (inp.jump && s.onGround && !rolling) { s.vel.y = MOVE.jumpSpeed; s.onGround = false; }
  s.vel.y = Math.max(-MOVE.terminalFall, s.vel.y - MOVE.gravity * dt);

  // sweep in sub-steps (never more than SUB metres per axis step => no tunnelling)
  const h = heightOf(s);
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(s.vel.x), Math.abs(s.vel.y), Math.abs(s.vel.z)) * dt / SUB));
  s.onGround = false;
  for (let i = 0; i < n; i++) {
    const g: boolean = s.onGround;
    s.onGround = g || wasGround; // step-up allowed when grounded at tick start
    moveHoriz(w, s, 'x', (s.vel.x * dt) / n, h);
    moveHoriz(w, s, 'z', (s.vel.z * dt) / n, h);
    s.onGround = g;
    moveVert(w, s, (s.vel.y * dt) / n, h);
  }
  // stay glued to stairs when walking down
  if (!s.onGround && wasGround && s.vel.y <= 0) {
    const oy = s.pos.y;
    moveVert(w, s, -MOVE.maxStep, h);
    if (!s.onGround) s.pos.y = oy;
  }
  if (s.rollT > 0) s.rollT = Math.max(0, s.rollT - dt);
}
