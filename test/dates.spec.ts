import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG DR-1: Dates are stored in EJSON format ({"$date": ...}) and must
 * round-trip and be queryable exactly like the real MongoDB - which every
 * assertion here runs against as the oracle.
 */
describe('Date values (DR-1)', () => {
  const jan = new Date('2020-01-15T10:30:00.000Z')
  const jun = new Date('2020-06-15T10:30:00.000Z')
  const dec = new Date('2020-12-15T10:30:00.000Z')

  const events = [
    { _id: 1 as any, name: 'winter', at: jan, meta: { created: jan } },
    { _id: 2 as any, name: 'summer', at: jun, meta: { created: dec } },
    { _id: 3 as any, name: 'nye', at: dec, dates: [jan, dec] },
    { _id: 4 as any, name: 'dateless', meta: {} }
  ]

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('events').insertMany(structuredClone(events))
    await mongo().collection('events').insertMany(structuredClone(events))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('should round-trip a Date as a real Date instance', async () => {
        const doc = await db().collection('events').findOne({ _id: 1 })
        expect(doc?.at).toBeInstanceOf(Date)
        expect(doc?.at).toStrictEqual(jan)
        expect(doc?.meta.created).toBeInstanceOf(Date)
        expect(doc?.meta.created).toStrictEqual(jan)
      })

      it('should round-trip Dates inside arrays', async () => {
        const doc = await db().collection('events').findOne({ _id: 3 })
        expect(doc?.dates).toStrictEqual([jan, dec])
      })

      it('should match Dates by equality, including nested fields', async () => {
        expect((await db().collection('events').findOne({ at: jun }))?._id).toStrictEqual(2)
        expect((await db().collection('events').findOne({ at: { $eq: jun } }))?._id).toStrictEqual(2)
        expect((await db().collection('events').findOne({ 'meta.created': dec }))?._id).toStrictEqual(2)
        expect(await db().collection('events').findOne({ at: new Date('1999-01-01T00:00:00Z') })).toStrictEqual(null)
      })

      it('should not match a Date against its own ISO string', async () => {
        expect(await db().collection('events').findOne({ at: jun.toISOString() })).toStrictEqual(null)
        expect(await db().collection('events').findOne({ name: jun })).toStrictEqual(null)
      })

      it('should compare Dates with range operators', async () => {
        const ids = async (filter: any): Promise<any[]> =>
          (await db().collection('events').find(filter).toArray()).map(d => d._id)

        expect(await ids({ at: { $gt: jan } })).toStrictEqual([2, 3])
        expect(await ids({ at: { $gte: jun } })).toStrictEqual([2, 3])
        expect(await ids({ at: { $lt: jun } })).toStrictEqual([1])
        expect(await ids({ at: { $lte: jun } })).toStrictEqual([1, 2])
        expect(await ids({ at: { $gt: jan, $lt: dec } })).toStrictEqual([2])
        expect(await ids({ 'meta.created': { $gt: jan } })).toStrictEqual([2])
      })

      it('should treat $ne like MongoDB: non-dates and missing fields match', async () => {
        const docs = await db().collection('events').find({ at: { $ne: jun } }).toArray()
        expect(docs.map(d => d._id)).toStrictEqual([1, 3, 4])
      })

      it('should support Dates in $in and $nin, mixed with other types', async () => {
        const ids = async (filter: any): Promise<any[]> =>
          (await db().collection('events').find(filter).toArray()).map(d => d._id)

        expect(await ids({ at: { $in: [jan, dec] } })).toStrictEqual([1, 3])
        expect(await ids({ at: { $in: [jan, 'not-a-date'] } })).toStrictEqual([1])
        expect(await ids({ at: { $nin: [jan, dec] } })).toStrictEqual([2, 4])
        expect(await ids({ at: { $nin: [jan, null] } })).toStrictEqual([2, 3])
      })

      it('should match a whole array of Dates by equality', async () => {
        expect((await db().collection('events').findOne({ dates: [jan, dec] }))?._id).toStrictEqual(3)
        expect(await db().collection('events').findOne({ dates: [dec, jan] })).toStrictEqual(null)
      })

      it('should delete and replace by Date filters', async () => {
        const replaced = await db().collection('events').replaceOne({ at: jun }, { name: 'replaced', at: dec })
        expect(replaced.modifiedCount).toStrictEqual(1)
        const doc = await db().collection('events').findOne({ name: 'replaced' })
        expect(doc?.at).toStrictEqual(dec)

        const deleted = await db().collection('events').deleteMany({ at: { $gte: dec } })
        expect(deleted.deletedCount).toStrictEqual(2)
        expect(await db().collection('events').countDocuments()).toStrictEqual(2)
      })
    })
  }
})
