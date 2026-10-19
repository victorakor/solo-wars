import type { CaptureState, MouseCapture } from './capture';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/** Start / pause menu. Visible whenever the mouse is not captured, so the cursor is never lost. */
export class Menu {
  onReset: (() => void) | null = null;
  private root = $('menu'); private title = $('menu-title'); private sub = $('menu-sub'); private err = $('menu-error');
  private resume = $<HTMLButtonElement>('btn-resume'); private reset = $<HTMLButtonElement>('btn-reset'); private quit = $<HTMLButtonElement>('btn-quit');

  constructor(private capture: MouseCapture) {
    this.resume.addEventListener('click', () => { this.resume.blur(); capture.engage(); });
    this.reset.addEventListener('click', () => { this.reset.blur(); this.onReset?.(); capture.engage(); });
    this.quit.addEventListener('click', () => { this.quit.blur(); this.onReset?.(); capture.quit(); });
    capture.onChange(() => this.render());
    this.render();
  }

  render(): void {
    const s: CaptureState = this.capture.state;
    this.root.classList.toggle('hidden', s === 'playing');
    const start = s === 'start';
    this.title.textContent = start ? 'Arena Duel' : 'Paused';
    this.sub.textContent = start ? 'Training range · Phase 2: combat' : 'Mouse released. Nothing is running.';
    this.resume.textContent = start ? 'Play' : 'Resume';
    this.reset.style.display = start ? 'none' : '';
    this.quit.style.display = start ? 'none' : '';
    this.err.textContent = this.capture.error ?? '';
  }
}
