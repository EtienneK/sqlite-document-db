import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  interface ProvidedContext {
    mongoUri: string
    mongoReplicaSetUri: string
  }
}

/** Spawning mongod can flake (port contention, slow first extraction); retry. */
async function boot <T>(create: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await create()
    } catch (error) {
      if (attempt >= 3) throw error
    }
  }
}

/**
 * Boots the MongoDB instances the whole test run shares.
 *
 * Every spec compares this library's behaviour against a real MongoDB, and
 * spawning a mongod per spec (let alone per test) dominated the runtime. One
 * server is shared instead; specs isolate themselves by using their own
 * database on it - see test/helpers/dual-dbs.ts.
 *
 * **There are two of them, and the difference is load-bearing.** MongoDB
 * refuses transactions on a standalone mongod ("Transaction numbers are only
 * allowed on a replica set member or mongos"), so test/client-session.spec.ts
 * would have had no oracle for the half of item 25 that matters. A one-node
 * replica set fixes that and costs about 30ms to start - but every write to it
 * is slower, and pointing the WHOLE suite at one took the run from 1.6s to 8.3s
 * (measured). So the replica set is provided separately and only the session
 * spec injects it.
 */
export default async function setup (project: TestProject): Promise<() => Promise<void>> {
  const [mongod, replicaSet] = await Promise.all([
    boot(async () => await MongoMemoryServer.create()),
    boot(async () => await MongoMemoryReplSet.create({ replSet: { count: 1 } }))
  ])
  project.provide('mongoUri', mongod.getUri())
  project.provide('mongoReplicaSetUri', replicaSet.getUri())

  return async () => {
    await mongod.stop()
    await replicaSet.stop()
  }
}
