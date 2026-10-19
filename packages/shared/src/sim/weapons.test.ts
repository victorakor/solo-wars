import { describe, expect, it } from 'vitest';
import { COMBAT, DEG, WEAPONS, type WeaponId } from '../balance';
import { mulberry32, mixSeed, shotRng } from './rng';
import {
  bulletDamage, currentSpreadDeg, damageFalloff, equipWeapon, forwardOf, kickRecoil, newRecoil, newWeapon,
  recoverRecoil, shotDirections, startReload, stepHolstered, stepWeapon, tryFire,
} from './weapons';
import { DT } from './testkit';

const IDS = Object.keys(WEAPONS) as WeaponId[];
const GROUND = { speed: 0, onGround: true, crouched: false };

/** Holds the trigger (and spams presses) for `secs` with the magazine topped up, counting shots. */
function countShots(id: WeaponId, secs: number): number {
  const def = WEAPONS[id], ws = newWeapon(id, true);
  let n = 0;
  for (let i = 0; i < Math.round(secs * 60); i++) {
    ws.mag = def.magSize;
    stepWeapon(ws, def, DT, false);
    if (tryFire(ws, def, true, true, true) === 'fired') n++;
  }
  return n;
}

describe('weapon table matches spec 6.3', () => {
  const W = WEAPONS;
  it('Sidearm', () => {
    const d = W.sidearm;
    expect([d.fireMode, d.damage, d.rpm, d.magSize, d.reserveAmmo, d.reloadSec]).toEqual(['semi', 22, 360, 12, 48, 1.4]);
    expect([d.falloffStart, d.falloffEnd, d.minDamageMult]).toEqual([25, 55, 0.6]);
  });
  it('Rattler', () => {
    const d = W.rattler;
    expect([d.fireMode, d.damage, d.rpm, d.magSize, d.reserveAmmo, d.reloadSec]).toEqual(['auto', 13, 780, 30, 120, 1.9]);
    expect([d.falloffStart, d.falloffEnd, d.minDamageMult]).toEqual([15, 35, 0.5]);
    expect(d.spreadHip).toBeGreaterThan(W.vanguard.spreadHip); // "high hip spread"
    expect(W.vanguard.spreadHip).toBeGreaterThan(W.sidearm.spreadHip);
  });
  it('Vanguard', () => {
    const d = W.vanguard;
    expect([d.fireMode, d.damage, d.rpm, d.magSize, d.reserveAmmo, d.reloadSec]).toEqual(['auto', 20, 600, 30, 90, 2.2]);
    expect([d.falloffStart, d.falloffEnd, d.minDamageMult]).toEqual([30, 70, 0.65]);
  });
  it('Breaker', () => {
    const d = W.breaker;
    expect([d.fireMode, d.pellets, d.damage, d.rpm, d.magSize, d.reserveAmmo]).toEqual(['pump', 8, 9, 70, 6, 24]);
    expect([d.reloadSec, d.reloadPerShell, d.pelletSpread]).toEqual([0.5, true, 4]);
    expect([d.falloffStart, d.falloffEnd, d.minDamageMult]).toEqual([6, 18, 0.2]);
  });
  it('Longshot', () => {
    const d = W.longshot;
    expect([d.fireMode, d.damage, d.rpm, d.magSize, d.reserveAmmo, d.reloadSec]).toEqual(['bolt', 95, 45, 4, 12, 3.0]);
    expect(d.damage * d.headMult).toBeCloseTo(150, 6);
    expect(d.adsFovMult).toBe(0.25); // 4x scope
    expect(d.moveSpeedMult).toBe(0.85);
    expect(d.spreadHip).toBeGreaterThan(5); // large unscoped spread
  });
  it('every firearm is hitscan data with sane values', () => {
    for (const id of IDS) {
      const d = WEAPONS[id];
      expect(d.id).toBe(id);
      expect(d.category).toBe('firearm');
      expect(d.falloffEnd).toBeGreaterThan(d.falloffStart);
      expect(d.minDamageMult).toBeGreaterThan(0);
      expect(d.minDamageMult).toBeLessThanOrEqual(1);
      expect(d.spreadAds).toBeLessThan(d.spreadHip);
      expect(d.headMult).toBeGreaterThan(1);
    }
  });
});

