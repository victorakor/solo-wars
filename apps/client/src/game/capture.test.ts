import { describe, expect, it } from 'vitest';
import { LOCK_BLOCKED_MESSAGE, MouseCapture } from './capture';

/** Fake browser: tracks the lock like the real API, and can refuse requests. */
function fake(opts: { refuse?: boolean; reject?: boolean } = {}) {
  let locked = false;
  const calls = { request: 0, exit: 0 };
  // the closures only run after construction, so they can refer to `cap`
  const cap: MouseCapture = new MouseCapture({
    isLocked: () => locked,
    request: () => {
      calls.request++;
      if (opts.reject) return Promise.reject(new Error('SecurityError'));
      if (!opts.refuse) { locked = true; cap.lockChanged(true); }
    },
    exit: () => { calls.exit++; locked = false; cap.lockChanged(false); },
  });
  return { cap, calls, isLocked: () => locked, browserEsc: () => { locked = false; cap.lockChanged(false); } };
}

describe('mouse capture', () => {
  it('starts free: nothing grabs the mouse until Play is pressed', () => {
    const f = fake();
    expect(f.cap.state).toBe('start');
    expect(f.calls.request).toBe(0);
    expect(f.isLocked()).toBe(false);
  });
  it('Play captures; the state follows the browser confirmation', () => {
    const f = fake();
    f.cap.engage();
    expect(f.cap.state).toBe('playing');
    expect(f.cap.playing).toBe(true);
  });
  it('Esc (browser releases the lock) opens the pause menu with the mouse free', () => {
    const f = fake();
    f.cap.engage(); f.browserEsc();
    expect(f.cap.state).toBe('paused');
    expect(f.isLocked()).toBe(false);
  });
  it('P releases while playing and re-captures while paused', () => {
    const f = fake();
    f.cap.engage();
    f.cap.toggle();
    expect([f.cap.state, f.isLocked(), f.calls.exit]).toEqual(['paused', false, 1]);
    f.cap.toggle();
    expect([f.cap.state, f.isLocked()]).toEqual(['playing', true]);
  });
  it('losing focus (alt-tab, hidden tab) always releases', () => {
    const f = fake();
    f.cap.engage(); f.cap.focusLost();
    expect([f.cap.state, f.isLocked()]).toEqual(['paused', false]);
  });
  it('Quit returns to the start screen with the mouse free', () => {
    const f = fake();
    f.cap.engage(); f.cap.quit();
    expect([f.cap.state, f.isLocked()]).toEqual(['start', false]);
    f.cap.quit(); // harmless when already free
    expect(f.cap.state).toBe('start');
  });
  it('release and focusLost are harmless when not playing', () => {
    const f = fake();
    f.cap.release(); f.cap.focusLost();
    expect(f.cap.state).toBe('start');
    expect(f.calls.exit).toBe(0);
  });
  it('a refused lock keeps the menu up with an explanation and allows retry', () => {
    const f = fake({ refuse: true });
    f.cap.engage();
    f.cap.lockFailed(); // pointerlockerror
    expect(f.cap.state).toBe('start');
    expect(f.cap.error).toBe(LOCK_BLOCKED_MESSAGE);
    f.cap.engage();
    expect(f.cap.error).toBeNull(); // cleared on the next attempt
  });
  it('a rejected request promise is handled (Chrome right after Esc)', async () => {
    const f = fake({ reject: true });
    f.cap.engage();
    await Promise.resolve(); await Promise.resolve();
    expect(f.cap.error).toBe(LOCK_BLOCKED_MESSAGE);
    expect(f.cap.state).toBe('start');
  });
  it('a throwing request is handled too', () => {
    const cap = new MouseCapture({ isLocked: () => false, request: () => { throw new Error('nope'); }, exit: () => undefined });
    cap.engage();
    expect(cap.error).toBe(LOCK_BLOCKED_MESSAGE);
  });
  it('notifies listeners once per real change', () => {
    const f = fake(); const seen: string[] = [];
    f.cap.onChange((s) => seen.push(s));
    f.cap.engage(); f.cap.lockChanged(true); f.browserEsc(); f.browserEsc(); f.cap.toggle(); f.cap.quit();
    expect(seen).toEqual(['playing', 'paused', 'playing', 'start']);
  });
});
