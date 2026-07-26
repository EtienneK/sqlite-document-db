import { defineConfig } from 'vitest/config'

// The stress suite measures ONLY this library, like the benchmarks, so this
// config omits the mongod globalSetup that vitest.config.ts boots for the
// parity tests. Everything it asserts is a CEILING - "this completes", "this
// stays under N" - never a timing, because a shared runner cannot be held to
// one. Run with: npm run stress
export default defineConfig({
  test: {
    include: ['stress/**/*.stress.ts'],
    globals: true,
    // Deliberately generous: the corpus is deliberately hostile, and a timeout
    // here should mean "this hung", not "this machine is busy".
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One file at a time: the phases share a corpus, and several of them
    // measure memory, which parallel workers would make meaningless.
    fileParallelism: false,
    // The REPORT is the deliverable here - durations, peak RSS, compiled SQL
    // sizes - and vitest hides console output from a passing run by default,
    // which is precisely the run whose numbers someone wants to read.
    disableConsoleIntercept: true
  }
})