describe('fire rate', () => {
  it('matches rpm over 10 s for every firearm (within one shot)', () => {
    for (const id of IDS) {
      const expected = (WEAPONS[id].rpm / 60) * 10;
      expect(Math.abs(countShots(id, 10) - expected)).toBeLessThanOrEqual(1.5);
    }
  });
  it('bolt and pump cycle times are enforced between shots', () => {
    for (const [id, secs] of [['longshot', 60 / 45], ['breaker', 60 / 70]] as const) {
      const def = WEAPONS[id], ws = newWeapon(id, true);
      const at: number[] = [];
      for (let i = 0; i < 60 * 8; i++) {
        ws.mag = def.magSize; stepWeapon(ws, def, DT, false);
        if (tryFire(ws, def, true, true, true) === 'fired') at.push(i);
      }
      for (let k = 1; k < at.length; k++) expect(Math.abs((at[k]! - at[k - 1]!) * DT - secs)).toBeLessThanOrEqual(DT * 1.01);
    }
  });
  it('semi weapons need a fresh press: holding does not auto-fire', () => {
    const def = WEAPONS.sidearm, ws = newWeapon('sidearm', true);
    let shots = 0;
    for (let i = 0; i < 120; i++) {
      stepWeapon(ws, def, DT, false);
      if (tryFire(ws, def, i === 0, true, true) === 'fired') shots++;
    }
    expect(shots).toBe(1);
  });
  it('auto weapons fire while held and stop on release', () => {
    const def = WEAPONS.rattler, ws = newWeapon('rattler', true);
    let held = 0, released = 0;
    for (let i = 0; i < 60; i++) { stepWeapon(ws, def, DT, false); if (tryFire(ws, def, i === 0, true, true) === 'fired') held++; }
    for (let i = 0; i < 60; i++) { stepWeapon(ws, def, DT, false); if (tryFire(ws, def, false, false, true) === 'fired') released++; }
    expect(held).toBeGreaterThan(10);
    expect(released).toBe(0);
  });
  it('a press just before the cooldown ends is buffered; an early one is not', () => {
    const def = WEAPONS.sidearm;
    const shotsAfter = (pressTick: number): number => {
      const ws = newWeapon('sidearm', true); let n = 0;
      for (let i = 0; i < 20; i++) {
        stepWeapon(ws, def, DT, false);
        if (tryFire(ws, def, i === 0 || i === pressTick, false, true) === 'fired') n++;
      }
      return n;
    };
    expect(shotsAfter(6)).toBe(2); // 0.1 s: within the 0.12 s buffer of the 0.167 s cooldown
    expect(shotsAfter(1)).toBe(1); // 0.017 s: buffer expires before the cooldown does
  });
  it('holstered weapons keep their cooldown (no swap exploit)', () => {
    const def = WEAPONS.sidearm, ws = newWeapon('sidearm', true);
    stepWeapon(ws, def, DT, false);
    expect(tryFire(ws, def, true, true, true)).toBe('fired');
    for (let i = 0; i < 5; i++) stepHolstered(ws, DT);
    expect(ws.cooldown).toBeGreaterThan(0);
  });
});

describe('ammo, dry fire and blocking', () => {
  it('drains the magazine, clicks dry, then auto-reloads', () => {
    const def = WEAPONS.rattler, ws = newWeapon('rattler', true);
    let fired = 0, dry = 0;
    for (let i = 0; i < 60 * 4; i++) {
      stepWeapon(ws, def, DT, false);
      const r = tryFire(ws, def, true, true, true);
      if (r === 'fired') fired++;
      if (r === 'dry') dry++;
      if (dry === 1 && ws.reloading) break;
    }
    expect(fired).toBe(30);
    expect(ws.mag).toBe(0);
    expect(ws.reloading).toBe(true);
  });
  it('with no reserve it clicks dry repeatedly and never reloads', () => {
    const def = WEAPONS.sidearm, ws = newWeapon('sidearm');
    ws.mag = 0; ws.reserve = 0;
    let dry = 0;
    for (let i = 0; i < 120; i++) { stepWeapon(ws, def, DT, false); if (tryFire(ws, def, true, true, true) === 'dry') dry++; }
    expect(dry).toBeGreaterThan(2);
    expect(ws.reloading).toBe(false);
    expect(ws.mag).toBe(0);
  });
  it('cannot fire while sprinting or rolling (canShoot false) and keeps its ammo', () => {
    const def = WEAPONS.vanguard, ws = newWeapon('vanguard');
    stepWeapon(ws, def, DT, false);
    expect(tryFire(ws, def, true, true, false)).toBe('blocked');
    expect(ws.mag).toBe(30);
  });
  it('cannot fire while equipping, then can', () => {
    const def = WEAPONS.vanguard, ws = newWeapon('vanguard');
    equipWeapon(ws, def);
    let firstShot = -1;
    for (let i = 0; i < 60 && firstShot < 0; i++) {
      stepWeapon(ws, def, DT, false);
      if (tryFire(ws, def, true, true, true) === 'fired') firstShot = i;
    }
    expect(firstShot * DT).toBeGreaterThanOrEqual(def.equipSec - DT * 1.5);
    expect(firstShot * DT).toBeLessThan(def.equipSec + 3 * DT);
  });
});

