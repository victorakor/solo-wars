import { NET } from '../balance';
import type { RemoteState } from './codec';

/** A remote actor sampled at some render time. Slow fields hold the last value received. */
export interface Interpolated {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  onGround: boolean; crouched: boolean; sprinting: boolean; rolling: boolean;
  alive: boolean; reloading: boolean; ads: boolean; protectedNow: boolean;
  hp: number; weapon: string; rarity: number; mag: number; stamina: number;
}

interface Entry extends Interpolated { t: number }

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
/** A jump larger than a player can cover between snapshots is a respawn: never blend across it. */
const TELEPORT_M = 3;

/**
 * Buffer of one remote actor's snapshots. `sample(renderTime)` blends the two snapshots around that time
 * (the client renders ~100 ms in the past so two usually exist), extrapolates up to 100 ms along the velocity
 * if the newest one is late, then holds.
 */
export class RemoteTrack {
  private buf: Entry[] = [];

  /** Adds a snapshot. Out-of-order arrivals are placed by time; duplicates are dropped. */
  push(serverTime: number, s: RemoteState): void {
    const prev = this.buf.length ? this.buf[this.buf.length - 1]! : null;
    const e: Entry = {
      t: serverTime, x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, yaw: s.yaw, pitch: s.pitch,
      onGround: s.onGround, crouched: s.crouched, sprinting: s.sprinting, rolling: s.rolling, alive: s.alive,
      reloading: s.reloading, ads: s.ads, protectedNow: s.protectedNow,
      hp: s.hp ?? prev?.hp ?? 100, weapon: s.weapon ?? prev?.weapon ?? 'sidearm', rarity: s.rarity ?? prev?.rarity ?? 0,
      mag: s.mag ?? prev?.mag ?? 0, stamina: s.stamina ?? prev?.stamina ?? 100,
    };
    let i = this.buf.length;
    while (i > 0 && this.buf[i - 1]!.t > serverTime) i--;
    if (i > 0 && this.buf[i - 1]!.t === serverTime) return;
    this.buf.splice(i, 0, e);
    const oldest = serverTime - 1000;
    while (this.buf.length > 2 && this.buf[0]!.t < oldest) this.buf.shift();
  }

  clear(): void {
    this.buf.length = 0;
  }

  get size(): number {
    return this.buf.length;
  }

  /** Latest snapshot time, or -1. */
  get newestTime(): number {
    return this.buf.length ? this.buf[this.buf.length - 1]!.t : -1;
  }

  sample(renderTime: number): Interpolated | null {
    const b = this.buf;
    if (b.length === 0) return null;
    if (renderTime <= b[0]!.t) return b[0]!;
    const last = b[b.length - 1]!;
    if (renderTime >= last.t) {
      const dt = Math.min(renderTime - last.t, NET.extrapolateMs) / 1000;
      return { ...last, x: last.x + last.vx * dt, y: last.y + last.vy * dt, z: last.z + last.vz * dt };
    }
    let i = b.length - 2;
    while (i > 0 && b[i]!.t > renderTime) i--;
    const a = b[i]!, c = b[i + 1]!;
    if (Math.hypot(c.x - a.x, c.z - a.z) > TELEPORT_M) return renderTime - a.t < c.t - renderTime ? a : c;
    const k = (renderTime - a.t) / (c.t - a.t);
    return {
      ...a,
      x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k,
      vx: a.vx + (c.vx - a.vx) * k, vy: a.vy + (c.vy - a.vy) * k, vz: a.vz + (c.vz - a.vz) * k,
      yaw: a.yaw + wrapPi(c.yaw - a.yaw) * k, pitch: a.pitch + (c.pitch - a.pitch) * k,
      // discrete state flips at the later snapshot once we are past the midpoint
      ...(k >= 0.5 ? { onGround: c.onGround, crouched: c.crouched, sprinting: c.sprinting, rolling: c.rolling, alive: c.alive, reloading: c.reloading, ads: c.ads, protectedNow: c.protectedNow, hp: c.hp, weapon: c.weapon, rarity: c.rarity, mag: c.mag, stamina: c.stamina } : {}),
    };
  }
}
