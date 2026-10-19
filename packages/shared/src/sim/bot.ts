import { DEG, WEAPONS, type BotProfile } from '../balance';
import type { CollisionWorld, Vec3 } from '../collision';
import { eyeHeightOf } from '../movement';
import { hasLineOfSight } from './hitscan';
import { mulberry32, type Rng } from './rng';
import { idleInput, type Actor, type ActorInput } from './sim';

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Basic practice bot. It produces the same ActorInput a human would, so the sim cannot tell the
 * difference. It knows roughly where its target is (no hearing or vision model) but can only shoot
 * with line of sight, reacts after a delay, aims with smoothed error, counters part of its recoil,
 * fires in bursts, strafes, and breaks free when stuck. Navigation is straight-line; Phase 10 improves it.
 */
export class BotBrain {
  private rng: Rng;
  private yaw: number;
  private pitch = 0;
  private errYaw = 0; private errPitch = 0;
  private errTargetYaw = 0; private errTargetPitch = 0; private errT = 0;
  private seenT = 0;
  private sinceSeen = 99;
  private strafeDir = 1; private strafeT = 0;
  private burstOn = false; private burstT = 0; private pauseT = 0.3;
  private stuckT = 0; private escapeT = 0; private escapeSide = 1;
  private readonly out: ActorInput = idleInput();

  constructor(readonly profile: BotProfile, seed: number, initialYaw = 0) {
    this.rng = mulberry32(seed);
    this.yaw = initialYaw;
  }

  private range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.rng();
  }

  /** Returns the input for this tick. The returned object is reused; read it before the next call. */
  think(me: Actor, enemy: Actor | null, world: CollisionWorld, dt: number): ActorInput {
    const p = this.profile;
    const o = this.out;
    o.moveX = 0; o.moveZ = 0; o.jump = false; o.sprint = false; o.crouch = false; o.dodge = false;
    o.ads = false; o.fire = false; o.firePressed = false; o.reload = false; o.slot = null;
    o.aimYaw = undefined; o.aimPitch = undefined;
    o.yaw = this.yaw; o.pitch = this.pitch;
    if (!me.hp.alive) { this.seenT = 0; this.burstOn = false; return o; }

    const ws = me.rack[me.slot]!;
    const def = WEAPONS[ws.id];
    const myEye: Vec3 = { x: me.body.pos.x, y: me.body.pos.y + eyeHeightOf(me.body), z: me.body.pos.z };

    // perception
    const target = enemy && enemy.hp.alive ? enemy : null;
    let sees = false;
    let chest: Vec3 = myEye;
    if (target) {
      chest = { x: target.body.pos.x, y: target.body.pos.y + (target.body.crouched ? 0.7 : 1.1), z: target.body.pos.z };
      sees = hasLineOfSight(world, myEye, chest);
    }
    if (sees) { this.seenT += dt; this.sinceSeen = 0; } else { this.seenT = 0; this.sinceSeen += dt; }
    const engaged = sees && this.seenT >= p.reactionSec;

    // aim error wanders: a new random offset every 0.25 s, eased towards
    this.errT -= dt;
    if (this.errT <= 0) {
      this.errT = 0.25;
      this.errTargetYaw = (this.rng() * 2 - 1) * p.aimErrorDeg * DEG;
      this.errTargetPitch = (this.rng() * 2 - 1) * p.aimErrorDeg * DEG;
    }
    const ease = Math.min(1, dt * 8);
    this.errYaw += (this.errTargetYaw - this.errYaw) * ease;
    this.errPitch += (this.errTargetPitch - this.errPitch) * ease;

    // turning towards the target (or the last place it was seen)
    let dist = 0;
    let aimErrDeg = 180;
    if (target) {
      const dx = chest.x - myEye.x, dy = chest.y - myEye.y, dz = chest.z - myEye.z;
      dist = Math.hypot(dx, dz);
      const wantYaw = Math.atan2(-dx, -dz);
      const wantPitch = Math.atan2(dy, dist);
      const goalYaw = wantYaw + this.errYaw - me.recoil.yaw * p.aimComp;
      const goalPitch = wantPitch + this.errPitch - me.recoil.pitch * p.aimComp;
      const maxTurn = p.turnRate * DEG * dt;
      this.yaw += clamp(wrap(goalYaw - this.yaw) * Math.min(1, dt * 12), -maxTurn, maxTurn);
      this.pitch = clamp(this.pitch + clamp((goalPitch - this.pitch) * Math.min(1, dt * 12), -maxTurn, maxTurn), -1.2, 1.2);
      const eY = wrap(wantYaw - (this.yaw + me.recoil.yaw)), eP = wantPitch - (this.pitch + me.recoil.pitch);
      aimErrDeg = Math.hypot(eY, eP) / DEG;
    }

    // shooting: only with line of sight, after the reaction delay, with the reticle near the target
    const coneDeg = Math.min(p.fireConeDeg, Math.max(0.6, Math.atan2(0.4, Math.max(dist, 1)) / DEG));
    const inRange = dist <= Math.max(def.falloffEnd, 30);
    if (engaged && inRange && aimErrDeg < coneDeg) {
      if (this.burstOn) {
        o.fire = true; o.firePressed = true;
        this.burstT -= dt;
        if (this.burstT <= 0) { this.burstOn = false; this.pauseT = this.range(p.pauseMin, p.pauseMax); }
      } else {
        this.pauseT -= dt;
        if (this.pauseT <= 0) { this.burstOn = true; this.burstT = this.range(p.burstMin, p.burstMax); }
      }
    } else {
      this.burstOn = false;
    }
    o.ads = engaged && dist > p.adsRange;
    if (ws.mag === 0 || (!engaged && ws.mag < def.magSize * 0.5)) o.reload = true;

    // movement
    let fwd = 0, side = 0;
    if (target) {
      if (sees) {
        if (dist > p.rangeMax) fwd = 1; else if (dist < p.rangeMin) fwd = -1;
        this.strafeT -= dt;
        if (this.strafeT <= 0) { this.strafeDir = this.rng() < 0.5 ? -1 : 1; this.strafeT = this.range(p.strafeMin, p.strafeMax); }
        side = this.strafeDir;
      } else {
        fwd = 1;
        o.sprint = dist > 18 && this.sinceSeen > 0.5;
      }
    }
    const speed = Math.hypot(me.body.vel.x, me.body.vel.z);
    if ((fwd !== 0 || side !== 0) && speed < 0.6) this.stuckT += dt; // jumping in place must not reset this
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > 0.35) {
      o.jump = true;
      if (this.stuckT > 0.7) { this.stuckT = 0; this.escapeT = 0.8; this.escapeSide = this.rng() < 0.5 ? -1 : 1; }
    }
    if (this.escapeT > 0) { this.escapeT -= dt; side = this.escapeSide; fwd = this.rng() < 0.3 ? 1 : 0; }
    o.moveZ = fwd; o.moveX = side;
    if (o.ads) o.sprint = false;
    o.yaw = this.yaw; o.pitch = this.pitch;
    return o;
  }
}
