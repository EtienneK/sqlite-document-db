import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // These specs were written against Jest's global describe/it/expect. Vitest
    // is API-compatible, so exposing the globals keeps them unchanged.
    globals: true,
    // Boots one mongod for the whole run and shares its URI with every spec.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000
  }
})
