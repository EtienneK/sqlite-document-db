import { MongoMemoryServer } from 'mongodb-memory-server'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  interface ProvidedContext {
    mongoUri: string
  }
}

/**
 * Boots a single MongoDB instance for the entire test run.
 *
 * Every spec compares this library's behaviour against a real MongoDB, and
 * spawning a mongod per spec (let alone per test) dominated the runtime. One
 * server is shared instead; specs isolate themselves by using their own
 * database on it - see test/helpers/dual-dbs.ts.
 */
export default async function setup (project: TestProject): Promise<() => Promise<void>> {
  const mongod = await MongoMemoryServer.create()
  project.provide('mongoUri', mongod.getUri())

  return async () => {
    await mongod.stop()
  }
}
