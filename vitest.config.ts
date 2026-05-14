import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      // Operational scripts (migration tooling) keep their tests
      // alongside the source so the algorithm and the test fixture stay
      // in lockstep. Pure ESM (no TS / no Vite transform required).
      'scripts/__tests__/**/*.test.mjs',
    ],
    environment: 'node',
  },
});
