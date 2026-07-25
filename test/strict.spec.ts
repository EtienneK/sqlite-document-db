import { Db } from '../src/index.js'

const open = async (strict: boolean): Promise<Db> => await Db.fromUrl(':memory:', { strict })

const seedNested = async (db: Db): Promise<void> => {
  await db.collection('t').insertMany([
    { _id: 1, a: [{ b: [{ c: [{ d: 1 }] }] }] },
    { _id: 2, a: { b: { c: { d: 2 } } } }
  ])
}

const seedArrayValued = async (db: Db): Promise<void> => {
  await db.collection('t').insertMany([{ _id: 1, v: [5, 1] }, { _id: 2, v: 3 }])
}

const seedEmbedded = async (db: Db): Promise<void> => {
  await db.collection('t').insertOne({ _id: 1, instock: [{ qty: 5 }, { qty: 7 }] })
}

/**
 * `strict: true`, which rejects the constructs whose answer is KNOWN to differ
 * from MongoDB's.
 *
 * This spec runs against this library ALONE, and it is the one file where that
 * is the whole point: every case below is something a real server ANSWERS and
 * this library answers differently. The dual-engine specs pin down where the
 * two agree; this one pins down that the places they do not can be made loud.
 *
 * Each test asserts both halves - that the default is the documented lenient
 * behaviour, and that strict turns it into an error - because a strict mode
 * that rejects things the lenient mode never got wrong would just be noise.
 */
