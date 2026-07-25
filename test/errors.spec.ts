import type { Db as Mdb } from 'mongodb'

import { DUPLICATE_KEY_ERROR, type Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG item 10: a duplicate key has to be distinguishable from any other
 * write failure. Applications branch on `error.code === 11000` - a raw
 * SQLite `SQLITE_CONSTRAINT_UNIQUE` gives them nothing portable to test.
 *
 * The dual-engine run is the point: the assertions below are written against
 * the real driver's error shape, so they fail if this library's diverges.
 */
/** The `code` a write rejects with, or 'no error' if it succeeds. */
async function codeOf (write: Promise<unknown>): Promise<unknown> {
  try {
    await write
    return 'no error'
  } catch (error) {
    return (error as { code?: unknown }).code
  }
}

describe('Error shapes', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('a duplicate _id should report code 11000', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 'dup' } as any)

        expect(await codeOf(col.insertOne({ _id: 'dup' } as any))).toStrictEqual(DUPLICATE_KEY_ERROR)
        expect(await codeOf(col.insertMany([{ _id: 'fresh' }, { _id: 'dup' }] as any[]))).toStrictEqual(DUPLICATE_KEY_ERROR)
      })

      it('a unique index violation should report code 11000', async () => {
        const col = db().collection('i')
        await col.createIndex({ email: 1 }, { unique: true })
        await col.insertOne({ email: 'a@example.com' } as any)

        expect(await codeOf(col.insertOne({ email: 'a@example.com' } as any))).toStrictEqual(DUPLICATE_KEY_ERROR)
        // ...and when an update would create the duplicate
        await col.insertOne({ email: 'b@example.com' } as any)
        expect(await codeOf(col.updateOne({ email: 'b@example.com' }, { $set: { email: 'a@example.com' } })))
          .toStrictEqual(DUPLICATE_KEY_ERROR)
      })

      it('an ordinary write failure should not be reported as a duplicate key', async () => {
        const col = db().collection('i')
        expect(await codeOf(col.updateOne({ v: 1 }, { $nope: { v: 2 } } as any))).not.toStrictEqual(DUPLICATE_KEY_ERROR)
      })
    })
  }
})
