import { startGame } from './game/game';
import { MouseCapture, domLockApi } from './game/capture';
import { Hud } from './game/hud';
import { Menu } from './game/menu';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const capture = new MouseCapture(domLockApi(canvas));

// Pointer lock is requested only from the menu's Play/Resume (or the P key). These handlers make sure
// the mouse always comes back: the browser's Esc, switching window or tab, leaving the page, or P.
document.addEventListener('pointerlockchange', () => capture.lockChanged(document.pointerLockElement === canvas));
document.addEventListener('pointerlockerror', () => capture.lockFailed());
addEventListener('blur', () => capture.focusLost());
addEventListener('pagehide', () => capture.focusLost());
document.addEventListener('visibilitychange', () => { if (document.hidden) capture.focusLost(); });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && !e.repeat) { e.preventDefault(); capture.toggle(); }
});

const menu = new Menu(capture);
const game = startGame(canvas, new Hud(), capture, menu.config, () => menu.render());
menu.handlers = {
  apply: game.apply,
  weaponChanged: game.setWeapon,
  addBot: game.addBot,
  removeBot: game.removeBot,
  botCount: game.botCount,
  joinOnline: game.joinOnline,
  isOnline: game.isOnline,
};
