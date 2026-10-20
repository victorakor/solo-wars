import { idleInput, type ActorInput } from '@arena/shared';

export type Command = 'addBot' | 'removeBot' | 'botLevel' | 'reset' | 'repeat';

const COMMANDS: Record<string, Command> = { KeyB: 'addBot', KeyK: 'removeBot', KeyN: 'botLevel', KeyV: 'reset', KeyH: 'repeat' };

/**
 * Trigger flags for one tick. With `repeat`, holding the button counts as a fresh press every tick, so
 * semi, pump and bolt weapons keep firing at their own rate (the sim's cooldown still sets the pace).
 */
export function fireFlags(held: boolean, latch: boolean, repeat: boolean): { fire: boolean; firePressed: boolean } {
  return { fire: held || latch, firePressed: latch || (held && repeat) };
}

/**
 * Desktop input. Nothing is read unless `enabled` (set while the mouse is captured), and the input
 * never captures the mouse itself: that is MouseCapture's job, started only from Play/Resume.
 * WASD move, Shift sprint, Space jump, C crouch, Q roll, LMB fire, RMB aim, R reload, 1-2 / wheel switch weapon,
 * E pick up or swap, X drop the floor weapon.
 */
export class DesktopInput {
  yaw = 0; pitch = 0.15; sens = 0.0022;
  onCommand: ((c: Command) => void) | null = null;
  /** Hold the button to keep firing semi, pump and bolt weapons (default on). */
  holdToFire = true;
  private enabled = false;
  private keys = new Set<string>();
  private dodgeLatch = false; private reloadLatch = false; private fireLatch = false;
  private interactLatch = false; private dropLatch = false;
  private fireHeld = false; private ads = false;
  private slotKey: number | null = null; private wheel = 0;

  constructor(private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (!this.enabled || e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyQ') this.dodgeLatch = true;
      if (e.code === 'KeyR') this.reloadLatch = true;
      if (e.code === 'KeyE') this.interactLatch = true;
      if (e.code === 'KeyX') this.dropLatch = true;
      if (e.code === 'Space') e.preventDefault();
      const n = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : 0;
      if (n >= 1 && n <= 9) this.slotKey = n - 1;
      const c = COMMANDS[e.code];
      if (c) this.onCommand?.(c);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.clear());
    addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.el) return;
      this.yaw -= e.movementX * this.sens;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - e.movementY * this.sens));
    });
    addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) { this.fireHeld = true; this.fireLatch = true; }
      if (e.button === 2) this.ads = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.ads = false;
    });
    addEventListener('wheel', (e) => { if (this.enabled) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Enabled while the mouse is captured. Disabling drops every held key and button. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  private clear(): void {
    this.keys.clear();
    this.dodgeLatch = this.reloadLatch = this.fireLatch = this.fireHeld = this.ads = false;
    this.interactLatch = this.dropLatch = false;
    this.slotKey = null; this.wheel = 0;
  }

  /** One sim tick of input; consumes edge-triggered presses. `slot`/`count` resolve the mouse wheel. */
  sample(slot: number, count: number): ActorInput {
    const k = (c: string): number => (this.keys.has(c) ? 1 : 0);
    const out = idleInput();
    out.moveX = k('KeyD') - k('KeyA'); out.moveZ = k('KeyW') - k('KeyS');
    out.yaw = this.yaw; out.pitch = this.pitch;
    out.jump = this.keys.has('Space'); out.sprint = this.keys.has('ShiftLeft'); out.crouch = this.keys.has('KeyC');
    out.dodge = this.dodgeLatch; out.ads = this.ads;
    const f = fireFlags(this.fireHeld, this.fireLatch, this.holdToFire);
    out.fire = f.fire; out.firePressed = f.firePressed;
    out.reload = this.reloadLatch; out.interact = this.interactLatch; out.drop = this.dropLatch;
    if (this.slotKey !== null) out.slot = this.slotKey;
    else if (this.wheel !== 0 && count > 0) out.slot = (((slot + this.wheel) % count) + count) % count;
    this.dodgeLatch = this.reloadLatch = this.fireLatch = this.interactLatch = this.dropLatch = false;
    this.slotKey = null; this.wheel = 0;
    return out;
  }
}
