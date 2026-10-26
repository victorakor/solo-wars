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

// ---------------------------------------------------------------------------
// Phase 2: combat. All values are starting points and meant to be tuned here.
// ---------------------------------------------------------------------------

export const DEG = Math.PI / 180;

/** Hit detection volumes (spec 5.1). */
export const HITBOX = { headRadius: 0.22, bodyRadius: 0.4 } as const;

export const COMBAT = {
  maxHealth: 100,
  respawnSec: 3,
  spawnProtectSec: 2,
  /** Last damager within this window gets the kill when the death has no direct attacker. */
  killCreditSec: 5,
  /** Hitscan rays stop here. */
  maxRange: 200,
  /** A semi/bolt/pump press made this early during a cooldown still fires when it ends. */
  fireBufferSec: 0.12,
  /** Empty-mag trigger pull: click, then this lockout so held auto fire does not spam. */
  dryClickSec: 0.25,
  /** Players below this height are out of the world (safety net until kill volumes in Phase 5). */
  killY: -8,
  spread: {
    /** Horizontal speed above which the player counts as moving. */
    movingSpeed: 0.5,
    moveMult: 1.25,
    airMult: 2.0,
    crouchMult: 0.75,
  },
  recoil: {
    /** Recovery starts this long after the last shot (or 1.25 shot intervals, whichever is longer). */
    holdMinSec: 0.1,
    maxPitchDeg: 15,
    maxYawDeg: 8,
  },
} as const;

export type WeaponCategory = 'firearm' | 'melee' | 'throwable';
export type FireMode = 'semi' | 'auto' | 'bolt' | 'pump';
export type WeaponId = 'sidearm' | 'rattler' | 'vanguard' | 'breaker' | 'longshot';

/**
 * Data-driven weapon definition (spec 6.2). Angles are degrees, times are seconds.
 * Phase 2 covers hitscan firearms; projectile and melee fields are added in Phase 4.
 */
