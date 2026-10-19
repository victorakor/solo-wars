/** Single source of truth for tunable numbers (grows each phase). */
export const SIM = {
  tickHz: 60,
  inputSendHz: 30,
  snapshotHz: 20,
  interpDelayMs: 100,
  maxRewindMs: 250,
} as const;