describe('reload', () => {
  const finish = (id: WeaponId, ws: ReturnType<typeof newWeapon>, secs: number): void => {
    for (let i = 0; i < Math.round(secs * 60); i++) stepWeapon(ws, WEAPONS[id], DT, false);
  };
  it('takes reloadSec, restores the magazine and uses reserve', () => {
    const def = WEAPONS.vanguard, ws = newWeapon('vanguard');
    ws.mag = 10;
    expect(startReload(ws, def)).toBe(true);
    finish('vanguard', ws, 2.15);
    expect(ws.reloading).toBe(true);
    expect(ws.mag).toBe(10);
    finish('vanguard', ws, 0.1);
    expect(ws.reloading).toBe(false);
    expect([ws.mag, ws.reserve]).toEqual([30, 70]);
  });
  it('is limited by the reserve', () => {
    const def = WEAPONS.vanguard, ws = newWeapon('vanguard');
    ws.mag = 0; ws.reserve = 5;
    startReload(ws, def); finish('vanguard', ws, 2.5);
    expect([ws.mag, ws.reserve]).toEqual([5, 0]);
  });
  it('is refused when full, when out of reserve, or already reloading', () => {
    const def = WEAPONS.vanguard, ws = newWeapon('vanguard');
    expect(startReload(ws, def)).toBe(false);
    ws.mag = 3; ws.reserve = 0;
    expect(startReload(ws, def)).toBe(false);
    ws.reserve = 50;
    expect(startReload(ws, def)).toBe(true);
    expect(startReload(ws, def)).toBe(false);
  });
  it('infinite reserve stays infinite', () => {
    const def = WEAPONS.vanguard, ws = newWeapon('vanguard', true);
    ws.mag = 0; startReload(ws, def); finish('vanguard', ws, 2.5);
    expect(ws.mag).toBe(30);
    expect(ws.reserve).toBe(Infinity);
  });
  it('blocks firing while reloading, and a weapon switch cancels it', () => {
    const def = WEAPONS.vanguard, ws = newWeapon('vanguard');
    ws.mag = 10; startReload(ws, def);
    stepWeapon(ws, def, DT, false);
    expect(tryFire(ws, def, true, true, true)).toBe('blocked');
    equipWeapon(ws, def);
    expect(ws.reloading).toBe(false);
    expect(ws.mag).toBe(10);
  });
  it('shotgun loads one shell per 0.5 s and takes 3 s from empty', () => {
    const def = WEAPONS.breaker, ws = newWeapon('breaker');
    ws.mag = 0;
    startReload(ws, def);
    finish('breaker', ws, 0.55);
    expect([ws.mag, ws.reserve]).toEqual([1, 23]);
    finish('breaker', ws, 2.3);
    expect(ws.mag).toBe(5);
    expect(ws.reloading).toBe(true);
    finish('breaker', ws, 0.3);
    expect([ws.mag, ws.reserve, ws.reloading]).toEqual([6, 18, false]);
  });
  it('shotgun reload can be interrupted by firing only when a shell is loaded', () => {
    const def = WEAPONS.breaker, ws = newWeapon('breaker');
    ws.mag = 2; startReload(ws, def);
    stepWeapon(ws, def, DT, false);
    expect(tryFire(ws, def, true, true, true)).toBe('fired');
    expect(ws.reloading).toBe(false);
    const empty = newWeapon('breaker');
    empty.mag = 0; startReload(empty, def); stepWeapon(empty, def, DT, false);
    expect(tryFire(empty, def, true, true, true)).toBe('blocked');
    expect(empty.reloading).toBe(true);
  });
});