export interface WeaponDef {
  id: WeaponId;
  name: string;
  category: WeaponCategory;
  fireMode: FireMode;
  /** Damage per bullet (per pellet for shotguns). */
  damage: number;
  headMult: number;
  rpm: number;
  magSize: number;
  /** Reserve when picked up from the floor. The custom weapon (slot 1) always has unlimited reserve. */
  reserveAmmo: number | null;
  reloadSec: number;
  /** True: reloadSec is per shell and a reload can be interrupted by firing. */
  reloadPerShell: boolean;
  equipSec: number;
  /** Cone half-angle of the aim spread. */
  spreadHip: number;
  spreadAds: number;
  adsFovMult: number;
  adsSeconds: number;
  recoilPitch: number;
  recoilYaw: number;
  /** Degrees per second back towards the aim point once recovery starts. */
  recoilRecovery: number;
  pellets: number;
  /** Extra per-pellet cone half-angle on top of the aim spread. 0 for single bullets. */
  pelletSpread: number;
  falloffStart: number;
  falloffEnd: number;
  minDamageMult: number;
  moveSpeedMult: number;
  modelId: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  sidearm: {
    id: 'sidearm', name: 'Sidearm', category: 'firearm', fireMode: 'semi',
    damage: 22, headMult: 1.6, rpm: 360, magSize: 12, reserveAmmo: 48,
    reloadSec: 1.4, reloadPerShell: false, equipSec: 0.3,
    spreadHip: 1.4, spreadAds: 0.2, adsFovMult: 0.85, adsSeconds: 0.12,
    recoilPitch: 1.0, recoilYaw: 0.3, recoilRecovery: 10,
    pellets: 1, pelletSpread: 0,
    falloffStart: 25, falloffEnd: 55, minDamageMult: 0.6,
    moveSpeedMult: 1.0, modelId: 'sidearm',
  },
  rattler: {
    id: 'rattler', name: 'Rattler', category: 'firearm', fireMode: 'auto',
    damage: 13, headMult: 1.4, rpm: 780, magSize: 30, reserveAmmo: 120,
    reloadSec: 1.9, reloadPerShell: false, equipSec: 0.4,
    spreadHip: 3.6, spreadAds: 1.1, adsFovMult: 0.85, adsSeconds: 0.14,
    recoilPitch: 0.35, recoilYaw: 0.25, recoilRecovery: 14,
    pellets: 1, pelletSpread: 0,
    falloffStart: 15, falloffEnd: 35, minDamageMult: 0.5,
    moveSpeedMult: 0.98, modelId: 'rattler',
  },
  vanguard: {
    id: 'vanguard', name: 'Vanguard', category: 'firearm', fireMode: 'auto',
    damage: 20, headMult: 1.5, rpm: 600, magSize: 30, reserveAmmo: 90,
    reloadSec: 2.2, reloadPerShell: false, equipSec: 0.5,
    spreadHip: 2.4, spreadAds: 0.3, adsFovMult: 0.75, adsSeconds: 0.2,
    recoilPitch: 0.45, recoilYaw: 0.3, recoilRecovery: 11,
    pellets: 1, pelletSpread: 0,
    falloffStart: 30, falloffEnd: 70, minDamageMult: 0.65,
    moveSpeedMult: 0.95, modelId: 'vanguard',
  },
  breaker: {
    id: 'breaker', name: 'Breaker', category: 'firearm', fireMode: 'pump',
    damage: 9, headMult: 1.3, rpm: 70, magSize: 6, reserveAmmo: 24,
    reloadSec: 0.5, reloadPerShell: true, equipSec: 0.6,
    spreadHip: 0.8, spreadAds: 0.4, adsFovMult: 0.9, adsSeconds: 0.18,
    recoilPitch: 5.0, recoilYaw: 0.6, recoilRecovery: 8,
    pellets: 8, pelletSpread: 4,
    falloffStart: 6, falloffEnd: 18, minDamageMult: 0.2,
    moveSpeedMult: 0.93, modelId: 'breaker',
  },
  longshot: {
    id: 'longshot', name: 'Longshot', category: 'firearm', fireMode: 'bolt',
    damage: 95, headMult: 150 / 95, rpm: 45, magSize: 4, reserveAmmo: 12,
    reloadSec: 3.0, reloadPerShell: false, equipSec: 0.8,
    spreadHip: 6.0, spreadAds: 0.03, adsFovMult: 0.25, adsSeconds: 0.35,
    recoilPitch: 3.5, recoilYaw: 0.5, recoilRecovery: 6,
    pellets: 1, pelletSpread: 0,
    falloffStart: 100, falloffEnd: 200, minDamageMult: 1,
    moveSpeedMult: 0.85, modelId: 'longshot',
  },
};

/** Every firearm. These are what you can pick as your loadout weapon and what floor pads can roll. */
export const TRAINING_RACK: readonly WeaponId[] = ['sidearm', 'rattler', 'vanguard', 'breaker', 'longshot'];

/** Floor weapon rarity (spec 6.3): damage and magazine multipliers, roll weight, beam colour. */
export const RARITY = [
  { name: 'Common', dmg: 1, mag: 1, weight: 60, color: 0xffffff },
  { name: 'Rare', dmg: 1.15, mag: 1.1, weight: 30, color: 0x4a9eff },
  { name: 'Epic', dmg: 1.3, mag: 1.2, weight: 10, color: 0xb44aff },
] as const;

export const PICKUPS = {
  /** Walk-over and swap distance (spec 7). */
  radius: 1.5,
  /** Practice range: first drops appear quickly (the spec's 10 s applies to real matches). */
  firstSpawnSec: 3,
  padRespawnSec: 25,
  dropDespawnSec: 15,
  /** The held floor weapon drops where you die. */
  dropOnDeath: true,
  /** Short lockout after taking or swapping so one press cannot do two things. */
  cooldownSec: 0.4,
  maxDrops: 24,
} as const;

export type BotLevel = 'easy' | 'medium' | 'hard';

