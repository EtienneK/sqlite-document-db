import { DatabaseSync } from 'node:sqlite'

import { Db } from '../src/index.js'
import type { Driver, DriverStatement } from '../src/driver.js'
import { cachingDriver, STATEMENT_CACHE_LIMIT } from '../src/statement-cache.js'

/**
 * The prepared-statement cache (BACKLOG item 17).
 *
 * This library only - statement identity has no MongoDB analogue, like
 * test/cursor.spec.ts. Two layers under test:
 *
 * - the WRAPPER, against a counting driver, because "the cache actually
 *   caches" is invisible from behaviour alone - a regression that quietly
 *   prepared fresh statements every call would pass every other test;
 * - the LIBRARY over the wrapped driver (which `Db.open` applies to every
 *   connection), for the lifetime hazard the backlog re-sized this item over:
 *   a cached statement is OWNED by a live cursor until exhausted or closed,
 *   and handing it to a second caller would interleave their rows.
 */

/** `node:sqlite` binds params as an object or positionally; one call for both. */
function bind (statement: any, method: string, params?: unknown): any {
  const fn = statement[method].bind(statement)
  if (params === undefined) return fn()
  return Array.isArray(params) ? fn(...params) : fn(params)
}

/** `node:sqlite` behind the Driver interface, counting every real prepare(). */
function countingDriver (url = ':memory:'): { driver: Driver, prepares: () => number, preparedSql: string[] } {
  const db = new DatabaseSync(url)
  const preparedSql: string[] = []

  const driver: Driver = {
    supportsFunctions: true,
    prepare (sql: string): DriverStatement {
      preparedSql.push(sql)
      const statement = db.prepare(sql)
      return {
        run: params => bind(statement, 'run', params),
        get: params => bind(statement, 'get', params),
        all: params => bind(statement, 'all', params),
        iterate: params => bind(statement, 'iterate', params)
      }
    },
    exec: sql => { db.exec(sql) },
    close: () => { db.close() },
    createFunction: (name, implementation) => {
      db.function(name, { deterministic: true }, implementation as never)
    }
  }
  return { driver, prepares: () => preparedSql.length, preparedSql }
}

describe('the caching driver', () => {
  it('should prepare identical SQL once across calls and handles', () => {
    const { driver, prepares } = countingDriver()
    const cached = cachingDriver(driver)
    cached.exec('CREATE TABLE t (v INTEGER)')

    cached.prepare('INSERT INTO t VALUES (?)').run([1])
    cached.prepare('INSERT INTO t VALUES (?)').run([2])
    const first = cached.prepare('SELECT v FROM t ORDER BY v')
    const second = cached.prepare('SELECT v FROM t ORDER BY v')
    expect(first.all()).toEqual([{ v: 1 }, { v: 2 }])
    expect(second.all()).toEqual([{ v: 1 }, { v: 2 }])

    // One INSERT, one SELECT - however many handles and calls.
    expect(prepares()).toBe(2)
  })

  it('should give a busy statement TIME, not sharing: a second iterate gets a transient', () => {
    const { driver, prepares } = countingDriver()
    const cached = cachingDriver(driver)
    cached.exec('CREATE TABLE t (v INTEGER)')
    for (const v of [1, 2, 3]) cached.prepare('INSERT INTO t VALUES (?)').run([v])

    const sql = 'SELECT v FROM t ORDER BY v'
    const a = cached.prepare(sql).iterate()
    const b = cached.prepare(sql).iterate() // the cached one is busy: transient

    // Interleaved, and each sees every row exactly once.
    expect([a.next().value, b.next().value, a.next().value, b.next().value])
      .toEqual([{ v: 1 }, { v: 1 }, { v: 2 }, { v: 2 }])
    expect([a.next().value, b.next().value]).toEqual([{ v: 3 }, { v: 3 }])
    expect(a.next().done).toBe(true)
    expect(b.next().done).toBe(true)

    expect(prepares()).toBe(1 + 1 + 1) // INSERT, cached SELECT, transient SELECT
  })

  it('should release the statement when its iterator is exhausted, returned, or fails', () => {
    const { driver, prepares } = countingDriver()
    const cached = cachingDriver(driver)
    cached.exec('CREATE TABLE t (v INTEGER)')
    cached.prepare('INSERT INTO t VALUES (?)').run([1])
    const sql = 'SELECT v FROM t'

    // Exhausted.
    const exhausted = cached.prepare(sql).iterate()
    while (exhausted.next().done !== true);
    // Returned early - the for-await-break path.
    const abandoned = cached.prepare(sql).iterate()
    abandoned.return?.(undefined)
    // Both released: the next iterate reuses the ONE cached statement.
    const reused = cached.prepare(sql).iterate()
    expect(reused.next().value).toEqual({ v: 1 })
    reused.return?.(undefined)

    expect(prepares()).toBe(2) // INSERT + one SELECT, ever
  })

  it('should not hand run/get/all a statement a live cursor owns', () => {
    const { driver, prepares } = countingDriver()
    const cached = cachingDriver(driver)
    cached.exec('CREATE TABLE t (v INTEGER)')
    for (const v of [1, 2]) cached.prepare('INSERT INTO t VALUES (?)').run([v])

    const sql = 'SELECT v FROM t ORDER BY v'
    const cursor = cached.prepare(sql).iterate()
    expect(cursor.next().value).toEqual({ v: 1 })
    // get() on the same SQL mid-iteration: a fresh statement, and the cursor
    // does not lose its place. (get/all/run RESET the statement they run on,
    // which is exactly why they must never get the busy one.)
    expect(cached.prepare(sql).get()).toEqual({ v: 1 })
    expect(cursor.next().value).toEqual({ v: 2 })
    expect(cursor.next().done).toBe(true)

    expect(prepares()).toBe(3) // one shared INSERT, the cached SELECT, the transient for get()
  })

  it('should evict least-recently-used entries, never a busy one', () => {
    const { driver, preparedSql } = countingDriver()
    const cached = cachingDriver(driver, 2) // tiny, to make eviction observable
    cached.exec('CREATE TABLE t (v INTEGER)')
    cached.prepare('INSERT INTO t VALUES (?)').run([1])

    const busy = cached.prepare('SELECT v FROM t').iterate() // occupies one slot, busy
    cached.prepare('SELECT v + 1 AS v FROM t').get() // fills the cache
    cached.prepare('SELECT v + 2 AS v FROM t').get() // evicts - and must skip the busy entry
    cached.prepare('SELECT v + 1 AS v FROM t').get() // the evicted one: re-prepared

    expect(busy.next().value).toEqual({ v: 1 }) // the busy statement was left alone
    busy.return?.(undefined)
    expect(preparedSql.filter(sql => sql === 'SELECT v + 1 AS v FROM t')).toHaveLength(2)
    expect(preparedSql.filter(sql => sql === 'SELECT v FROM t')).toHaveLength(1)
  })

  it('should keep working past the default capacity', () => {
    const { driver } = countingDriver()
    const cached = cachingDriver(driver)
    cached.exec('CREATE TABLE t (v INTEGER)')
    cached.prepare('INSERT INTO t VALUES (?)').run([7])
    for (let i = 0; i < STATEMENT_CACHE_LIMIT + 10; i++) {
      expect(cached.prepare(`SELECT v + ${i} AS v FROM t`).get()).toEqual({ v: 7 + i })
    }
  })
})