describe('aim down sights', () => {
  it('reaches full ADS in adsSeconds and releases symmetrically', () => {
    const def = WEAPONS.longshot, ws = newWeapon('longshot');
    for (let i = 0; i < Math.round(def.adsSeconds * 30); i++) stepWeapon(ws, def, DT, true);
    expect(ws.adsT).toBeGreaterThan(0.4);
    expect(ws.adsT).toBeLessThan(0.6);
    for (let i = 0; i < Math.round(def.adsSeconds * 60) + 2; i++) stepWeapon(ws, def, DT, true);
    expect(ws.adsT).toBe(1);
    for (let i = 0; i < Math.round(def.adsSeconds * 60) + 2; i++) stepWeapon(ws, def, DT, false);
    expect(ws.adsT).toBe(0);
  });
});

describe('damage', () => {
  it('falls off linearly between start and end and clamps outside', () => {
    const d = WEAPONS.sidearm;
    expect(damageFalloff(d, 10)).toBe(1);
    expect(damageFalloff(d, 25)).toBe(1);
    expect(damageFalloff(d, 40)).toBeCloseTo(0.8, 9);
    expect(damageFalloff(d, 55)).toBeCloseTo(0.6, 9);
    expect(damageFalloff(d, 500)).toBeCloseTo(0.6, 9);
    expect(damageFalloff(WEAPONS.breaker, 12)).toBeCloseTo(0.6, 9);
  });
  it('applies head multiplier, falloff and external multiplier', () => {
    expect(bulletDamage(WEAPONS.vanguard, 10, false)).toBeCloseTo(20, 9);
    expect(bulletDamage(WEAPONS.vanguard, 10, true)).toBeCloseTo(30, 9);
    expect(bulletDamage(WEAPONS.vanguard, 50, false)).toBeCloseTo(16.5, 9);
    expect(bulletDamage(WEAPONS.longshot, 80, false)).toBeCloseTo(95, 9);
    expect(bulletDamage(WEAPONS.longshot, 80, true)).toBeCloseTo(150, 9); // headshot = 150
    expect(bulletDamage(WEAPONS.vanguard, 10, false, 1.3)).toBeCloseTo(26, 9);
    expect(bulletDamage(WEAPONS.breaker, 3, false) * WEAPONS.breaker.pellets).toBeCloseTo(72, 9);
  });
});

