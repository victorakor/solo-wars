import * as THREE from 'three';
import {
  BOT_PROFILES, COMBAT, DEG, FOUNDRY, SIM, TRAINING_RACK, WEAPONS, BOT_ID, PLAYER_ID, BotBrain, CollisionWorld,
  addBot, clonePlayer, convergeAim, createTraining, currentSpreadDeg, eyeHeightOf, motionOf,
  type Actor, type ActorInput, type BotLevel, type CombatEvent, type PlayerState, type Training,
} from '@arena/shared';
import { computeCamera, fovDeg, newRig, CAMERA } from './camera';
import type { MouseCapture } from './capture';
import { Character } from './character';
import { HealthBar } from './healthbar';
import type { Hud } from './hud';
import { DesktopInput, type Command } from './input';
import { buildScene } from './scene';
import { Vfx } from './vfx';

interface ActorView {
  character: Character;
  bar: HealthBar | null;
  /** Interpolated copy of the body used to pose the model. */
  pose: PlayerState;
  deadT: number;
}

const LEVELS: BotLevel[] = ['easy', 'medium', 'hard'];
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export interface GameHandle {
  /** Rebuilds the training range from scratch (menu "Reset range" and V). */
  reset(): void;
}

export function startGame(canvas: HTMLCanvasElement, hud: Hud, capture: MouseCapture): GameHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA.baseFovDeg, 1, 0.1, 250);
  buildScene(FOUNDRY, scene);
  const world = new CollisionWorld(FOUNDRY.boxes);
  const vfx = new Vfx(scene);
  const input = new DesktopInput(canvas);
  const resize = (): void => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();
  capture.onChange(() => input.setEnabled(capture.playing));

  // --- session state ---------------------------------------------------------
  let infiniteAmmo = true;
  let botLevel: BotLevel = 'medium';
  let t: Training = createTraining(1, infiniteAmmo);
  let brain: BotBrain | null = null;
  const views = new Map<string, ActorView>();
  let killer = '';
  let last = { text: 'none yet', ttk: '' };
  const firstHit = new Map<string, { t0: number; lastT: number }>();
  let accum = 0;

  const makeView = (a: Actor): void => {
    const palette = a.kind === 'dummy' ? [0xb04a3a, 0xf0e0c0] : a.kind === 'bot' ? [0x6a3a8a, 0xe8b04a] : [0x2f6fb5, 0xe8b04a];
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
  const rebuild = (): void => {
    for (const id of [...views.keys()]) dropView(id);
    t = createTraining(1 + Math.floor(Math.random() * 1e6), infiniteAmmo);
    brain = null;
    for (const a of t.sim.actors) makeView(a);
    input.yaw = t.player.view.yaw; input.pitch = 0.1;
    firstHit.clear(); killer = ''; last = { text: 'none yet', ttk: '' };
    hud.deathScreen(false);
  };
  rebuild();

  const toggleBot = (): void => {
    if (t.sim.actor(BOT_ID)) { t.sim.removeActor(BOT_ID); dropView(BOT_ID); brain = null; hud.feed('Bot removed', false); return; }
    const a = addBot(t, botLevel, infiniteAmmo);
    makeView(a);
    brain = new BotBrain(BOT_PROFILES[botLevel], Math.floor(Math.random() * 1e9), a.view.yaw);
    hud.feed(`Bot added (${botLevel})`, false);
  };
  const cycleLevel = (): void => {
    botLevel = LEVELS[(LEVELS.indexOf(botLevel) + 1) % LEVELS.length]!;
    const a = t.sim.actor(BOT_ID);
    if (a) { a.name = `Bot (${botLevel})`; brain = new BotBrain(BOT_PROFILES[botLevel], Math.floor(Math.random() * 1e9), a.view.yaw); }
    hud.feed(`Bot level: ${botLevel}`, false);
  };
  input.onCommand = (c: Command): void => {
    if (c === 'bot') toggleBot();
    else if (c === 'botLevel') cycleLevel();
    else if (c === 'reset') rebuild();
    else if (c === 'repeat') { input.holdToFire = !input.holdToFire; hud.feed(input.holdToFire ? 'Hold to fire: on (all weapons)' : 'Hold to fire: off (one click per shot for non-auto)', false); }
    else if (c === 'ammo') {
      infiniteAmmo = !infiniteAmmo;
      for (const a of t.sim.actors) if (a.kind !== 'dummy') t.sim.restock(a, infiniteAmmo);
      hud.feed(infiniteAmmo ? 'Ammo: infinite reserve (restocked)' : 'Ammo: floor reserves (restocked)', false);
    }
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
    const mine = input.sample(me.slot, me.rack.length);
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
    const bot = t.sim.actor(BOT_ID);
    if (bot && brain) inputs.set(bot.id, brain.think(bot, me, world, dt));
    t.sim.step(dt, inputs);
    for (const e of t.sim.drainEvents()) handle(e);
  };

  const frame = (now: number): void => {
    const real = Math.min(0.1, (now - prevTime) / 1000); prevTime = now;
    fps += (1 / Math.max(real, 1e-3) - fps) * 0.05;
    if (capture.playing) {
      accum += real;
      while (accum >= dt) { tick(); accum -= dt; }
    } else accum = 0; // paused: the simulation is frozen until the mouse is captured again

    const me = t.player;
    const alpha = accum / dt;
    const ws = me.rack[me.slot]!;
    const def = WEAPONS[ws.id];
    for (const a of t.sim.actors) {
      const v = views.get(a.id);
      if (!v) continue;
      syncPose(a, v, alpha);
      if (v.deadT >= 0) v.deadT += capture.playing ? real : 0;
      const wdef = WEAPONS[a.rack[a.slot]!.id];
      v.character.setWeapon(a.kind === 'dummy' ? null : wdef.modelId);
      v.character.update(v.pose, a.id === me.id ? input.yaw : a.view.yaw, capture.playing ? real : 0, {
        armed: a.kind !== 'dummy', pitch: a.id === me.id ? input.pitch : a.view.pitch,
        reloading: a.rack[a.slot]!.reloading, deadT: a.hp.alive ? -1 : Math.max(0, v.deadT),
      });
      if (v.bar) v.bar.update(tmpP.set(v.pose.pos.x, v.pose.pos.y + 2.25, v.pose.pos.z), a.hp.hp / COMBAT.maxHealth, camera, a.hp.alive);
    }
    vfx.update(capture.playing ? real : 0);

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
    hud.update({
      hp: me.hp.hp, alive: me.hp.alive, protectedNow: me.hp.protectT > 0, stamina: me.body.stamina, rollCd: Math.max(0, me.body.rollCd),
      weaponName: def.name, mag: ws.mag, reserve: ws.reserve, magSize: def.magSize,
      reloadFrac: ws.reloading ? 1 - clamp(ws.reloadT / def.reloadSec, 0, 1) : -1,
      slots: me.rack.map((w, i) => ({ label: WEAPONS[w.id].name, active: i === me.slot })), gapPx, scoped,
      debug: `${fps.toFixed(0)} fps · spread ${spread.toFixed(2)}° · recoil ${(me.recoil.pitch / DEG).toFixed(1)}° · pos ${me.body.pos.x.toFixed(1)}, ${me.body.pos.z.toFixed(1)}`,
    });
    const s = me.stats;
    hud.train([
      `Shots ${s.shotsFired} · Hits ${s.shotsHit} (${s.shotsFired ? Math.round((100 * s.shotsHit) / s.shotsFired) : 0}%) · Head ${s.headshots}`,
      `Kills ${s.kills} · Deaths ${s.deaths} · Streak ${s.streak} (best ${s.bestStreak})`,
      `Damage dealt ${s.damageDealt.toFixed(0)} · taken ${s.damageTaken.toFixed(0)}`,
      `Last hit: ${last.text}`,
      last.ttk ? `Last time-to-kill: ${last.ttk}` : 'Last time-to-kill: n/a',
      `Ammo: ${infiniteAmmo ? 'infinite reserve' : 'floor reserves'} · Bot: ${t.sim.actor(BOT_ID) ? botLevel : 'off'}`,
      `Hold to fire: ${input.holdToFire ? 'on' : 'off'} (H)`,
    ]);
    if (me.hp.alive) hud.deathScreen(false);
    else hud.deathScreen(true, killer ? `Eliminated by ${killer}` : 'Eliminated', `Respawning in ${Math.max(0, me.hp.respawnT).toFixed(1)} s`);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // read-only view of the sim for e2e tests and debugging
  (window as unknown as Record<string, unknown>).__game = {
    state: () => t.player.body, sim: () => t.sim, rack: TRAINING_RACK, player: PLAYER_ID, capture: () => capture.state,
  };
  return { reset: rebuild };
}
