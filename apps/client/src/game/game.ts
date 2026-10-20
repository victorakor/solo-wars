import * as THREE from 'three';
import {
  BOT_PROFILES, COMBAT, DEG, FOUNDRY, RARITY, SIM, TRAINING_RACK, WEAPONS, PLAYER_ID, BotBrain, CollisionWorld,
  addBot, clonePlayer, convergeAim, createTraining, currentSpreadDeg, eyeHeightOf, floorSlot, motionOf,
  type Actor, type ActorInput, type CombatEvent, type PlayerState, type Training, type WeaponState,
} from '@arena/shared';
import { computeCamera, fovDeg, newRig, CAMERA } from './camera';
import type { MouseCapture } from './capture';
import { Character } from './character';
import { HealthBar } from './healthbar';
import type { Hud } from './hud';
import { DesktopInput, type Command } from './input';
import { MAX_BOTS, type MenuConfig } from './menu';
import { PickupViews } from './pickupViews';
import { buildScene } from './scene';
import { Vfx } from './vfx';

interface ActorView {
  character: Character;
  bar: HealthBar | null;
  /** Interpolated copy of the body used to pose the model. */
  pose: PlayerState;
  deadT: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const slotLabel = (w: WeaponState, floor: boolean): string => {
  const name = `${floor ? `${RARITY[w.rarity]?.name ?? ''} ` : ''}${WEAPONS[w.id].name}`;
  return `${name} ${w.reserve === Infinity ? '∞' : `${w.mag}/${w.reserve}`}`;
};

export interface GameHandle {
  /** Starts a fresh fight from the current menu config. */
  apply(): void;
  /** Sets the weapon you will respawn with (immediately if you are dead). */
  setWeapon(id: (typeof TRAINING_RACK)[number]): void;
  addBot(): void;
  removeBot(): void;
  botCount(): number;
}

export function startGame(canvas: HTMLCanvasElement, hud: Hud, capture: MouseCapture, cfg: MenuConfig, onCfg: () => void): GameHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA.baseFovDeg, 1, 0.1, 250);
  buildScene(FOUNDRY, scene);
  const world = new CollisionWorld(FOUNDRY.boxes);
  const vfx = new Vfx(scene);
  const pickupViews = new PickupViews(scene);
  const input = new DesktopInput(canvas);
  const resize = (): void => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();
  capture.onChange(() => input.setEnabled(capture.playing));

  // --- session state ---------------------------------------------------------
  let t: Training = createTraining(1, { weapon: cfg.weapon });
  const brains = new Map<string, BotBrain>();
  const views = new Map<string, ActorView>();
  let killer = '';
  let last = { text: 'none yet', ttk: '' };
  const firstHit = new Map<string, { t0: number; lastT: number }>();
  let accum = 0;

  const makeView = (a: Actor): void => {
    const palette = a.kind === 'bot' ? [0x6a3a8a, 0xe8b04a] : [0x2f6fb5, 0xe8b04a];
    const character = new Character(palette[0], palette[1]);
    scene.add(character.root);
    const bar = a.kind === 'player' ? null : new HealthBar();
    if (bar) scene.add(bar.root);
    views.set(a.id, { character, bar, pose: clonePlayer(a.body), deadT: -1 });
  };
  const dropView = (id: string): void => {
    const v = views.get(id);
    if (!v) return;
    scene.remove(v.character.root);
    if (v.bar) scene.remove(v.bar.root);
    views.delete(id);
  };
  const spawnBot = (): void => {
    const bots = t.sim.actors.filter((a) => a.kind === 'bot').length;
    if (bots >= MAX_BOTS) { hud.feed(`Bot limit reached (${MAX_BOTS})`, false); return; }
    const a = addBot(t, cfg.level);
    makeView(a);
    brains.set(a.id, new BotBrain(BOT_PROFILES[cfg.level], Math.floor(Math.random() * 1e9), a.view.yaw));
    hud.feed(`${a.name} joined with the ${WEAPONS[a.rack[0]!.id].name}`, false);
  };
  const removeBot = (): void => {
    const bots = t.sim.actors.filter((a) => a.kind === 'bot');
    const b = bots[bots.length - 1];
    if (!b) { hud.feed('No bots to remove', false); return; }
    t.sim.removeActor(b.id); dropView(b.id); brains.delete(b.id);
    hud.feed(`${b.name} left`, false);
  };
  const apply = (): void => {
    for (const id of [...views.keys()]) dropView(id);
    brains.clear();
    pickupViews.clear();
    t = createTraining(1 + Math.floor(Math.random() * 1e6), { weapon: cfg.weapon });
    for (const a of t.sim.actors) makeView(a);
    for (let i = 0; i < cfg.bots; i++) spawnBot();
    input.yaw = t.player.view.yaw; input.pitch = 0.1;
    firstHit.clear(); killer = ''; last = { text: 'none yet', ttk: '' };
    hud.deathScreen(false);
  };
  apply();

  const setWeapon = (id: (typeof TRAINING_RACK)[number]): void => {
    cfg.weapon = id;
    t.player.loadout = [id]; // applied when you next respawn (the sim rebuilds your rack from this)
    onCfg();
  };

  input.onCommand = (c: Command): void => {
    if (c === 'addBot') spawnBot();
    else if (c === 'removeBot') removeBot();
    else if (c === 'botLevel') { cfg.level = cfg.level === 'easy' ? 'medium' : cfg.level === 'medium' ? 'hard' : 'easy'; hud.feed(`New bots will be ${cfg.level}`, false); onCfg(); }
    else if (c === 'reset') apply();
    else if (c === 'repeat') { input.holdToFire = !input.holdToFire; hud.feed(input.holdToFire ? 'Hold to fire: on (all weapons)' : 'Hold to fire: off (one click per shot for non-auto)', false); }
  };

  // --- events ---------------------------------------------------------------
  const tmpV = new THREE.Vector3(), tmpM = new THREE.Vector3(), tmpP = new THREE.Vector3();
  const nameOf = (id: string | null): string => (id === null ? 'the void' : t.sim.actor(id)?.name ?? id);

  const handle = (e: CombatEvent): void => {
    const me = t.player;
    switch (e.type) {
      case 'shot': {
        const v = views.get(e.actor);
        v?.character.fire();
        const from = v ? v.character.muzzleWorld(tmpM) : tmpM.set(e.origin.x, e.origin.y, e.origin.z);
        for (const p of e.pellets) {
          vfx.tracer(from, p.point);
          if (p.kind !== 'miss') vfx.impact(p.point, p.kind === 'body' || p.kind === 'head');
        }
        break;
      }
      case 'hit': {
        if (e.shooter !== me.id) break;
        hud.hitMarker(e.killed ? 'kill' : e.head ? 'head' : 'hit');
        const victim = t.sim.actor(e.victim);
        if (victim && e.damage > 0) {
          tmpV.set(victim.body.pos.x, victim.body.pos.y + 1.5, victim.body.pos.z).project(camera);
          if (tmpV.z < 1) hud.damageNumber((tmpV.x * 0.5 + 0.5) * innerWidth, (-tmpV.y * 0.5 + 0.5) * innerHeight, e.damage, e.head);
          const fh = firstHit.get(e.victim);
          if (!fh || t.sim.time - fh.lastT > 2) firstHit.set(e.victim, { t0: t.sim.time, lastT: t.sim.time });
          else fh.lastT = t.sim.time;
        }
        last.text = `${e.damage.toFixed(1)} dmg · ${e.dist.toFixed(1)} m · x${e.falloff.toFixed(2)} falloff · ${e.head ? 'HEAD' : 'body'} · ${WEAPONS[e.weapon].name}`;
        if (e.killed) {
          const fh = firstHit.get(e.victim);
          last.ttk = fh ? `${(t.sim.time - fh.t0).toFixed(2)} s` : '';
          firstHit.delete(e.victim);
        }
        break;
      }
      case 'damage': {
        if (e.victim !== me.id) break;
        const yaw = input.yaw;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
        hud.damageArc(Math.atan2(e.dirX * rx + e.dirZ * rz, e.dirX * fx + e.dirZ * fz));
        break;
      }
      case 'kill': {
        const w = e.weapon ? WEAPONS[e.weapon].name : 'the world';
        hud.feed(`${nameOf(e.killer)} eliminated ${nameOf(e.victim)} [${w}${e.head ? ', headshot' : ''}]`, e.killer === me.id);
        const v = views.get(e.victim);
        if (v) v.deadT = 0;
        if (e.victim === me.id) killer = nameOf(e.killer);
        break;
      }
      case 'pickup':
        if (e.actor === me.id) hud.feed(`Picked up ${RARITY[e.rarity]?.name ?? ''} ${WEAPONS[e.weapon].name}`, false);
        break;
      case 'weaponEmpty':
        if (e.actor === me.id) hud.feed('Floor weapon empty: back to your own weapon', false);
        break;
      case 'respawn': {
        const v = views.get(e.actor);
        if (v) v.deadT = -1;
        if (e.actor === me.id) { input.yaw = e.yaw; input.pitch = 0.1; killer = ''; }
        break;
      }
      default: break;
    }
  };

  // --- main loop ------------------------------------------------------------
  const dt = 1 / SIM.tickHz;
  let prevTime = performance.now(), fps = 60;
  const rig = newRig();
  const inputs = new Map<string, ActorInput>();
  let lastFov: number = CAMERA.baseFovDeg;

  const syncPose = (a: Actor, v: ActorView, alpha: number): void => {
    const p = v.pose, b = a.body;
    p.pos.x = a.prev.x + (b.pos.x - a.prev.x) * alpha;
    p.pos.y = a.prev.y + (b.pos.y - a.prev.y) * alpha;
    p.pos.z = a.prev.z + (b.pos.z - a.prev.z) * alpha;
    p.vel.x = b.vel.x; p.vel.y = b.vel.y; p.vel.z = b.vel.z;
    p.onGround = b.onGround; p.crouched = b.crouched; p.sprinting = b.sprinting;
    p.rollT = b.rollT; p.rollDirX = b.rollDirX; p.rollDirZ = b.rollDirZ;
  };

  const tick = (): void => {
    const me = t.player;
    // while dead the number keys choose the weapon for your next life; the wheel is ignored
    const mine = input.sample(me.slot, me.hp.alive ? me.rack.length : 0);
    if (!me.hp.alive && mine.slot !== null) {
      const id = TRAINING_RACK[mine.slot];
      if (id) setWeapon(id);
      mine.slot = null;
    }
    if (me.hp.alive) {
      // the camera sits beside and behind the eye: aim the bullet through whatever the crosshair is on
      const ws = me.rack[me.slot]!;
      computeCamera(world, me.body.pos, eyeHeightOf(me.body), input.yaw + me.recoil.yaw, clamp(input.pitch + me.recoil.pitch, -1.35, 1.35), ws.adsT, rig);
      const eye = { x: me.body.pos.x, y: me.body.pos.y + eyeHeightOf(me.body), z: me.body.pos.z };
      const aim = convergeAim(world, rig.pos, rig.dir, eye, t.sim.targetsFor(me));
      mine.aimYaw = aim.yaw - me.recoil.yaw; mine.aimPitch = aim.pitch - me.recoil.pitch;
    }
    inputs.clear();
    inputs.set(me.id, mine);
    for (const [id, brain] of brains) {
      const bot = t.sim.actor(id);
      if (bot) inputs.set(id, brain.think(bot, t.sim.actors, world, dt, t.sim.pickups));
    }
    t.sim.step(dt, inputs);
    for (const e of t.sim.drainEvents()) handle(e);
  };

  const reported = new Set<string>();
  const frame = (now: number): void => {
    requestAnimationFrame(frame); // queued first so one bad frame can never freeze the game
    try {
      frameBody(now);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!reported.has(msg)) { reported.add(msg); console.error('frame error:', err); hud.feed(`Internal error: ${msg}`, false); }
    }
  };
  const frameBody = (now: number): void => {
    const real = Math.min(0.1, (now - prevTime) / 1000); prevTime = now;
    fps += (1 / Math.max(real, 1e-3) - fps) * 0.05;
    if (capture.playing) {
      accum += real;
      while (accum >= dt) { tick(); accum -= dt; }
    } else accum = 0; // paused: the simulation is frozen until the mouse is captured again

    const me = t.player;
    const alpha = accum / dt;
    const ws = me.rack[me.slot] ?? me.rack[0]!;
    const def = WEAPONS[ws.id];
    for (const a of t.sim.actors) {
      const v = views.get(a.id);
      if (!v) continue;
      syncPose(a, v, alpha);
      if (v.deadT >= 0) v.deadT += capture.playing ? real : 0;
      const cur = a.rack[a.slot] ?? a.rack[0]!;
      v.character.setWeapon(WEAPONS[cur.id].modelId);
      v.character.update(v.pose, a.id === me.id ? input.yaw : a.view.yaw, capture.playing ? real : 0, {
        armed: true, pitch: a.id === me.id ? input.pitch : a.view.pitch,
        reloading: cur.reloading, deadT: a.hp.alive ? -1 : Math.max(0, v.deadT),
      });
      if (v.bar) v.bar.update(tmpP.set(v.pose.pos.x, v.pose.pos.y + 2.25, v.pose.pos.z), a.hp.hp / COMBAT.maxHealth, camera, a.hp.alive);
    }
    vfx.update(capture.playing ? real : 0);
    pickupViews.update(t.sim.pickups, capture.playing ? real : 0, now / 1000);

    // camera: over-the-shoulder, with recoil and aim zoom
    const mv = views.get(me.id)!.pose;
    const camYaw = input.yaw + me.recoil.yaw, camPitch = clamp(input.pitch + me.recoil.pitch, -1.35, 1.35);
    computeCamera(world, mv.pos, eyeHeightOf(me.body), camYaw, camPitch, ws.adsT, rig);
    camera.position.set(rig.pos.x, rig.pos.y, rig.pos.z);
    camera.rotation.set(camPitch, camYaw, 0, 'YXZ');
    const fov = fovDeg(def, ws.adsT);
    if (Math.abs(fov - lastFov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); lastFov = fov; }
    const scoped = def.adsFovMult <= 0.3 && ws.adsT > 0.85 && me.hp.alive;
    views.get(me.id)!.character.root.visible = !scoped;
    renderer.render(scene, camera);

    // HUD
    const spread = currentSpreadDeg(def, ws.adsT, motionOf(me.body));
    const gapPx = (Math.tan(spread * DEG) / Math.tan((fov * DEG) / 2)) * (innerHeight / 2);
    const fi = floorSlot(me);
    hud.update({
      hp: me.hp.hp, alive: me.hp.alive, protectedNow: me.hp.protectT > 0, stamina: me.body.stamina, rollCd: Math.max(0, me.body.rollCd),
      weaponName: `${RARITY[ws.rarity]?.name === 'Common' ? '' : `${RARITY[ws.rarity]?.name} `}${def.name}`,
      mag: ws.mag, reserve: ws.reserve, magSize: ws.magSize,
      reloadFrac: ws.reloading ? 1 - clamp(ws.reloadT / def.reloadSec, 0, 1) : -1,
      slots: me.rack.map((w, i) => ({ label: slotLabel(w, i === fi), active: i === me.slot })), gapPx, scoped,
      debug: `${fps.toFixed(0)} fps · spread ${spread.toFixed(2)}° · recoil ${(me.recoil.pitch / DEG).toFixed(1)}° · pos ${me.body.pos.x.toFixed(1)}, ${me.body.pos.z.toFixed(1)}`,
    });
    const near = me.hp.alive && me.nearPickup !== null ? t.sim.pickups.find((p) => p.id === me.nearPickup) : undefined;
    hud.prompt(near?.state && fi >= 0 ? `[E] swap for ${RARITY[near.state.rarity]?.name} ${WEAPONS[near.state.id].name} (${near.state.mag}/${near.state.reserve})` : null);

    const board = [...t.sim.actors].sort((a, b) => b.stats.kills - a.stats.kills || a.stats.deaths - b.stats.deaths).slice(0, 6)
      .map((a) => `${a.id === me.id ? '▶ ' : '   '}${a.name}  ${a.stats.kills} / ${a.stats.deaths}`);
    const s = me.stats;
    hud.train([
      'Kills / deaths', ...board, '',
      `Shots ${s.shotsFired} · Hits ${s.shotsHit} (${s.shotsFired ? Math.round((100 * s.shotsHit) / s.shotsFired) : 0}%) · Head ${s.headshots}`,
      `Last hit: ${last.text}`,
      last.ttk ? `Last time-to-kill: ${last.ttk}` : 'Last time-to-kill: n/a',
      `Hold to fire: ${input.holdToFire ? 'on' : 'off'} (H) · Bots: ${brains.size} · new bots: ${cfg.level}`,
    ]);
    if (me.hp.alive) hud.deathScreen(false);
    else {
      const choices = TRAINING_RACK.map((id, i) => `${i + 1} ${WEAPONS[id].name}`).join(' · ');
      hud.deathScreen(true, killer ? `Eliminated by ${killer}` : 'Eliminated',
        `Respawning in ${Math.max(0, me.hp.respawnT).toFixed(1)} s · next weapon: ${WEAPONS[me.loadout[0]!].name} · press ${choices}`);
    }
  };
  requestAnimationFrame(frame);

  // read-only view of the sim for e2e tests and debugging
  (window as unknown as Record<string, unknown>).__game = {
    state: () => t.player.body, sim: () => t.sim, player: PLAYER_ID, capture: () => capture.state,
  };
  return { apply, setWeapon, addBot: spawnBot, removeBot, botCount: () => brains.size };
}
