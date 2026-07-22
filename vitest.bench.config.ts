import { defineConfig } from 'vitest/config'

// Benchmarks measure ONLY this library, not the MongoDB oracle, so this
// config deliberately omits the mongod globalSetup that vitest.config.ts
// boots for the parity tests. Run with: npm run bench
export default defineConfig({
  test: {
    benchmark: {
      include: ['bench/**/*.bench.ts']
    }
  }
})