describe('the library over a cached connection', () => {
  let db: Db

  beforeEach(async () => {
    db = await Db.fromUrl(':memory:')
  })

  afterEach(async () => {
    await db.close()
  })

  it('should keep two cursors over the SAME query independent', async () => {
    const col = db.collection('t')
    await col.insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }])

    // Identical SQL, interleaved reads - the exact hazard the backlog named.
    const a = col.find({})
    const b = col.find({})
    expect((await a.next())!._id).toBe(1)
    expect((await b.next())!._id).toBe(1)
    expect((await a.next())!._id).toBe(2)
    expect((await b.next())!._id).toBe(2)
    expect((await a.next())!._id).toBe(3)
    await a.close()
    expect((await b.next())!._id).toBe(3)
    expect(await b.next()).toBeNull()
  })

  it('should let single-document reads run while a cursor is open on the same SQL', async () => {
    const col = db.collection('t')
    await col.insertMany([{ _id: 1 }, { _id: 2 }])

    const cursor = col.find({})
    expect((await cursor.next())!._id).toBe(1)
    expect((await col.find({}).toArray()).map(doc => doc._id)).toStrictEqual([1, 2])
    expect((await cursor.next())!._id).toBe(2)
    await cursor.close()
  })

  it('should survive a drop and recreate under the same name', async () => {
    const col = db.collection('t')
    await col.insertOne({ _id: 1, v: 'old' })
    expect((await col.findOne({ _id: 1 }))?.v).toBe('old')

    await col.drop()
    // Same collection name, same table, same compiled SQL - the cached
    // statements re-prepare against the NEW table transparently.
    const again = db.collection('t')
    await again.insertOne({ _id: 1, v: 'new' })
    expect((await again.findOne({ _id: 1 }))?.v).toBe('new')
  })

  it('should read its own writes through cached statements in a transaction', async () => {
    const col = db.collection('t')
    await col.insertOne({ _id: 1, n: 0 })
    await db.withTransaction(async () => {
      await col.updateOne({ _id: 1 }, { $inc: { n: 1 } })
      await col.updateOne({ _id: 1 }, { $inc: { n: 1 } })
      expect((await col.findOne({ _id: 1 }))?.n).toBe(2)
    })
    expect((await col.findOne({ _id: 1 }))?.n).toBe(2)
  })
})
