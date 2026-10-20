import { DEG, type BotProfile, type WeaponId } from '../balance';
import type { CollisionWorld, Vec3 } from '../collision';
import { eyeHeightOf } from '../movement';
import { hasLineOfSight } from './hitscan';
import { mulberry32, type Rng } from './rng';
import { floorSlot, idleInput, type Actor, type ActorInput, type Pickup } from './sim';

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Distance (m) each weapon is happiest at; the bot picks weapons and holds range by this. */
const FIT: Record<WeaponId, number> = { sidearm: 18, rattler: 12, vanguard: 25, breaker: 6, longshot: 55 };

const chestOf = (a: Actor): Vec3 => ({ x: a.body.pos.x, y: a.body.pos.y + (a.body.crouched ? 0.7 : 1.1), z: a.body.pos.z });

/**
 * Practice bot for free-for-all fights. It produces the same ActorInput a human would, so the sim cannot
 * tell the difference. It fights whoever is nearest and visible (the player or other bots), reacts after a
 * delay, aims with smoothed error, counters part of its recoil, fires in bursts, strafes in short varied
 * bursts, rolls away when shot, jump-strafes, switches weapon by range, and detours to pick up floor weapons
 * when its second slot is empty. It knows roughly where enemies are (no hearing or vision model) but can
 * only shoot with line of sight. Navigation is straight-line with stuck recovery; Phase 10 adds real pathing.
 */
export class BotBrain {
  private rng: Rng;
  private yaw: number;
  private pitch = 0;
  private errYaw = 0; private errPitch = 0;
  private errTargetYaw = 0; private errTargetPitch = 0; private errT = 0;
  private targetId: string | null = null;
  private seenT = 0;
  private sinceSeen = 99;
  private strafeDir = 1; private strafeT = 0;
  private burstOn = false; private burstT = 0; private pauseT = 0.3;
  private stuckT = 0; private escapeT = 0; private escapeSide = 1;
  private lastHp = 100; private hurtT = 0; private pauseStrafeT = 0; private lastDist = 0;
  private weaponT = 0;
  private readonly out: ActorInput = idleInput();

  constructor(readonly profile: BotProfile, seed: number, initialYaw = 0) {
    this.rng = mulberry32(seed);
    this.yaw = initialYaw;
  }

