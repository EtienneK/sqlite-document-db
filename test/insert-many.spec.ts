import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * What `insertMany` promises when part of the batch fails.
 *
 * This is the contract a transaction-wrapped implementation has to preserve,
 * and it is easy to state wrongly: MongoDB's *ordered* insert is NOT atomic.
 * It inserts serially, stops at the first error, and leaves everything before
 * that error written. "Not atomic" is a statement about the OUTCOME, not about
 * how many transactions were used to get there.
 */
describe('insertMany failure semantics', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const col = (): any => db().collection('t')
    const idsIn = async (): Promise<unknown[]> =>
      (await col().find({}).toArray()).map((d: any) => d._id).toSorted()

    describe(dbName, () => {
      it('should keep the documents written before the failure, and none after', async () => {
        await col().insertOne({ _id: 'dup' })
        await expect(col().insertMany([
          { _id: 'a' }, { _id: 'b' }, { _id: 'dup' }, { _id: 'c' }, { _id: 'd' }
        ])).rejects.toThrow()
        // 'a' and 'b' precede the failure and stay; 'c' and 'd' are never tried.
        expect(await idsIn()).toStrictEqual(['a', 'b', 'dup'])
      })

      it('should report a duplicate key as code 11000', async () => {
        await col().insertOne({ _id: 'dup' })
        const error = await col().insertMany([{ _id: 'ok' }, { _id: 'dup' }]).catch((e: any) => e)
        expect(error.code).toStrictEqual(11000)
      })

      it('should say how many documents it managed to insert', async () => {
        await col().insertOne({ _id: 'dup' })
        const error = await col().insertMany([
          { _id: 'a' }, { _id: 'b' }, { _id: 'dup' }, { _id: 'c' }
        ]).catch((e: any) => e)
        // The driver reports this on the thrown error, so a caller can tell
        // how far an ordered batch got without re-querying.
        expect(error.result?.insertedCount ?? error.insertedCount).toStrictEqual(2)
      })

      it('should insert everything when nothing fails', async () => {
        const result = await col().insertMany([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }])
        expect(result.insertedCount).toStrictEqual(3)
        expect(await idsIn()).toStrictEqual(['a', 'b', 'c'])
      })

      it('should fail the whole batch when the FIRST document is the duplicate', async () => {
        await col().insertOne({ _id: 'dup' })
        await expect(col().insertMany([{ _id: 'dup' }, { _id: 'a' }])).rejects.toThrow()
        expect(await idsIn()).toStrictEqual(['dup'])
      })

      it('should assign generated ids back onto the input documents', async () => {
        const docs: any[] = [{ n: 1 }, { n: 2 }]
        await col().insertMany(docs)
        // The driver mutates the caller's objects in place; several specs and
        // the README depend on it.
        expect(docs[0]._id).toBeDefined()
        expect(docs[1]._id).toBeDefined()
        expect(docs[0]._id).not.toStrictEqual(docs[1]._id)
      })
    })
  }

  /**
   * This library only: a duplicate inside a batch must not leave the connection
   * in an open transaction. Nothing in the MongoDB driver corresponds to this -
   * it is entirely about the batching added for write throughput.
   */
  describe('Sqlite only - transaction hygiene', () => {
    it('should leave no transaction open after a partial failure', async () => {
      const col = dbs.sqlite().collection('t')
      await col.insertOne({ _id: 'dup' })
      await expect(col.insertMany([{ _id: 'a' }, { _id: 'dup' }] as any)).rejects.toThrow()

      // If a transaction were still open the next write would either fail or
      // silently never commit; both show up here.
      await col.insertOne({ _id: 'after' } as any)
      expect(await col.countDocuments({ _id: 'after' })).toStrictEqual(1)
    })

    /**
     * An empty batch is a no-op here and an ERROR in the driver, which raises
     * `MongoInvalidArgumentError: Invalid BulkOperation, Batch cannot be empty`.
     *
     * Kept as a divergence rather than copied, because that check belongs to the
     * driver's bulk-write API rather than to MongoDB's insert semantics - it is
     * a client-side argument guard, and this library is not that client. A
     * no-op for an empty list is also what every other method here does.
     */
    it('should treat an empty batch as a no-op, where the driver rejects it', async () => {
      const result = await dbs.sqlite().collection('t').insertMany([])
      expect(result.insertedCount).toStrictEqual(0)
      expect(result.acknowledged).toStrictEqual(true)
    })

    it('should still be usable for a second batch after a failure', async () => {
      const col = dbs.sqlite().collection('t')
      await col.insertOne({ _id: 'dup' })
      await expect(col.insertMany([{ _id: 'dup' }] as any)).rejects.toThrow()
      const result = await col.insertMany([{ _id: 'x' }, { _id: 'y' }] as any)
      expect(result.insertedCount).toStrictEqual(2)
    })
  })
})