describe('spread', () => {
  const v = WEAPONS.vanguard;
  it('interpolates hip to ADS and applies movement modifiers', () => {
    expect(currentSpreadDeg(v, 0, GROUND)).toBeCloseTo(2.4, 9);
    expect(currentSpreadDeg(v, 1, GROUND)).toBeCloseTo(0.3, 9);
    expect(currentSpreadDeg(v, 0.5, GROUND)).toBeCloseTo(1.35, 9);
    expect(currentSpreadDeg(v, 0, { ...GROUND, speed: 5 })).toBeCloseTo(2.4 * COMBAT.spread.moveMult, 9);
    expect(currentSpreadDeg(v, 0, { ...GROUND, onGround: false })).toBeCloseTo(2.4 * COMBAT.spread.airMult, 9);
    expect(currentSpreadDeg(v, 0, { ...GROUND, crouched: true })).toBeCloseTo(2.4 * COMBAT.spread.crouchMult, 9);
  });
  it('is deterministic per seed and shotId, and differs between shots', () => {
    const a = shotDirections(0.3, 0.1, 2, v, shotRng(7, 1)), b = shotDirections(0.3, 0.1, 2, v, shotRng(7, 1));
    const c = shotDirections(0.3, 0.1, 2, v, shotRng(7, 2)), e = shotDirections(0.3, 0.1, 2, v, shotRng(8, 1));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(e);
    expect(shotRng(7, 1, 0)()).not.toBe(shotRng(7, 1, 1)());
  });
  it('stays inside the cone, is uniform over the disc and unbiased', () => {
    const spread = 3, n = 4000, f = forwardOf(0, 0);
    let maxAng = 0, sumR = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      const [d] = shotDirections(0, 0, spread, v, shotRng(99, i));
      expect(Math.hypot(d!.x, d!.y, d!.z)).toBeCloseTo(1, 9);
      const ang = Math.acos(d!.x * f.x + d!.y * f.y + d!.z * f.z);
      maxAng = Math.max(maxAng, ang);
      sumR += Math.tan(ang) / Math.tan(spread * DEG);
      sx += d!.x; sy += d!.y;
    }
    expect(maxAng).toBeLessThanOrEqual(spread * DEG + 1e-9);
    expect(Math.abs(sumR / n - 2 / 3)).toBeLessThan(0.03); // uniform disc: mean radius 2/3
    expect(Math.abs(sx / n)).toBeLessThan(0.002);
    expect(Math.abs(sy / n)).toBeLessThan(0.002);
  });
  it('zero spread fires exactly along the aim and respects yaw and pitch', () => {
    const [d] = shotDirections(Math.PI / 2, 0, 0, v, mulberry32(1));
    expect(d!.x).toBeCloseTo(-1, 9);
    expect(d!.z).toBeCloseTo(0, 9);
    const [u] = shotDirections(0, 0.5, 0, v, mulberry32(1));
    expect(u!.y).toBeCloseTo(Math.sin(0.5), 9);
  });
  it('shotgun fires 8 distinct pellets inside the 4 degree pellet cone', () => {
    const b = WEAPONS.breaker, f = forwardOf(0, 0);
    const dirs = shotDirections(0, 0, 0, b, shotRng(5, 1));
    expect(dirs).toHaveLength(8);
    expect(new Set(dirs.map((d) => `${d.x.toFixed(6)},${d.y.toFixed(6)}`)).size).toBe(8);
    for (const d of dirs) expect(Math.acos(d.x * f.x + d.y * f.y + d.z * f.z)).toBeLessThanOrEqual(4 * DEG + 1e-9);
  });
  it('rng helpers are well behaved', () => {
    const r = mulberry32(42); let s = 0;
    for (let i = 0; i < 5000; i++) { const x = r(); expect(x >= 0 && x < 1).toBe(true); s += x; }
    expect(Math.abs(s / 5000 - 0.5)).toBeLessThan(0.02);
    expect(new Set(Array.from({ length: 2000 }, (_, i) => mixSeed(1, i))).size).toBe(2000);
  });
});

describe('recoil', () => {
  it('climbs while firing, is bounded, and recovers after a pause', () => {
    const def = WEAPONS.vanguard, r = newRecoil();
    for (let i = 0; i < 10; i++) kickRecoil(r, def, shotRng(1, i));
    expect(r.pitch / DEG).toBeCloseTo(4.5, 6);
    for (let i = 0; i < 100; i++) kickRecoil(r, def, shotRng(1, 100 + i));
    expect(r.pitch / DEG).toBeCloseTo(COMBAT.recoil.maxPitchDeg, 6);
    expect(Math.abs(r.yaw / DEG)).toBeLessThanOrEqual(COMBAT.recoil.maxYawDeg + 1e-9);
  });
  it('holds briefly, then returns to zero at recoilRecovery deg/s', () => {
    const def = WEAPONS.vanguard, r = newRecoil();
    kickRecoil(r, def, shotRng(3, 1));
    kickRecoil(r, def, shotRng(3, 2));
    const p0 = r.pitch;
    for (let i = 0; i < 5; i++) recoverRecoil(r, def, DT); // inside the hold window
    expect(r.pitch).toBe(p0);
    for (let i = 0; i < 20; i++) recoverRecoil(r, def, DT);
    expect(r.pitch).toBeLessThan(p0);
    for (let i = 0; i < 120; i++) recoverRecoil(r, def, DT);
    expect(r.pitch).toBe(0);
    expect(r.yaw).toBe(0);
  });
  it('yaw kick is deterministic for the same shot', () => {
    const def = WEAPONS.rattler, a = newRecoil(), b = newRecoil();
    kickRecoil(a, def, shotRng(9, 4, 3)); kickRecoil(b, def, shotRng(9, 4, 3));
    expect(a).toEqual(b);
  });
});
