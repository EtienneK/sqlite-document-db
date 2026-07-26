import { DatabaseSync } from 'node:sqlite'

import { Db } from '../src/index.js'
import type { Driver, DriverRow, DriverStatement } from '../src/driver.js'

/**
 * The driver seam (BACKLOG DR-3).
 *
 * An interface with one implementation is not a seam - it is a type. These
 * tests drive the library through a SECOND `Driver` that deliberately behaves
 * like the engines DR-3 names, to prove the abstraction is load-bearing before
 * anyone depends on it:
 *
 * - **no streaming** (`iterate` materialises), like libSQL's remote client and
 *   Turso's JavaScript binding, whose `execute()` returns every row at once;
 * - **no user-defined functions** (`supportsFunctions: false`), like Turso,
 *   where `sqlite3_create_function` is "❌ No".
 *
 * This library only - there is nothing here for MongoDB to arbitrate.
 */

/** `node:sqlite` binds params as an object or positionally; one call for both. */
function call (statement: any, method: string, params?: unknown): any {
  const fn = statement[method].bind(statement)
  if (params === undefined) return fn()
  return Array.isArray(params) ? fn(...params) : fn(params)
}

/** Wraps `node:sqlite` while removing the capabilities other engines lack. */
function limitedDriver (url: string, options: { streaming: boolean, functions: boolean }): Driver {
  const db = new DatabaseSync(url)

  const driver: Driver = {
    supportsFunctions: options.functions,
    prepare (sql: string): DriverStatement {
      const statement = db.prepare(sql)
      return {
        run: params => call(statement, 'run', params),
        get: params => call(statement, 'get', params),
        all: params => call(statement, 'all', params),
        iterate: params => options.streaming
          ? call(statement, 'iterate', params)
          // What an engine without a cursor has to do: read everything, then
          // hand it back one row at a time.
          : (call(statement, 'all', params) as DriverRow[])[Symbol.iterator]()
      }
    },
    exec: (sql: string) => { db.exec(sql) },
    close: () => { db.close() }
  }
  if (options.functions) {
    driver.createFunction = (name, implementation) => {
      db.function(name, { deterministic: true }, implementation as never)
    }
  }
  return driver
}

describe('driver seam', () => {
  it('should expose Db.fromDriver, so a backend can be supplied from outside', async () => {
    // The API DR-3 requires: the core is handed an engine, never imports one.
    const db = await Db.fromDriver(limitedDriver(':memory:', { streaming: true, functions: true }))
    await db.collection('t').insertOne({ _id: 1, a: 'x' } as any)
    expect((await db.collection('t').findOne({ _id: 1 }))?.a).toStrictEqual('x')
    await db.close()
  })

  describe('a driver that cannot stream', () => {
    let db: Db

    beforeEach(async () => {
      db = await Db.fromDriver(limitedDriver(':memory:', { streaming: false, functions: true }))
      await db.collection('items').insertMany(
        Array.from({ length: 50 }, (_, n) => ({ _id: n, n, even: n % 2 === 0 })) as any
      )
    })

    afterEach(async () => { await db.close() })

    it('should still return the right documents from a cursor', async () => {
      const evens = await db.collection('items').find({ even: true }).toArray()
      expect(evens).toHaveLength(25)
      expect(evens[0]!.n).toStrictEqual(0)
    })

    it('should still support next(), sort, skip and limit', async () => {
      const cursor = db.collection('items').find({}).sort({ n: -1 }).skip(2).limit(3)
      const seen: number[] = []
      let doc
      while ((doc = await cursor.next()) !== null) seen.push(doc.n)
      expect(seen).toStrictEqual([47, 46, 45])
    })

    it('should still support for-await and early break', async () => {
      const seen: number[] = []
      for await (const doc of db.collection('items').find({})) {
        seen.push(doc.n)
        if (seen.length === 3) break
      }
      expect(seen).toStrictEqual([0, 1, 2])
    })

    it('should still aggregate', async () => {
      expect(await db.collection('items').aggregate([
        { $group: { _id: '$even', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray()).toStrictEqual([{ _id: false, count: 25 }, { _id: true, count: 25 }])
    })

    it('should still write, update and delete', async () => {
      await db.collection('items').updateMany({ even: true }, { $inc: { n: 100 } })
      expect(await db.collection('items').countDocuments({ n: { $gte: 100 } })).toStrictEqual(25)
      await db.collection('items').deleteMany({ even: false })
      expect(await db.collection('items').countDocuments({})).toStrictEqual(25)
    })
  })

  describe('a driver without user-defined functions', () => {
    it('should open, and everything except $regex should work', async () => {
      const db = await Db.fromDriver(limitedDriver(':memory:', { streaming: true, functions: false }))
      const items = db.collection('items')
      await items.insertMany([{ _id: 1, s: 'alpha' }, { _id: 2, s: 'beta' }] as any)

      expect(await items.countDocuments({ s: 'alpha' })).toStrictEqual(1)
      expect(await items.countDocuments({ _id: { $gt: 1 } })).toStrictEqual(1)

      // $regex compiles to the function that was never registered. It fails
      // LOUDLY rather than returning a wrong answer - and closing this gap with
      // a JavaScript post-filter is the remaining work in BACKLOG item 24.
      await expect(items.countDocuments({ s: { $regex: '^al' } })).rejects.toThrow(/mdb_regexp/)
      await db.close()
    })
  })
})