describe('strict mode', () => {
  describe('dotted paths that could cross too many array levels', () => {

    it('should answer without complaint by default, even where it under-matches', async () => {
      const db = await open(false)
      await seedNested(db)
      // The compiler expands two array levels; document 1 needs three, so it
      // is missed. Document 2 crosses no arrays and matches.
      expect((await db.collection('t').find({ 'a.b.c.d': 2 }).toArray()).map(d => d._id)).toStrictEqual([2])
      expect(await db.collection('t').countDocuments({ 'a.b.c.d': 1 })).toStrictEqual(0)
      await db.close()
    })

    it('should reject the query under strict', async () => {
      const db = await open(true)
      await seedNested(db)
      await expect(db.collection('t').find({ 'a.b.c.d': 1 }).toArray()).rejects.toThrow(/strict.*array levels/)
      await db.close()
    })

    it('should still allow a path within the expansion depth', async () => {
      const db = await open(true)
      await db.collection('t').insertOne({ a: [{ b: [{ c: 9 }] }] })
      expect(await db.collection('t').countDocuments({ 'a.b.c': 9 })).toStrictEqual(1)
      await db.close()
    })

    it('should not count a numeric segment, which addresses one element rather than scanning', async () => {
      const db = await open(true)
      await db.collection('t').insertOne({ tags: ['x', 'y'], a: [{ b: 1 }] })
      expect(await db.collection('t').countDocuments({ 'tags.1': 'y' })).toStrictEqual(1)
      // 'a.0.b' is three segments but only one of them can be a crossing.
      expect(await db.collection('t').countDocuments({ 'a.0.b': 1 })).toStrictEqual(1)
      await db.close()
    })
  })

  describe('$type naming a type the storage layer cannot hold', () => {
    it('should quietly match nothing by default', async () => {
      const db = await open(false)
      await db.collection('t').insertOne({ a: 1 })
      expect(await db.collection('t').countDocuments({ a: { $type: 'objectId' } })).toStrictEqual(0)
      await db.close()
    })

    it('should reject it under strict', async () => {
      const db = await open(true)
      await db.collection('t').insertOne({ a: 1 })
      await expect(db.collection('t').countDocuments({ a: { $type: 'binData' } })).rejects.toThrow(/strict.*never match/)
      await expect(db.collection('t').countDocuments({ a: { $type: ['int', 'decimal'] } })).rejects.toThrow(/strict/)
      await db.close()
    })

    it('should still allow the types it can store', async () => {
      const db = await open(true)
      await db.collection('t').insertOne({ a: 1, b: 'x', c: new Date(), d: [1], e: null })
      expect(await db.collection('t').countDocuments({ a: { $type: 'number' } })).toStrictEqual(1)
      expect(await db.collection('t').countDocuments({ c: { $type: 'date' } })).toStrictEqual(1)
      await db.close()
    })
  })

  describe('sorting a field that holds an array', () => {

    it('should sort by array text by default', async () => {
      const db = await open(false)
      await seedArrayValued(db)
      // Arrays rank AFTER numbers here, whatever their smallest element is;
      // MongoDB would rank document 1 first, by its element 1.
      expect((await db.collection('t').find().sort({ v: 1 }).toArray()).map(d => d._id)).toStrictEqual([2, 1])
      await db.close()
    })

    it('should reject the sort under strict', async () => {
      const db = await open(true)
      await seedArrayValued(db)
      await expect(db.collection('t').find().sort({ v: 1 }).toArray()).rejects.toThrow(/strict.*ARRAY/)
      await expect(db.collection('t').findOne({}, { sort: { v: -1 } })).rejects.toThrow(/strict/)
      await db.close()
    })

    it('should allow a sort on a field no document holds an array in', async () => {
      const db = await open(true)
      await seedArrayValued(db)
      expect((await db.collection('t').find().sort({ _id: -1 }).toArray()).map(d => d._id)).toStrictEqual([2, 1])
      await db.close()
    })

    it('should reject an aggregation $sort over an array produced by $group', async () => {
      const db = await open(true)
      await db.collection('t').insertMany([{ g: 'a', v: 1 }, { g: 'a', v: 2 }])
      await expect(
        db.collection('t').aggregate([{ $group: { _id: '$g', all: { $push: '$v' } } }, { $sort: { all: 1 } }]).toArray()
      ).rejects.toThrow(/strict.*ARRAY/)
      await db.close()
    })
  })

  describe('aggregation field paths through an array', () => {

    it('should read as missing by default', async () => {
      const db = await open(false)
      await seedEmbedded(db)
      // MongoDB yields [5, 7] here.
      expect(await db.collection('t').aggregate([{ $project: { _id: 0, q: '$instock.qty' } }]).toArray())
        .toStrictEqual([{}])
      await db.close()
    })

    it('should reject the path under strict', async () => {
      const db = await open(true)
      await seedEmbedded(db)
      await expect(db.collection('t').aggregate([{ $project: { q: '$instock.qty' } }]).toArray())
        .rejects.toThrow(/strict.*runs through an array/)
      await expect(db.collection('t').aggregate([{ $group: { _id: '$instock.qty' } }]).toArray())
        .rejects.toThrow(/strict/)
      await db.close()
    })

    it('should accept the same path once $unwind has flattened it', async () => {
      const db = await open(true)
      await seedEmbedded(db)
      expect(await db.collection('t').aggregate([
        { $unwind: '$instock' },
        { $project: { _id: 0, q: '$instock.qty' } }
      ]).toArray()).toStrictEqual([{ q: 5 }, { q: 7 }])
      await db.close()
    })
  })

  describe('distinct() on a path that crosses an array', () => {
    it('should read as missing by default', async () => {
      const db = await open(false)
      await seedEmbedded(db)
      // MongoDB yields [5, 7] here.
      expect(await db.collection('t').distinct('instock.qty')).toStrictEqual([])
      await db.close()
    })

    it('should reject the path under strict', async () => {
      const db = await open(true)
      await seedEmbedded(db)
      await expect(db.collection('t').distinct('instock.qty')).rejects.toThrow(/strict.*ARRAY/)
      await db.close()
    })

    it('should still allow a top-level array field, which IS flattened correctly', async () => {
      const db = await open(true)
      await db.collection('t').insertOne({ tags: ['a', 'b'] })
      expect(await db.collection('t').distinct('tags')).toStrictEqual(['a', 'b'])
      await db.close()
    })

    it('should still allow a nested path no document holds an array in', async () => {
      const db = await open(true)
      await db.collection('t').insertOne({ size: { uom: 'cm' } })
      expect(await db.collection('t').distinct('size.uom')).toStrictEqual(['cm'])
      await db.close()
    })
  })

  it('should leave everything else exactly as it is', async () => {
    // strict is a boundary check, not a second set of semantics: a supported
    // query has to behave identically with it on.
    const db = await open(true)
    const items = db.collection('items')
    await items.insertMany([
      { _id: 1, item: 'journal', qty: 25, tags: ['blank', 'red'], size: { uom: 'cm' } },
      { _id: 2, item: 'planner', qty: 75, tags: ['red'], size: { uom: 'in' } }
    ])
    expect(await items.countDocuments({ tags: 'red' })).toStrictEqual(2)
    expect(await items.countDocuments({ 'size.uom': 'cm' })).toStrictEqual(1)
    expect(await items.countDocuments({ qty: { $gt: 30 } })).toStrictEqual(1)
    await items.updateOne({ _id: 1 }, { $push: { tags: 'green' }, $inc: { qty: 5 } })
    expect((await items.findOne({ _id: 1 }))?.tags).toStrictEqual(['blank', 'red', 'green'])
    expect(await items.aggregate([{ $group: { _id: '$size.uom', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray())
      .toStrictEqual([{ _id: 'cm', n: 1 }, { _id: 'in', n: 1 }])
    await db.close()
  })
})
