import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * Which values may be an `_id` (BACKLOG item 17).
 *
 * The specs have always used numeric `_id`s and they have always worked, but
 * nothing said so. This file is the specification: everything asserted here is
 * supported and checked against a real server, and anything absent is not
 * promised.
 */
describe('_id types', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const col = (): any => db().collection('items')

    describe(dbName, () => {
      it('should accept a string, a number, a boolean, a Date and a document', async () => {
        const ids: unknown[] = ['s1', 42, 4.5, true, new Date('2020-01-01T00:00:00Z'), { a: 1 }]
        for (const _id of ids) await col().insertOne({ _id, tag: 'x' })

        expect(await col().countDocuments({})).toStrictEqual(ids.length)
        for (const _id of ids) {
          const found = await col().findOne({ _id })
          expect(found).not.toBeNull()
          expect(found._id).toStrictEqual(_id)
        }
      })

      it('should generate an id when none is given', async () => {
        const result = await col().insertOne({ tag: 'generated' })
        expect(result.insertedId).toBeDefined()
        expect((await col().findOne({ tag: 'generated' }))._id).toStrictEqual(result.insertedId)
      })

      it('should generate an id for an explicit undefined or null, rather than storing it', async () => {
        // The driver treats both as "no id supplied", so `_id: null` does NOT
        // store null - checked here because it is the one case where "absent"
        // and "present but empty" could reasonably have differed.
        for (const [tag, _id] of [['undef', undefined], ['null', null]] as const) {
          const result = await col().insertOne({ _id, tag })
          const stored = (await col().findOne({ tag }))._id
          expect(stored).toStrictEqual(result.insertedId)
          expect(stored).not.toBeNull()
        }
      })

      it('should treat values of different types as different ids', async () => {
        await col().insertOne({ _id: 42, tag: 'number' })
        await col().insertOne({ _id: '42', tag: 'string' })
        expect(await col().countDocuments({})).toStrictEqual(2)
        expect((await col().findOne({ _id: 42 })).tag).toStrictEqual('number')
        expect((await col().findOne({ _id: '42' })).tag).toStrictEqual('string')
      })

      it('should reject a duplicate id with code 11000', async () => {
        await col().insertOne({ _id: 'taken' })
        await expect(col().insertOne({ _id: 'taken' })).rejects.toMatchObject({ code: 11000 })
      })

      it('should keep an id immutable', async () => {
        await col().insertOne({ _id: 'fixed', n: 1 })
        await expect(col().updateOne({ _id: 'fixed' }, { $set: { _id: 'other' } })).rejects.toThrow()
        expect(await col().countDocuments({ _id: 'fixed' })).toStrictEqual(1)
      })

      it('should round-trip a Date id as a Date', async () => {
        const when = new Date('2021-06-01T00:00:00Z')
        await col().insertOne({ _id: when })
        const found = await col().findOne({ _id: when })
        expect(found._id).toBeInstanceOf(Date)
        expect(found._id.toISOString()).toStrictEqual(when.toISOString())
      })

      it('should sort and range-query by id', async () => {
        for (const _id of [3, 1, 2]) await col().insertOne({ _id })
        expect((await col().find({}).sort({ _id: 1 }).toArray()).map((d: any) => d._id)).toStrictEqual([1, 2, 3])
        expect((await col().find({ _id: { $gte: 2 } }).sort({ _id: 1 }).toArray()).map((d: any) => d._id))
          .toStrictEqual([2, 3])
      })
    })
  }

  /**
   * This library only. An array `_id` is refused outright: MongoDB forbids it
   * too, but here it is worse than invalid - the implicit array-element rule
   * makes `{ _id: [...] }` match a DIFFERENT document that merely contains the
   * value, so `deleteOne` could remove the wrong row.
   */
  describe('Sqlite only', () => {
    it('should reject an array _id', async () => {
      await expect(dbs.sqlite().collection('items').insertOne({ _id: [1, 2] } as any)).rejects.toThrow(/array/)
    })

    it('should reject an _id holding a value the storage layer cannot represent', async () => {
      await expect(dbs.sqlite().collection('items').insertOne({ _id: 10n } as any)).rejects.toThrow()
    })
  })
})
