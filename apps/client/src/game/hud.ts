/** DOM HUD. Everything is looked up once; per-frame updates only touch elements whose value changed. */
export interface HudView {
  hp: number;
  alive: boolean;
  protectedNow: boolean;
  stamina: number;
  rollCd: number;
  weaponName: string;
  mag: number;
  /** Infinity renders as the infinity sign. */
  reserve: number;
  magSize: number;
  /** 0..1 progress, or -1 when not reloading. */
  reloadFrac: number;
  slots: { label: string; active: boolean }[];
  /** Distance of the crosshair arms from the centre, in CSS px. */
  gapPx: number;
  scoped: boolean;
  debug: string;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

export class Hud {
  private el = {
    hpnum: $('hpnum'), hpfill: $('hpfill'), stam: $('stamfill'), roll: $('rollinfo'), vitals: $('vitals'),
    wname: $('wname'), ammo: $('ammo'), reload: $('reload'), slots: $('slots'), crosshair: $('crosshair'),
    scope: $('scope'), vignette: $('vignette'), hit: $('hitmarker'), nums: $('dmgnums'), arcs: $('arcs'),
    feed: $('feed'), train: $('trainbody'), respawn: $('respawn'), rmain: $('respawnmain'), rsub: $('respawnsub'), dbg: $('dbg'),
  };
  private text = new Map<HTMLElement, string>();
  private vignetteOff = 0;

  private set(el: HTMLElement, s: string): void {
    if (this.text.get(el) === s) return;
    this.text.set(el, s);
    el.textContent = s;
  }

  update(v: HudView): void {
    const e = this.el;
    this.set(e.hpnum, String(Math.ceil(v.hp)));
    e.hpfill.style.width = `${Math.max(0, v.hp)}%`;
    e.stam.style.width = `${v.stamina}%`;
    this.set(e.roll, v.rollCd > 0 ? `Roll ${v.rollCd.toFixed(1)}s` : 'Roll ready');
    e.vitals.classList.toggle('protected', v.protectedNow);
    this.set(e.wname, v.weaponName);
    const ammoText = `${v.mag} / ${v.reserve === Infinity ? '∞' : v.reserve}`;
    if (this.text.get(e.ammo) !== ammoText) {
      this.text.set(e.ammo, ammoText);
      e.ammo.textContent = ammoText;
      e.ammo.classList.toggle('low', v.mag <= Math.ceil(v.magSize * 0.25));
    }
    e.reload.style.opacity = v.reloadFrac >= 0 ? '1' : '0';
    if (v.reloadFrac >= 0) (e.reload.firstElementChild as HTMLElement).style.width = `${v.reloadFrac * 100}%`;
    const slotKey = v.slots.map((s) => `${s.label}${s.active ? '*' : ''}`).join('|');
    if (this.text.get(e.slots) !== slotKey) {
      this.text.set(e.slots, slotKey);
      e.slots.innerHTML = v.slots.map((s, i) => `<div class="slot${s.active ? ' on' : ''}">${i + 1} ${s.label}</div>`).join('');
    }
    e.crosshair.style.setProperty('--g', `${Math.max(4, v.gapPx).toFixed(1)}px`);
    e.crosshair.classList.toggle('hidden', v.scoped || !v.alive);
    e.scope.style.opacity = v.scoped ? '1' : '0';
    this.set(e.dbg, v.debug);
    if (this.vignetteOff > 0 && performance.now() > this.vignetteOff) { e.vignette.style.opacity = '0'; this.vignetteOff = 0; }
  }

  hitMarker(kind: 'hit' | 'head' | 'kill'): void {
    const h = this.el.hit;
    h.className = '';
    void h.offsetWidth; // restart the CSS animation
    h.className = `show ${kind === 'hit' ? '' : kind}`;
  }

  damageNumber(x: number, y: number, amount: number, head: boolean): void {
    const d = document.createElement('div');
    d.className = head ? 'dn head' : 'dn';
    d.textContent = String(Math.round(amount));
    d.style.left = `${x}px`; d.style.top = `${y}px`;
    this.el.nums.appendChild(d);
    setTimeout(() => d.remove(), 850);
  }

  /** `angle` radians clockwise from straight ahead towards the attacker. */
  damageArc(angle: number): void {
    const a = document.createElement('div');
    a.className = 'arc';
    a.style.transform = `rotate(${angle}rad)`;
    this.el.arcs.appendChild(a);
    setTimeout(() => a.remove(), 1000);
    this.el.vignette.style.opacity = '0.7';
    this.vignetteOff = performance.now() + 150;
  }

  feed(text: string, mine: boolean): void {
    const f = document.createElement('div');
    f.className = mine ? 'kf mine' : 'kf';
    f.textContent = text;
    this.el.feed.appendChild(f);
    while (this.el.feed.childElementCount > 5) this.el.feed.firstElementChild?.remove();
    setTimeout(() => f.remove(), 6000);
  }

  train(lines: string[]): void {
    this.set(this.el.train, lines.join('\n'));
    this.el.train.style.whiteSpace = 'pre-line';
  }

  deathScreen(show: boolean, main = '', sub = ''): void {
    this.el.respawn.style.display = show ? 'flex' : 'none';
    if (show) { this.set(this.el.rmain, main); this.set(this.el.rsub, sub); }
  }
}