/** Bot difficulty knobs (angles in degrees, turn rate in degrees per second). */
export interface BotProfile {
  level: BotLevel;
  reactionSec: number;
  turnRate: number;
  aimErrorDeg: number;
  /** 0..1: how much of the weapon's recoil kick the bot cancels out. */
  aimComp: number;
  burstMin: number; burstMax: number;
  pauseMin: number; pauseMax: number;
  strafeMin: number; strafeMax: number;
  rangeMin: number; rangeMax: number;
  fireConeDeg: number;
  /** Aims down sights beyond this distance. */
  adsRange: number;
  /** Chance to roll away when it takes damage while it can see its target (roll cooldown permitting). */
  dodgeChance: number;
  /** Jumps per second while strafing in a fight. */
  jumpiness: number;
  /** 0..1: how hard it pushes when its target is reloading or hurt, and how long it holds before backing off. */
  aggression: number;
}

export const BOT_PROFILES: Record<BotLevel, BotProfile> = {
  easy: {
    level: 'easy', reactionSec: 0.6, turnRate: 150, aimErrorDeg: 3.5, aimComp: 0.3,
    burstMin: 0.25, burstMax: 0.5, pauseMin: 0.6, pauseMax: 1.2, strafeMin: 0.8, strafeMax: 1.6,
    rangeMin: 10, rangeMax: 22, fireConeDeg: 5, adsRange: Infinity,
    dodgeChance: 0.15, jumpiness: 0, aggression: 0.3,
  },
  medium: {
    level: 'medium', reactionSec: 0.35, turnRate: 260, aimErrorDeg: 1.8, aimComp: 0.6,
    burstMin: 0.4, burstMax: 0.9, pauseMin: 0.35, pauseMax: 0.8, strafeMin: 0.6, strafeMax: 1.3,
    rangeMin: 10, rangeMax: 25, fireConeDeg: 3.5, adsRange: 25,
    dodgeChance: 0.4, jumpiness: 0.15, aggression: 0.6,
  },
  hard: {
    level: 'hard', reactionSec: 0.18, turnRate: 420, aimErrorDeg: 0.8, aimComp: 0.85,
    burstMin: 0.6, burstMax: 1.4, pauseMin: 0.2, pauseMax: 0.5, strafeMin: 0.4, strafeMax: 1.0,
    rangeMin: 12, rangeMax: 28, fireConeDeg: 2.5, adsRange: 18,
    dodgeChance: 0.7, jumpiness: 0.35, aggression: 0.9,
  },
};

// ---------------------------------------------------------------------------
// Phase 3: netcode (spec 4 and 9)
// ---------------------------------------------------------------------------

export const NET = {
  /** Each input batch (sent at 30 Hz for 60 Hz inputs) carries the last this-many inputs, so every input rides in two batches. */
  inputRedundancy: 4,
  /** If a snapshot is late, remote entities are extrapolated along their velocity for at most this long, then held. */
  extrapolateMs: 100,
  /** Hitbox history kept on the server. */
  historyMs: 1000,
  /** Reconciliation: smooth below this error (metres), hard snap at or above. */
  reconcileSnapM: 1.5,
  /** Time constant (s) at which the smoothed correction bleeds off. */
  errorDecaySec: 0.1,
  /** Server input queue cap per player. */
  inputQueueMax: 12,
  /** Catch-up allowance: a player may process this many inputs beyond real time after a lag spike. */
  inputCreditsMax: 8,
  pingIntervalMs: 2000,
  /** No traffic for this long means the connection is considered lost. */
  silenceMs: 3000,
  /** The match pauses this long waiting for a dropped player, then they forfeit. */
  reconnectSec: 30,
  /** Per-client message budget per second before messages are dropped. */
  maxInMessagesPerSec: 80,
  maxPingsPerSec: 4,
  /** Sustained violations beyond this many dropped messages in a row get the client kicked. */
  kickAfterDropped: 600,
  warnRttMs: 200,
  warnLossPct: 5,
  /** Each extra actor costs about 3 kbps downstream, so 2 humans + 2 bots is the most that fits the 30 kbps budget. */
  maxHumans: 2,
  maxBots: 2,
  /** Downstream and upstream budgets (kbps), asserted in tests. */
  budgetDownKbps: 30,
  budgetUpKbps: 15,
} as const;
