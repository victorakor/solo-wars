/** Single source of truth for tunable numbers (grows each phase). */
export const SIM = {
  tickHz: 60,
  inputSendHz: 30,
  snapshotHz: 20,
  interpDelayMs: 100,
  maxRewindMs: 250,
} as const;

export const MOVE = {
  radius: 0.4,
  heightStand: 1.8,
  heightCrouch: 1.2,
  eyeStand: 1.6,
  eyeCrouch: 1.05,
  walk: 5.0,
  sprint: 7.5,
  crouch: 2.5,
  adsMult: 0.7,
  jumpSpeed: 6.5,
  gravity: 20,
  terminalFall: 40,
  airControl: 0.3,
  accelTime: 0.12,
  stopTime: 0.1,
  maxStep: 0.4,
  stamina: { max: 100, drain: 20, regen: 15, regenDelay: 1, minToStart: 15 },
  sprintRecovery: 0.15,
  roll: { duration: 0.45, speed: 5.5, cooldown: 2.0 },
} as const;
