import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG item 35 step 2: binary values are stored in EJSON format
 * ({"$binary": {"base64": ..., "subType": "00"}}) and must round-trip and be
 * queryable exactly like the real MongoDB - which every assertion here runs
 * against as the oracle.
 *
 * The driver hands binary back as its `Binary` class where this library hands
 * back a `Uint8Array`, so the assertions compare BYTES via `bytesOf` rather
 * than instances - the same reason test/index.spec.ts has `byId()`.
 */
/** The driver returns `Binary` (with `.buffer`); this library `Uint8Array`. */
const bytesOf = (value: any): number[] =>
  [...(value instanceof Uint8Array ? value : value.buffer as Uint8Array)]

describe('Binary values (item 35 step 2)', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  const tiny = new Uint8Array([1, 2, 3])
  const empty = new Uint8Array(0)

  const files = [
    { _id: 1 as any, name: 'logo.png', bytes: png, meta: { thumb: tiny } },
    { _id: 2 as any, name: 'empty.bin', bytes: empty },
    { _id: 3 as any, name: 'frames', frames: [tiny, png] },
    { _id: 4 as any, name: 'byteless', size: 9 }
  ]

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('files').insertMany(structuredClone(files))
    await mongo().collection('files').insertMany(structuredClone(files))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('should round-trip bytes, including nested and zero-length', async () => {
        const doc = await db().collection('files').findOne({ _id: 1 })
        expect(bytesOf(doc?.bytes)).toStrictEqual([...png])
        expect(bytesOf(doc?.meta.thumb)).toStrictEqual([...tiny])
        expect(bytesOf((await db().collection('files').findOne({ _id: 2 }))?.bytes)).toStrictEqual([])
      })

      it('should round-trip bytes inside arrays', async () => {
        const doc = await db().collection('files').findOne({ _id: 3 })
        expect(doc?.frames.map(bytesOf)).toStrictEqual([[...tiny], [...png]])
      })

      it('should match bytes by equality, including nested fields', async () => {
        expect((await db().collection('files').findOne({ bytes: png }))?._id).toStrictEqual(1)
        expect((await db().collection('files').findOne({ bytes: { $eq: png } }))?._id).toStrictEqual(1)
        expect((await db().collection('files').findOne({ 'meta.thumb': tiny }))?._id).toStrictEqual(1)
        expect(await db().collection('files').findOne({ bytes: new Uint8Array([9, 9]) })).toStrictEqual(null)
      })

      it('should match array elements implicitly, like every other value', async () => {
        expect((await db().collection('files').findOne({ frames: tiny }))?._id).toStrictEqual(3)
        expect(await db().collection('files').findOne({ frames: new Uint8Array([7]) })).toStrictEqual(null)
      })

      it('should treat $ne like MongoDB: non-bytes and missing fields match', async () => {
        const docs = await db().collection('files').find({ bytes: { $ne: png } }).toArray()
        expect(docs.map(d => d._id)).toStrictEqual([2, 3, 4])
      })

      it('should support bytes in $in and $nin, mixed with other types', async () => {
        const ids = async (filter: any): Promise<any[]> =>
          (await db().collection('files').find(filter).toArray()).map(d => d._id)

        expect(await ids({ bytes: { $in: [png, empty] } })).toStrictEqual([1, 2])
        expect(await ids({ bytes: { $in: [png, 'not-bytes'] } })).toStrictEqual([1])
        expect(await ids({ bytes: { $nin: [png, empty] } })).toStrictEqual([3, 4])
      })

      it('should not match bytes against their base64 text or a lookalike document', async () => {
        expect(await db().collection('files').findOne({ bytes: 'iVBORw0KGgo=' })).toStrictEqual(null)
        expect(await db().collection('files').findOne({ name: png })).toStrictEqual(null)
      })

      it('should answer $type binData, and $type object should not cover bytes', async () => {
        const ids = async (filter: any): Promise<any[]> =>
          (await db().collection('files').find(filter).toArray()).map(d => d._id)

        expect(await ids({ bytes: { $type: 'binData' } })).toStrictEqual([1, 2])
        expect(await ids({ bytes: { $type: 5 } })).toStrictEqual([1, 2])
        expect(await ids({ bytes: { $type: 'object' } })).toStrictEqual([])
        expect(await ids({ meta: { $type: 'object' } })).toStrictEqual([1])
      })

      it('should report distinct byte values, elements included', async () => {
        const values = await db().collection('files').distinct('frames')
        expect(values.map(bytesOf)).toStrictEqual([[...tiny], [...png]])
      })

      it('should update through bytes: $set, and $addToSet deduplicating by content', async () => {
        await db().collection('files').updateOne({ _id: 4 } as any, { $set: { bytes: tiny } })
        expect(bytesOf((await db().collection('files').findOne({ _id: 4 }))?.bytes)).toStrictEqual([...tiny])

        // An equal-by-content Uint8Array is the SAME member of the set. (The
        // filter casts: the driver's updateOne insists _id is an ObjectId when
        // the update document mentions a Uint8Array - the same union-type
        // friction byId() smooths over in test/index.spec.ts.)
        await db().collection('files').updateOne({ _id: 3 } as any, { $addToSet: { frames: new Uint8Array([1, 2, 3]) } })
        await db().collection('files').updateOne({ _id: 3 } as any, { $addToSet: { frames: new Uint8Array([7]) } })
        const doc = await db().collection('files').findOne({ _id: 3 })
        expect(doc?.frames.map(bytesOf)).toStrictEqual([[...tiny], [...png], [7]])
      })

      it('should $pull bytes by content', async () => {
        await db().collection('files').updateOne({ _id: 3 } as any, { $pull: { frames: new Uint8Array([1, 2, 3]) } as any })
        expect((await db().collection('files').findOne({ _id: 3 }))?.frames.map(bytesOf)).toStrictEqual([[...png]])
      })

      it('should replace and delete by byte filters', async () => {
        const replaced = await db().collection('files').replaceOne({ bytes: empty }, { name: 'replaced', bytes: tiny })
        expect(replaced.modifiedCount).toStrictEqual(1)
        const deleted = await db().collection('files').deleteMany({ bytes: tiny })
        expect(deleted.deletedCount).toStrictEqual(1)
        expect(await db().collection('files').countDocuments()).toStrictEqual(3)
      })

      it('should answer $binarySize for bytes and strings, and null for null', async () => {
        const rows = await db().collection('files').aggregate([
          { $match: { _id: 1 } },
          { $project: { _id: 0, bin: { $binarySize: '$bytes' }, str: { $binarySize: '$name' }, nul: { $binarySize: null } } }
        ]).toArray()
        expect(rows).toStrictEqual([{ bin: 8, str: 8, nul: null }])
      })

      it('should group on a binary key by content', async () => {
        const rows = await db().collection('files').aggregate([
          { $match: { _id: { $in: [1, 2] } } },
          { $group: { _id: '$bytes', n: { $sum: 1 } } },
          { $sort: { n: -1 } },
          { $project: { _id: 0, n: 1 } }
        ]).toArray()
        expect(rows).toStrictEqual([{ n: 1 }, { n: 1 }])
      })
    })
  }
})
