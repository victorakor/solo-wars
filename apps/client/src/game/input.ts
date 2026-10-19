import type { MoveInput } from '@arena/shared';

/** Desktop input: WASD, Shift, C (hold), Space, Q, RMB(ADS); mouse look via pointer lock. */
export class DesktopInput {
  yaw = 0; pitch = 0.15; sens = 0.0022;
  private keys = new Set<string>();
  private dodgeLatch = false; private ads = false;
  constructor(private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyQ') this.dodgeLatch = true;
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('click', () => { if (!document.pointerLockElement) void el.requestPointerLock?.(); });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== el) return;
      this.yaw -= e.movementX * this.sens;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - e.movementY * this.sens));
    });
    addEventListener('mousedown', (e) => { if (e.button === 2) this.ads = true; });
    addEventListener('mouseup', (e) => { if (e.button === 2) this.ads = false; });
    addEventListener('contextmenu', (e) => e.preventDefault());
  }
  /** Sample one sim tick of input; consumes edge-triggered presses. */
  sample(): MoveInput {
    const k = (c: string): number => (this.keys.has(c) ? 1 : 0);
    const out: MoveInput = {
      moveX: k('KeyD') - k('KeyA'), moveZ: k('KeyW') - k('KeyS'), yaw: this.yaw, pitch: this.pitch,
      jump: this.keys.has('Space'), sprint: this.keys.has('ShiftLeft'), crouch: this.keys.has('KeyC'),
      dodge: this.dodgeLatch, ads: this.ads,
    };
    this.dodgeLatch = false;
    return out;
  }
}
