import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { Db as Mdb } from 'mongodb'
import { afterAll, afterEach, beforeAll, beforeEach, inject } from 'vitest'
import { Db } from '../../src/index.js'

/**
 * A matched pair of databases: this library, and the real MongoDB it is
 * checked against. Specs run identical assertions through both.
 */
export interface DualDbs {
  sqlite: () => Db
  mongo: () => Mdb
}

export type Seed = (dbs: DualDbs) => Promise<void>

/** Connects to the run-wide mongod, on a database private to this spec file. */
function connectMongo (): () => Mdb {
  // A database per spec file keeps files from seeing each other's writes while
  // they share one server.
  const databaseName = `test_${randomUUID().replaceAll('-', '')}`
  let client: MongoClient
  let mongo: Mdb

  beforeAll(async () => {
    client = await MongoClient.connect(inject('mongoUri'))
    mongo = client.db(databaseName)
  })

  afterAll(async () => {
    await mongo.dropDatabase()
    await client.close()
  })

  return () => mongo
}

/**
 * Empty databases, recreated before every test, then optionally seeded.
 * Use for specs that insert, update or delete.
 */
export function freshDualDbs (seed?: Seed): DualDbs {
  const mongo = connectMongo()
  let sqlite: Db

  const dbs: DualDbs = { sqlite: () => sqlite, mongo }

  beforeEach(async () => {
    await mongo().dropDatabase()
    sqlite = await Db.fromUrl(':memory:')
    await seed?.(dbs)
  })

  afterEach(async () => {
    await sqlite.close()
  })

  return dbs
}

/**
 * Databases seeded once and shared by every test in the file.
 * Use for read-only specs.
 */
export function seededDualDbs (seed: Seed): DualDbs {
  const mongo = connectMongo()
  let sqlite: Db

  const dbs: DualDbs = { sqlite: () => sqlite, mongo }

  beforeAll(async () => {
    sqlite = await Db.fromUrl(':memory:')
    await seed(dbs)
  })

  afterAll(async () => {
    await sqlite.close()
  })

  return dbs
}
