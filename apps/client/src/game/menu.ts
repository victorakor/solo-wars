import { TRAINING_RACK, WEAPONS, type BotLevel, type WeaponId } from '@arena/shared';
import type { CaptureState, MouseCapture } from './capture';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

export const LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard'];
export const MAX_BOTS = 10;

/** What the player picked: shared by reference with the game, which reads it when it (re)starts. */
export interface MenuConfig {
  weapon: WeaponId;
  /** Bots at the start of a fight. */
  bots: number;
  /** Difficulty of bots added from now on. */
  level: BotLevel;
}

export interface MenuHandlers {
  /** Start a fresh fight with the current config. */
  apply(): void;
  /** The weapon choice changed (takes effect at your next respawn, or on restart). */
  weaponChanged(id: WeaponId): void;
  addBot(): void;
  removeBot(): void;
  botCount(): number;
}

/** Start / pause menu. Visible whenever the mouse is not captured, so the cursor is never lost. */
export class Menu {
  readonly config: MenuConfig = { weapon: 'vanguard', bots: 3, level: 'medium' };
  handlers: MenuHandlers | null = null;
  private root = $('menu'); private title = $('menu-title'); private sub = $('menu-sub'); private err = $('menu-error');
  private resume = $<HTMLButtonElement>('btn-resume'); private reset = $<HTMLButtonElement>('btn-reset'); private quit = $<HTMLButtonElement>('btn-quit');
  private cards = $('cards'); private botsN = $('bots-n'); private level = $<HTMLButtonElement>('level'); private live = $('live-bots');

  constructor(private capture: MouseCapture) {
    for (const id of TRAINING_RACK) {
      const d = WEAPONS[id];
      const b = document.createElement('button');
      b.className = 'card';
      b.dataset.id = id;
      const dmg = d.pellets > 1 ? `${d.pellets}x${d.damage}` : `${d.damage}`;
      b.innerHTML = `${d.name}<small>${dmg} dmg</small><small>${d.rpm} rpm</small><small>${d.magSize} mag</small>`;
      b.addEventListener('click', () => { b.blur(); this.config.weapon = id; this.handlers?.weaponChanged(id); this.render(); });
      this.cards.appendChild(b);
    }
    $('bots-minus').addEventListener('click', () => { this.config.bots = Math.max(0, this.config.bots - 1); this.render(); });
    $('bots-plus').addEventListener('click', () => { this.config.bots = Math.min(MAX_BOTS, this.config.bots + 1); this.render(); });
    this.level.addEventListener('click', () => { this.level.blur(); this.cycleLevel(); });
    $('live-plus').addEventListener('click', () => { this.handlers?.addBot(); this.render(); });
    $('live-minus').addEventListener('click', () => { this.handlers?.removeBot(); this.render(); });
    this.resume.addEventListener('click', () => {
      this.resume.blur();
      if (capture.state === 'start') this.handlers?.apply();
      capture.engage();
    });
    this.reset.addEventListener('click', () => { this.reset.blur(); this.handlers?.apply(); capture.engage(); });
    this.quit.addEventListener('click', () => { this.quit.blur(); capture.quit(); });
    capture.onChange(() => this.render());
    this.render();
  }

  cycleLevel(): void {
    this.config.level = LEVELS[(LEVELS.indexOf(this.config.level) + 1) % LEVELS.length]!;
    this.render();
  }

  render(): void {
    const s: CaptureState = this.capture.state;
    this.root.classList.toggle('hidden', s === 'playing');
    const start = s === 'start';
    this.title.textContent = start ? 'Arena Duel' : 'Paused';
    this.sub.textContent = start ? 'Free-for-all against bots on Foundry. Pick your weapon, then Play.' : 'Mouse released. Nothing is running.';
    this.resume.textContent = start ? 'Play' : 'Resume';
    this.reset.style.display = start ? 'none' : '';
    this.quit.style.display = start ? 'none' : '';
    this.live.style.display = start ? 'none' : '';
    for (const c of Array.from(this.cards.children) as HTMLElement[]) c.classList.toggle('on', c.dataset.id === this.config.weapon);
    this.botsN.textContent = String(this.config.bots);
    this.level.textContent = this.config.level[0]!.toUpperCase() + this.config.level.slice(1);
    this.err.textContent = this.capture.error ?? '';
  }
}
