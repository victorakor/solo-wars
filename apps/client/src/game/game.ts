import * as THREE from 'three';
import { CollisionWorld, FOUNDRY, MOVE, SIM, clonePlayer, eyeHeightOf, newPlayer, stepPlayer, type PlayerState } from '@arena/shared';
import { Character } from './character';
import { DesktopInput } from './input';
import { buildScene } from './scene';

export function startGame(canvas: HTMLCanvasElement, hud: HTMLElement): void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(80, 1, 0.1, 200);
  buildScene(FOUNDRY, scene);
  const world = new CollisionWorld(FOUNDRY.boxes);
  const input = new DesktopInput(canvas);
  const sp = FOUNDRY.spawns[0]!;
  const state: PlayerState = newPlayer(sp.x, sp.y + 0.05, sp.z); let prev = clonePlayer(state);
  input.yaw = sp.yaw;
  const me = new Character(); scene.add(me.root);
  const resize = (): void => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();

  const dt = 1 / SIM.tickHz; let acc = 0, last = performance.now(), fps = 60, lastYaw = input.yaw;
  const tmp = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();
  const frame = (now: number): void => {
    const real = Math.min(0.1, (now - last) / 1000); last = now; fps += (1 / Math.max(real, 1e-3) - fps) * 0.05;
    acc += real;
    while (acc >= dt) { prev = clonePlayer(state); const inp = input.sample(); lastYaw = inp.yaw; stepPlayer(state, inp, dt, world); acc -= dt; }
    const a = acc / dt; // render interpolation between sim ticks
    const view = clonePlayer(state);
    view.pos.x = prev.pos.x + (state.pos.x - prev.pos.x) * a; view.pos.y = prev.pos.y + (state.pos.y - prev.pos.y) * a; view.pos.z = prev.pos.z + (state.pos.z - prev.pos.z) * a;
    me.update(view, lastYaw, real);

    // third-person camera over the right shoulder, pulled in by geometry
    const yaw = input.yaw, pitch = input.pitch, cp = Math.cos(pitch);
    fwd.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp); right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const pivot = tmp.set(view.pos.x, view.pos.y + eyeHeightOf(state), view.pos.z).clone();
    const want = pivot.clone().addScaledVector(fwd, -3.4).addScaledVector(right, 0.75).add(new THREE.Vector3(0, 0.2, 0));
    const dir = want.clone().sub(pivot); const len = dir.length(); dir.normalize();
    const hit = world.raycast(pivot, dir, len + 0.3);
    camera.position.copy(pivot).addScaledVector(dir, hit === null ? len : Math.max(0.4, hit - 0.3));
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    renderer.render(scene, camera);

    const sec = Math.max(0, state.rollCd);
    hud.innerHTML = `<div class="bar"><i style="width:${state.stamina}%"></i></div><div class="roll">Roll ${sec > 0 ? sec.toFixed(1) + 's' : 'ready'}</div>` +
      `<div class="dbg">${fps.toFixed(0)} fps · pos ${state.pos.x.toFixed(1)}, ${state.pos.y.toFixed(1)}, ${state.pos.z.toFixed(1)} · ${state.sprinting ? 'sprint' : state.crouched ? 'crouch' : 'walk'}</div>`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // test hook for e2e (read-only view of sim state)
  (window as unknown as Record<string, unknown>).__game = { state: () => state, maxStep: MOVE.maxStep };
}
