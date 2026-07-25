import { defineConfig } from 'vitest/config'

// Type tests assert on types, never execute, and need no database - so this
// config omits the mongod globalSetup that vitest.config.ts boots for the
// parity specs. Run with: npm run test:types
//
// `npm run typecheck` already compiles these files, which is what validates
// the @ts-expect-error directives (tsc errors on an unused one). This config
// adds the expectTypeOf assertions and per-case reporting on top.
export default defineConfig({
  test: {
    globals: true,
    include: [],
    typecheck: {
      enabled: true,
      only: true,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.json'
    }
  }
})
