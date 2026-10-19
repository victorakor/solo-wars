import { describe, expect, it } from 'vitest';
import { PingSchema, SIM } from './index';

describe('shared', () => {
  it('uses the spec tick rates', () => {
    expect(SIM.tickHz).toBe(60);
    expect(SIM.snapshotHz).toBe(20);
  });
  it('rejects malformed ping payloads', () => {
    expect(PingSchema.safeParse({ t: 1 }).success).toBe(true);
    expect(PingSchema.safeParse({ t: 'x' }).success).toBe(false);
    expect(PingSchema.safeParse(null).success).toBe(false);
  });
});
