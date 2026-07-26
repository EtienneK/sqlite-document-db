import { Db, MongoClient } from '../src/index.js'

const open = async (strict: boolean): Promise<Db> => await Db.fromUrl(':memory:', { strict })

/** A client, for the one divergence that needs a session (and so a client). */
const connect = async (strict: boolean): Promise<MongoClient> =>
  await MongoClient.connect(':memory:', { strict })

const seedNested = async (db: Db): Promise<void> => {
  await db.collection('t').insertMany([
    { _id: 1, a: [{ b: [{ c: [{ d: 1 }] }] }] },
    { _id: 2, a: { b: { c: { d: 2 } } } }
  ])
}

const seedArrayValued = async (db: Db): Promise<void> => {
  await db.collection('t').insertMany([{ _id: 1, v: [5, 1] }, { _id: 2, v: 3 }])
}

const seedGrades = async (db: Db): Promise<void> => {
  await db.collection('t').insertOne({ _id: 1, grades: [{ score: 40 }, { score: 90 }] })
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

  /**
   * The one divergence a `ClientSession` has (BACKLOG item 25).
   *
   * On MongoDB a session is a ROUTING token: an operation given `{ session }`
   * joins the transaction and one without it runs outside, immediately, and is
   * not rolled back. Measured against the server for the case below - the write
   * survives. Here a transaction belongs to the CONNECTION, so every operation
   * on it takes part whether it asked to or not.
   *
   * Correct MongoDB code passes the session to every operation in a transaction
   * (omitting it is a well-known bug), so this only bites code that
   * deliberately writes outside a transaction from inside one. It is still
   * detectable, which is what makes it strict's business.
   */
  describe('an operation inside a session transaction that was not given the session', () => {
    it('should take part in the transaction by default, where MongoDB would leave it out', async () => {
      const client = await connect(false)
      const items = client.db('a').collection('items')
      const session = client.startSession()

      await session.withTransaction(async () => {
        await items.insertOne({ _id: 'enrolled' } as any, { session })
        await items.insertOne({ _id: 'forgotten' } as any) // no session
        throw Error('roll back')
      }).catch(() => {})

      // On a real server 'forgotten' would still be here.
      expect(await items.countDocuments({})).toStrictEqual(0)
      await session.endSession()
      await client.close()
    })

    it('should reject the operation under strict', async () => {
      const client = await connect(true)
      const items = client.db('a').collection('items')
      const session = client.startSession()

      await expect(session.withTransaction(async () => {
        await items.insertOne({ _id: 'enrolled' } as any, { session })
        await items.insertOne({ _id: 'forgotten' } as any)
      })).rejects.toThrow(/strict.*not given \{ session \}/)

      await session.endSession()
      await client.close()
    })

    it('should still allow an operation before the transaction has opened', async () => {
      // The transaction opens on the FIRST operation naming the session, which
      // is when one starts on a real server too - so a write before that point
      // genuinely is outside it, on both engines, and strict has nothing to say.
      const client = await connect(true)
      const items = client.db('a').collection('items')
      const session = client.startSession()

      await session.withTransaction(async () => {
        await items.insertOne({ _id: 'before' } as any)
        await items.insertOne({ _id: 'inside' } as any, { session })
      })

      expect(await items.countDocuments({})).toStrictEqual(2)
      await session.endSession()
      await client.close()
    })

    it('should leave operations outside any transaction alone', async () => {
      const client = await connect(true)
      const items = client.db('a').collection('items')
      await items.insertOne({ _id: 1 } as any)
      expect(await items.countDocuments({})).toStrictEqual(1)
      await client.close()
    })
  })

  describe('a positional update while a change stream is open', () => {
    it('should report the ARRAY by default, where MongoDB names the element', async () => {
      const db = await open(false)
      await seedGrades(db)
      const stream = db.collection('t').watch()
      await stream.tryNext()

      await db.collection('t').updateOne({ _id: 1 }, { $set: { 'grades.$[e].score': 50 } },
        { arrayFilters: [{ 'e.score': { $lt: 50 } }] })

      // MongoDB would say `{ 'grades.0.score': 50 }`; the concrete index is not
      // knowable until the statement has run, so this names the array instead.
      expect((await stream.next()).updateDescription!.updatedFields)
        .toStrictEqual({ grades: [{ score: 50 }, { score: 90 }] })
      await stream.close()
      await db.close()
    })

    it('should reject the update under strict', async () => {
      const db = await open(true)
      await seedGrades(db)
      const stream = db.collection('t').watch()
      await stream.tryNext()

      await expect(db.collection('t').updateOne({ _id: 1 }, { $set: { 'grades.$[e].score': 50 } },
        { arrayFilters: [{ 'e.score': { $lt: 50 } }] })).rejects.toThrow(/strict.*positional/)
      // Checked BEFORE the write, so the refusal leaves the document alone.
      expect((await db.collection('t').findOne({ _id: 1 }))?.grades)
        .toStrictEqual([{ score: 40 }, { score: 90 }])
      await stream.close()
      await db.close()
    })

    it('should allow the same update when nothing is watching', async () => {
      const db = await open(true)
      await seedGrades(db)
      // There is no event to describe, so there is nothing to describe wrongly.
      await db.collection('t').updateOne({ _id: 1 }, { $set: { 'grades.$[e].score': 50 } },
        { arrayFilters: [{ 'e.score': { $lt: 50 } }] })
      expect((await db.collection('t').findOne({ _id: 1 }))?.grades)
        .toStrictEqual([{ score: 50 }, { score: 90 }])
      await db.close()
    })
  })

  describe('a pipeline update while a change stream is open', () => {
    // MongoDB reports a pipeline write as an 'update' event with a granular
    // diff only while that delta is SMALLER than the document; past that it
    // logs a whole replacement and the event is a 'replace' (measured - the
    // same $set/$unset flips type with nothing but padding). This library
    // always answers 'update' with the full diff, so the event TYPE can
    // differ, and strict refuses the combination.

    it("should answer 'update' with the diff by default, where MongoDB may say 'replace'", async () => {
      const db = await open(false)
      await seedGrades(db)
      const stream = db.collection('t').watch()
      await stream.tryNext()

      await db.collection('t').updateOne({ _id: 1 }, [{ $unset: 'grades' }])

      const event = await stream.next()
      expect(event.operationType).toStrictEqual('update')
      expect(event.updateDescription!.removedFields).toStrictEqual(['grades'])
      await stream.close()
      await db.close()
    })

    it('should reject the update under strict', async () => {
      const db = await open(true)
      await seedGrades(db)
      const stream = db.collection('t').watch()
      await stream.tryNext()

      await expect(db.collection('t').updateOne({ _id: 1 }, [{ $unset: 'grades' }]))
        .rejects.toThrow(/strict.*pipeline update/)
      // Checked BEFORE the write, so the refusal leaves the document alone.
      expect((await db.collection('t').findOne({ _id: 1 }))?.grades)
        .toStrictEqual([{ score: 40 }, { score: 90 }])
      await stream.close()
      await db.close()
    })

    it('should allow the same update when nothing is watching', async () => {
      const db = await open(true)
      await seedGrades(db)
      // There is no event to type, so there is nothing to type wrongly.
      await db.collection('t').updateOne({ _id: 1 }, [{ $unset: 'grades' }])
      expect(await db.collection('t').findOne({ _id: 1 })).toStrictEqual({ _id: 1 })
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
