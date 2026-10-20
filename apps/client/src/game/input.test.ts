import { describe, expect, it } from 'vitest';
import { WEAPONS, newWeapon, stepWeapon, tryFire, type WeaponId } from '@arena/shared';
import { fireFlags } from './input';

describe('hold to fire', () => {
  it('repeat on: holding is a press every tick; off: only the click is', () => {
    expect(fireFlags(true, false, true)).toEqual({ fire: true, firePressed: true });
    expect(fireFlags(true, false, false)).toEqual({ fire: true, firePressed: false });
    expect(fireFlags(false, true, false)).toEqual({ fire: true, firePressed: true }); // a quick tap still fires
    expect(fireFlags(false, false, true)).toEqual({ fire: false, firePressed: false });
  });
  it('holding keeps every weapon firing at exactly its own rpm', () => {
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const def = WEAPONS[id], ws = newWeapon(id, true);
      let shots = 0;
      for (let i = 0; i < 600; i++) {
        ws.mag = def.magSize; // isolate the rate from reloads
        stepWeapon(ws, def, 1 / 60, false);
        const f = fireFlags(true, false, true);
        if (tryFire(ws, def, f.firePressed, f.fire, true) === 'fired') shots++;
      }
      expect(Math.abs(shots - (def.rpm / 60) * 10)).toBeLessThanOrEqual(1.5);
    }
  });
  it('without it a held Sidearm fires once', () => {
    const def = WEAPONS.sidearm, ws = newWeapon('sidearm', true);
    let shots = 0;
    for (let i = 0; i < 300; i++) {
      stepWeapon(ws, def, 1 / 60, false);
      const f = fireFlags(true, i === 0, false);
      if (tryFire(ws, def, f.firePressed, f.fire, true) === 'fired') shots++;
    }
    expect(shots).toBe(1);
  });
});
