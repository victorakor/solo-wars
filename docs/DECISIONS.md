# Decisions

| # | Decision | Alternatives | Reason |
|---|---|---|---|
| 1 | `@arena/shared` exports TypeScript source directly (no pre-build). | Build to `dist` with tsc. | Vite, tsx and Vitest all consume TS directly; avoids a build-order step in `pnpm dev`. Revisit for Docker production image if needed. |
| 2 | Server runs via `tsx` in dev and prod for now. | Compile to JS. | Simplest for Phase 0; production compile step is added in Phase 12. |
| 3 | ESLint 9 flat config with typescript-eslint recommended. | Legacy `.eslintrc`. | Legacy format is deprecated in ESLint 9. |
| 4 | Player collider is a vertical **AABB** (0.8 m square footprint) for world collision; the capsule is used for hit detection from Phase 4. | True capsule-vs-AABB sweep. | Axis-separated AABB sweeps cannot tunnel or snag on box seams, are fully deterministic, and are cheap enough to run for prediction. Slight corner conservatism (~0.17 m) is acceptable. |
| 5 | Movement sweeps in sub-steps of at most 0.1 m per axis. | Single swept test per tick. | Guarantees no tunnelling at sprint or terminal fall speed; verified by the 10-minute fuzz run. |
| 6 | Foundry catwalks are one deck per long side at y=4 (the bridge height), with 10-step stairs (0.4 m rise, 0.55 m run) at all four corners. | Two stacked catwalk levels per side. | The spec's "two catwalk levels" was read as one per long side; the bridge joins both at 4 m. Revisit when the power-pad layout is tuned in Phase 4/5. |
| 7 | Ray queries scan all boxes linearly for now. | Grid or BVH raycast. | About 100 boxes; fine for one camera ray per frame. Server hitscan needs a grid walk, planned for Phase 4. |
| 8 | Scene geometry is a TypeScript module, not JSON. | JSON scene files. | Keeps stairs generated from rules; export to JSON when more scenes arrive. |
