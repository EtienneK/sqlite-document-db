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
  // Spawning mongod can flake (port contention, slow first extraction);
  // retry a couple of times before giving up on the whole run.
  let mongod: MongoMemoryServer | undefined
  for (let attempt = 1; mongod === undefined; attempt++) {
    try {
      mongod = await MongoMemoryServer.create()
    } catch (error) {
      if (attempt >= 3) throw error
    }
  }
  project.provide('mongoUri', mongod.getUri())

  return async () => {
    await mongod?.stop()
  }
}
