# Decisions

| # | Decision | Alternatives | Reason |
|---|---|---|---|
| 1 | `@arena/shared` exports TypeScript source directly (no pre-build). | Build to `dist` with tsc. | Vite, tsx and Vitest all consume TS directly; avoids a build-order step in `pnpm dev`. Revisit for Docker production image if needed. |
| 2 | Server runs via `tsx` in dev and prod for now. | Compile to JS. | Simplest for Phase 0; production compile step is added in Phase 12. |
| 3 | ESLint 9 flat config with typescript-eslint recommended. | Legacy `.eslintrc`. | Legacy format is deprecated in ESLint 9. |