  private range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.rng();
  }

  /** Picks who to fight: keep the current target while it is visible, else the nearest visible, else hunt the nearest. */
  private chooseTarget(me: Actor, enemies: readonly Actor[], eye: Vec3, world: CollisionWorld): Actor | null {
    let bestVis: Actor | null = null, bestVisD = Infinity;
    let nearest: Actor | null = null, nearD = Infinity;
    let current: Actor | null = null, currentVis = false, currentD = Infinity;
    for (const e of enemies) {
      if (e === me || !e.hp.alive) continue;
      const c = chestOf(e);
      const d = Math.hypot(c.x - eye.x, c.z - eye.z);
      const vis = hasLineOfSight(world, eye, c);
      if (d < nearD) { nearest = e; nearD = d; }
      if (vis && d < bestVisD) { bestVis = e; bestVisD = d; }
      if (e.id === this.targetId) { current = e; currentVis = vis; currentD = d; }
    }
    if (current && currentVis && (!bestVis || bestVisD > currentD * 0.7)) return current;
    return bestVis ?? current ?? nearest;
  }

  /** Weapon (rack index) that suits this distance best among those with ammo; sticky to avoid thrash. */
  private chooseSlot(me: Actor, dist: number): number | null {
    if (me.rack.length < 2) return null;
    const cur = me.rack[me.slot]!;
    if (cur.reloading || cur.equipT > 0) return null;
    let best = me.slot, bestScore = -Infinity;
    me.rack.forEach((w, i) => {
      if (w.mag <= 0 && w.reserve <= 0) return;
      const score = 1 - Math.abs(dist - FIT[w.id]) / 60 + (i === me.slot ? 0.15 : 0);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best !== me.slot ? best : null;
  }

  /** Nearest floor weapon worth walking to. */
  private nearestPickup(me: Actor, pickups: readonly Pickup[]): Pickup | null {
    let best: Pickup | null = null, bestD = 35;
    for (const p of pickups) {
      if (!p.state) continue;
      const d = Math.hypot(p.x - me.body.pos.x, p.z - me.body.pos.z);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  /**
   * Returns the input for this tick (the object is reused; read it before the next call).
   * `enemies` may include `me`; it is skipped.
   */
  think(me: Actor, enemies: readonly Actor[], world: CollisionWorld, dt: number, pickups: readonly Pickup[] = []): ActorInput {
    const p = this.profile;
    const o = this.out;
    o.moveX = 0; o.moveZ = 0; o.jump = false; o.sprint = false; o.crouch = false; o.dodge = false;
    o.ads = false; o.fire = false; o.firePressed = false; o.reload = false; o.slot = null; o.interact = false; o.drop = false;
    o.aimYaw = undefined; o.aimPitch = undefined;
    o.yaw = this.yaw; o.pitch = this.pitch;
    if (!me.hp.alive) { this.seenT = 0; this.burstOn = false; this.targetId = null; this.lastHp = 100; return o; }

    const ws = me.rack[me.slot]!;
    const myEye: Vec3 = { x: me.body.pos.x, y: me.body.pos.y + eyeHeightOf(me.body), z: me.body.pos.z };

    // perception
    const target = this.chooseTarget(me, enemies, myEye, world);
    if (target?.id !== this.targetId) { this.targetId = target?.id ?? null; this.seenT = 0; this.sinceSeen = 99; this.burstOn = false; }
    let sees = false;
    let chest: Vec3 = myEye;
    if (target) {
      chest = chestOf(target);
      sees = hasLineOfSight(world, myEye, chest);
    }
    if (sees) { this.seenT += dt; this.sinceSeen = 0; } else { this.seenT = 0; this.sinceSeen += dt; }
    const engaged = sees && this.seenT >= p.reactionSec;

    // with an empty floor slot and nobody to shoot at, go and get a weapon
    const wantsFloor = floorSlot(me) < 0;
    const pad = wantsFloor && !sees ? this.nearestPickup(me, pickups) : null;
    const lookAt: Vec3 | null = pad ? { x: pad.x, y: myEye.y, z: pad.z } : target ? chest : null;

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

    // turning towards what it is looking at
    let dist = 0;
    let goalDist = 0;
    let aimErrDeg = 180;
    if (lookAt) {
      const dx = lookAt.x - myEye.x, dy = lookAt.y - myEye.y, dz = lookAt.z - myEye.z;
      goalDist = Math.hypot(dx, dz);
      const wantYaw = Math.atan2(-dx, -dz);
      const wantPitch = pad ? 0 : Math.atan2(dy, goalDist);
      const aiming = !pad && target !== null;
      if (aiming) dist = goalDist;
      const goalYaw = wantYaw + this.errYaw - (aiming ? me.recoil.yaw * p.aimComp : 0);
      const goalPitch = wantPitch + this.errPitch - (aiming ? me.recoil.pitch * p.aimComp : 0);
      const maxTurn = p.turnRate * DEG * dt;
      this.yaw += clamp(wrap(goalYaw - this.yaw) * Math.min(1, dt * 12), -maxTurn, maxTurn);
      this.pitch = clamp(this.pitch + clamp((goalPitch - this.pitch) * Math.min(1, dt * 12), -maxTurn, maxTurn), -1.2, 1.2);
      if (aiming) {
        const eY = wrap(wantYaw - (this.yaw + me.recoil.yaw)), eP = wantPitch - (this.pitch + me.recoil.pitch);
        aimErrDeg = Math.hypot(eY, eP) / DEG;
      }
    }
    if (target && !pad) {
      const c = chestOf(target);
      dist = Math.hypot(c.x - myEye.x, c.z - myEye.z);
    }

    // weapon choice by range (every half second)
    this.weaponT -= dt;
    if (target && this.weaponT <= 0) { this.weaponT = 0.5; o.slot = this.chooseSlot(me, dist); }

    // shooting: only with line of sight, after the reaction delay, with the reticle near the target
    const fit = FIT[ws.id];
    const coneDeg = Math.min(p.fireConeDeg, Math.max(0.6, Math.atan2(0.4, Math.max(dist, 1)) / DEG));
    const inRange = dist <= Math.max(fit * 2, 20);
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
    o.ads = engaged && dist > (ws.id === 'longshot' ? 8 : p.adsRange);
    if (ws.mag === 0 || (!engaged && ws.mag < ws.magSize * 0.5)) o.reload = true;

    // movement: strafe in short, varied bursts with pauses, push or back off depending on the fight
    const tookDamage = me.hp.hp < this.lastHp - 0.01;
    this.lastHp = me.hp.hp;
    if (tookDamage) this.hurtT = 0.6;
    this.hurtT = Math.max(0, this.hurtT - dt);
    let fwd = 0, side = 0;
    if (pad) {
      fwd = 1;
      o.sprint = goalDist > 10;
    } else if (target) {
      if (sees) {
        const foeWeak = target.hp.hp < 35 || target.rack[target.slot]?.reloading === true;
        const hurt = me.hp.hp < 35;
        const push = foeWeak ? p.aggression : 0;
        const lo = Math.min(p.rangeMin, fit * 0.8), hi = Math.max(fit * 1.2, Math.min(p.rangeMax, fit * 1.6));
        const minR = lo * (hurt ? 1.5 : 1 - 0.5 * push), maxR = hi * (1 - 0.4 * push);
        if (dist > maxR) fwd = 1; else if (dist < minR) fwd = -1;
        this.strafeT -= dt;
        if (this.strafeT <= 0) {
          this.strafeT = this.range(p.strafeMin, p.strafeMax);
          const r = this.rng();
          if (r < 0.2 && !tookDamage) { this.strafeDir = 0; this.pauseStrafeT = this.range(0.15, 0.35); } // stop to shoot straight
          else this.strafeDir = r < 0.75 ? (this.strafeDir === 0 ? (this.rng() < 0.5 ? -1 : 1) : -this.strafeDir) : this.rng() < 0.5 ? -1 : 1;
        }
        if (this.strafeDir === 0 && (this.pauseStrafeT -= dt) <= 0) this.strafeDir = this.rng() < 0.5 ? -1 : 1;
        side = this.strafeDir;
        // never strafe into a wall: look 1.2 m sideways at chest height and flip if it is blocked
        if (side !== 0) {
          const rx = Math.cos(this.yaw) * side, rz = -Math.sin(this.yaw) * side;
          if (world.raycast({ x: myEye.x, y: myEye.y - 0.4, z: myEye.z }, { x: rx, y: 0, z: rz }, 1.2) !== null) {
            this.strafeDir = -side; side = this.strafeDir;
          }
        }
        // crouch while standing still at range (smaller target, tighter spread); jump-strafe now and then
        o.crouch = side === 0 && dist > 15;
        if (side !== 0 && me.body.onGround && this.rng() < p.jumpiness * dt) o.jump = true;
        // roll away from incoming fire
        if (tookDamage && me.body.rollCd <= 0 && this.rng() < p.dodgeChance) {
          if (side === 0) side = this.rng() < 0.5 ? -1 : 1;
          o.dodge = true;
        }
      } else {
        fwd = 1; // hunting
        o.sprint = dist > 18 && this.sinceSeen > 0.5;
      }
    }
    const speed = Math.hypot(me.body.vel.x, me.body.vel.z);
    // stuck = commanding movement but going nowhere, or heading somewhere while sliding along a wall without closing in
    const closing = (this.lastDist - goalDist) / dt;
    this.lastDist = goalDist;
    const travelling = (pad !== null || (target !== null && !sees)) && fwd === 1 && this.escapeT <= 0;
    if (((fwd !== 0 || side !== 0) && speed < 0.6) || (travelling && closing < 1.0)) this.stuckT += dt; // jumping in place must not reset this
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > 0.35) {
      o.jump = true;
      if (this.stuckT > 0.7) {
        this.stuckT = 0; this.escapeT = 1.2;
        // slide towards whichever side is more open, then try forward again
        const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        const probe = (k: number): number => world.raycast({ x: myEye.x, y: myEye.y - 0.4, z: myEye.z }, { x: rx * k, y: 0, z: rz * k }, 8) ?? 8;
        const l = probe(-1), r = probe(1);
        this.escapeSide = l === r ? (this.rng() < 0.5 ? -1 : 1) : l > r ? -1 : 1;
      }
    }
    if (this.escapeT > 0) {
      this.escapeT -= dt; side = this.escapeSide; fwd = this.escapeT < 0.5 ? 1 : 0;
      if (this.escapeT < 0.5) o.sprint = false;
    }
    o.moveZ = fwd; o.moveX = side;
    if (o.ads) o.sprint = false;
    o.yaw = this.yaw; o.pitch = this.pitch;
    return o;
  }
}
