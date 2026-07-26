import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * Regressions found during a code review, each pinned against the MongoDB
 * oracle exactly as the rest of the suite is: if an expectation here is wrong,
 * the Mongodb variant fails too. Grouped by the dimension the review used.
 *
 * The prototype-pollution cases carry a SECOND, engine-independent assertion:
 * `Object.prototype` must never gain a property, whichever engine ran. That is
 * the security property, and it is checked after each operation.
 */
describe('Review regressions', () => {
  const dbs = freshDualDbs()

  afterEach(() => {
    // Nothing this suite does may leave a footprint on Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).p).toBeUndefined()
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      // --- Security: prototype pollution -----------------------------------

      it('stores a __proto__ field as data and never touches Object.prototype', async () => {
        const col = db().collection('i')
        // A COMPUTED key creates an own '__proto__' property, unlike the literal
        // __proto__: syntax which sets the prototype.
        await col.insertOne({ _id: 1, keep: 1, ['__proto__']: { polluted: 'PWN' } } as any)
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        // The field is queryable as ordinary data on both engines.
        expect((await col.find({ '__proto__.polluted': 'PWN' } as any).toArray()).map((d: any) => d._id)).toStrictEqual([1])
      })

      it('an upsert with a __proto__ path creates a field, not pollution', async () => {
        const col = db().collection('i')
        await col.updateOne(
          { _id: 2 } as any, { $set: { '__proto__.polluted': 'PWN' } } as any, { upsert: true }
        )
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        expect((await col.find({ '__proto__.polluted': 'PWN' } as any).toArray()).map((d: any) => d._id)).toStrictEqual([2])
      })

      it('a $group output field named __proto__ does not pollute', async () => {
        const col = db().collection('i')
        await col.insertMany([{ _id: 1, v: 1 }, { _id: 2, v: 1 }] as any)
        // A COMPUTED key: an own '__proto__' field of the group spec, not the
        // prototype. (MongoDB forbids a '.' in a $group output name, so the
        // dotted form of this vector cannot even be posed to the oracle.)
        const grouped = await col.aggregate([{ $group: { _id: null, ['__proto__']: { $sum: '$v' } } }]).toArray()
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        expect(Object.getOwnPropertyDescriptor(grouped[0], '__proto__')?.value).toBe(2)
      })

      it('a projection preserves a __proto__ field without corrupting the result', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1, keep: 1, drop: 2, ['__proto__']: { p: 1 } } as any)
        const [doc] = await col.find({ _id: 1 } as any, { projection: { drop: 0 } }).toArray()
        expect(({} as Record<string, unknown>).p).toBeUndefined()
        expect(Object.getPrototypeOf(doc)).toBe(Object.prototype)
        expect((doc as any).__proto__).toStrictEqual({ p: 1 })
      })

      // --- Data loss: dotted paths through a non-container -----------------

      it('$rename into a path under a scalar leaves the document untouched', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1, oldField: 'IMPORTANT', address: 'somewhere' } as any)
        await expect(
          col.updateOne({ _id: 1 } as any, { $rename: { oldField: 'address.zip' } } as any)
        ).rejects.toThrow()
        // The source value must still be there - the whole point.
        expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, oldField: 'IMPORTANT', address: 'somewhere' })
      })

      it('$rename of a missing source stays a no-op even with an odd target', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1, address: 'somewhere' } as any)
        const result = await col.updateOne({ _id: 1 } as any, { $rename: { missing: 'address.zip' } } as any)
        expect(result.modifiedCount).toBe(0)
        expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, address: 'somewhere' })
      })

      it('$set / $inc through a scalar parent raise rather than silently dropping', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1, address: 'somewhere' } as any)
        await expect(col.updateOne({ _id: 1 } as any, { $set: { 'address.zip': 5 } } as any)).rejects.toThrow()
        await expect(col.updateOne({ _id: 1 } as any, { $inc: { 'address.n': 1 } } as any)).rejects.toThrow()
        expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, address: 'somewhere' })
      })

      it('nested writes through objects, missing parents and array indexes still work', async () => {
        const col = db().collection('i')
        await col.insertMany([{ _id: 1, a: { b: 1 } }, { _id: 2, arr: [{ n: 1 }] }] as any)
        await col.updateOne({ _id: 1 } as any, { $set: { 'a.c': 2 } } as any)
        await col.updateOne({ _id: 1 } as any, { $set: { 'x.y.z': 3 } } as any)
        await col.updateOne({ _id: 2 } as any, { $set: { 'arr.0.m': 9 } } as any)
        await col.updateOne({ _id: 2 } as any, { $push: { 'list.deep': 1 } } as any)
        expect(await col.findOne({ _id: 1 } as any)).toStrictEqual({ _id: 1, a: { b: 1, c: 2 }, x: { y: { z: 3 } } })
        expect(await col.findOne({ _id: 2 } as any)).toStrictEqual({ _id: 2, arr: [{ n: 1, m: 9 }], list: { deep: [1] } })
      })

      // --- Correctness -----------------------------------------------------

      it('never equates a boolean with the number 0 or 1', async () => {
        const col = db().collection('i')
        await col.insertMany([{ _id: 1, a: true }, { _id: 2, a: 1 }, { _id: 3, a: false }, { _id: 4, a: 0 }] as any)
        const ids = async (q: any): Promise<any[]> => (await col.find(q).toArray()).map((d: any) => d._id).sort()
        expect(await ids({ a: true })).toStrictEqual([1])
        expect(await ids({ a: 1 })).toStrictEqual([2])
        expect(await ids({ a: { $in: [1] } })).toStrictEqual([2])
        expect(await ids({ a: { $in: [true, 0] } })).toStrictEqual([1, 4])
        expect(await ids({ a: { $ne: true } })).toStrictEqual([2, 3, 4])
      })

      it('$exists:false on a dotted path accounts for array elements', async () => {
        // any[]: mixed document shapes don't unify for the driver's insertMany
        const i: any[] = [
          { _id: 1, a: [{ b: 1 }, { c: 2 }] }, // a.b exists via element 0
          { _id: 2, a: [{ c: 2 }] },
          { _id: 3, a: { b: 1 } },
          { _id: 4, a: { c: 2 } }
        ]
        const col = db().collection('i')
        await col.insertMany(i)
        const ids = async (q: any): Promise<any[]> => (await col.find(q).toArray()).map((d: any) => d._id).sort()
        expect(await ids({ 'a.b': { $exists: true } })).toStrictEqual([1, 3])
        expect(await ids({ 'a.b': { $exists: false } })).toStrictEqual([2, 4])
        expect(await ids({ 'a.b': { $not: { $exists: true } } })).toStrictEqual([2, 4])
      })

      it('keeps a nested Date distinct from its ISO string in set operations', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1 } as any)
        const [out] = await col.aggregate([
          { $match: { _id: 1 } },
          { $project: { r: { $setUnion: [[{ v: new Date('2020-01-01T00:00:00Z') }], [{ v: '2020-01-01T00:00:00.000Z' }]] } } }
        ]).toArray()
        expect((out as any).r).toHaveLength(2)
      })

      it('$indexOfCP rejects a negative or fractional start, like its byte twin', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1 } as any)
        const run = (start: number): Promise<unknown> =>
          col.aggregate([{ $project: { r: { $indexOfCP: ['abcde', 'cd', start] } } }]).toArray()
        await expect(run(-1)).rejects.toThrow()
        await expect(run(1.5)).rejects.toThrow()
      })

      it('$switch requires each branch to carry a case', async () => {
        const col = db().collection('i')
        await col.insertOne({ _id: 1 } as any)
        await expect(
          col.aggregate([{ $project: { r: { $switch: { branches: [{ then: 1 }], default: 9 } } } }]).toArray()
        ).rejects.toThrow()
      })
    })
  }
})
