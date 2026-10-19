import { startGame } from './game/game';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;
startGame(canvas, hud);
