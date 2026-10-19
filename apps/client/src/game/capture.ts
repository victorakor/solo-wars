/**
 * Mouse capture lifecycle. The mouse is only ever captured by an explicit Play/Resume action, never
 * by a stray click, and can always be released: Esc (browser built-in), P (works even where Esc is
 * swallowed), switching tabs/windows, or the menu's Quit button. No DOM here, so it is unit-testable.
 */
export type CaptureState = 'start' | 'playing' | 'paused';

export interface LockApi {
  isLocked(): boolean;
  /** Ask the browser for pointer lock. Must be called from a user gesture. May return a promise. */
  request(): Promise<void> | void;
  exit(): void;
}

export const LOCK_BLOCKED_MESSAGE =
  'The browser would not capture the mouse yet (it needs about a second after Esc). Click Resume again.';

export class MouseCapture {
  state: CaptureState = 'start';
  /** Set when the last capture attempt failed; cleared by the next attempt or success. */
  error: string | null = null;
  private listeners: Array<(s: CaptureState) => void> = [];

  constructor(private api: LockApi) {}

  onChange(fn: (s: CaptureState) => void): void {
    this.listeners.push(fn);
  }

  get playing(): boolean {
    return this.state === 'playing';
  }

  /** Play / Resume. Call inside a click or key handler. The state flips when the browser confirms the lock. */
  engage(): void {
    this.error = null;
    try {
      const r = this.api.request();
      if (r && typeof r.then === 'function') r.catch(() => this.lockFailed());
    } catch {
      this.lockFailed();
    }
  }

  /** Gives the mouse back and opens the menu. Safe to call at any time. */
  release(): void {
    if (this.state === 'playing') this.setState('paused');
    if (this.api.isLocked()) this.api.exit();
  }

  /** The P key: release while playing, capture again otherwise. */
  toggle(): void {
    if (this.state === 'playing') this.release();
    else this.engage();
  }

  /** Back to the start screen with the mouse free. */
  quit(): void {
    this.setState('start'); // first, so a synchronous pointerlockchange cannot flash the pause menu
    if (this.api.isLocked()) this.api.exit();
  }

  /** Wire to `pointerlockchange`. */
  lockChanged(locked: boolean): void {
    if (locked) {
      this.error = null;
      this.setState('playing');
    } else if (this.state === 'playing') {
      this.setState('paused'); // Esc, alt-tab, or the browser took the lock away
    }
  }

  /** Wire to `pointerlockerror`, and called when the request promise rejects. */
  lockFailed(): void {
    this.error = LOCK_BLOCKED_MESSAGE;
    if (this.state === 'playing') this.setState('paused');
    else this.notify();
  }

  /** Wire to window blur / tab hidden / page hide: never keep the mouse while the user is elsewhere. */
  focusLost(): void {
    this.release();
  }

  private setState(s: CaptureState): void {
    if (this.state === s) return;
    this.state = s;
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.state);
  }
}

/** Real pointer-lock API for an element. */
export function domLockApi(el: HTMLElement): LockApi {
  return {
    isLocked: () => document.pointerLockElement === el,
    request: () => (el.requestPointerLock() as unknown as Promise<void> | undefined),
    exit: () => document.exitPointerLock(),
  };
}
