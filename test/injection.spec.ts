import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG item 9: every user-supplied VALUE is a bound parameter, never
 * interpolated into SQL. These strings would each have been able to break a
 * quoting bug somewhere - and MongoDB treats them as plain data, so the
 * dual-engine assertions define exactly what "handled correctly" means.
 */
describe('Adversarial values are data, not SQL', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      const NASTY = [
        "O'Reilly",
        'double"quote',
        'back\\slash',
        "'; DROP TABLE collection_i; --",
        '" OR 1=1 --',
        '{"$date":"2020-01-02T03:04:05.000Z"}', // a string that LOOKS like the stored Date wrapper
        ':p0', // a string that looks like one of our own named parameters
        '$where',
        'null',
        '[1,2,3]'
      ]

      it('strings survive find/count/update/delete round trips', async () => {
        const col = db().collection('i')
        await col.insertMany(NASTY.map((s, idx) => ({ _id: idx, s })) as any[])

        for (let idx = 0; idx < NASTY.length; idx++) {
          const s = NASTY[idx]!
          expect((await col.findOne({ s }))?._id).toStrictEqual(idx)
          expect(await col.countDocuments({ s: { $in: [s] } })).toStrictEqual(1)
          expect(await col.countDocuments({ s: { $ne: s } })).toStrictEqual(NASTY.length - 1)
        }

        // Updates carry the same values through $set
        await col.updateOne({ s: NASTY[0] }, { $set: { t: NASTY[3] } })
        expect((await col.findOne({ t: NASTY[3] }))?._id).toStrictEqual(0)

        // The DROP TABLE above travelled as data, not SQL: nothing is gone
        expect(await col.countDocuments({})).toStrictEqual(NASTY.length)

        // Deleting by adversarial value removes exactly that one document
        expect((await col.deleteOne({ s: NASTY[3] })).deletedCount).toStrictEqual(1)
        expect(await col.countDocuments({})).toStrictEqual(NASTY.length - 1)
      })

      it('$regex patterns with quotes and SQL fragments stay patterns', async () => {
        const col = db().collection('r')
        await col.insertMany([{ _id: 1, s: "O'Reilly" }, { _id: 2, s: 'plain' }] as any[])

        expect((await col.find({ s: { $regex: "^O'" } }).toArray()).map(d => d._id)).toStrictEqual([1])
        expect(await col.find({ s: { $regex: "'; DROP TABLE collection_r; --" } }).toArray()).toStrictEqual([])
        expect(await col.countDocuments({})).toStrictEqual(2)
      })

      it('array elements, whole-object equality and dotted paths carry adversarial values', async () => {
        const col = db().collection('a')
        await col.insertMany([
          { _id: 1, tags: ["O'Reilly", 'x"y'], nested: { deep: "'; --" } },
          { _id: 2, tags: ['plain'], nested: { deep: 'ok' } }
        ] as any[])

        expect((await col.findOne({ tags: "O'Reilly" }))?._id).toStrictEqual(1)
        expect((await col.findOne({ tags: { $all: ["O'Reilly", 'x"y'] } }))?._id).toStrictEqual(1)
        expect((await col.findOne({ 'nested.deep': "'; --" }))?._id).toStrictEqual(1)
        // whole-object equality encodes through the same bound-JSON path
        expect((await col.findOne({ nested: { deep: "'; --" } }))?._id).toStrictEqual(1)
      })
    })
  }
})
