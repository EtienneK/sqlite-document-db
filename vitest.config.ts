import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // These specs were written against Jest's global describe/it/expect. Vitest
    // is API-compatible, so exposing the globals keeps them unchanged.
    globals: true,
    // Every spec boots its own in-memory MongoDB to compare against, which is
    // slow to start and hungry for RAM. Run files sequentially and give the
    // hooks room to download/spawn mongod on a cold cache.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
})
