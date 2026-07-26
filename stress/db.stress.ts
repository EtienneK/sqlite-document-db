import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MongoClient, parseDocument, type Db } from '../src/index.js'
import {
  AWKWARD_STRINGS, BIG_ARRAY_LENGTH, DEEP_LEVELS, MAX_DEPTH, WIDE_FIELDS,
  deepDocument, makeCorpus, makeRng, wideDocument
} from './corpus.js'
import {
  DOC_COUNT, captureSql, fileSizeBytes, longest, makeStressDir, openStressDb,
  peakRssMb, printReport, timed, totalMs
} from './harness.js'

/**
 * The stress suite (BACKLOG item 34).
 *
 * `bench/` measures QUERY SHAPES over 20k simple documents and answers "is the
 * index used". This measures what deeply nested, wide, array-heavy documents do
 * to the COMPILER, and it exists because every performance-shaped failure this
 * library has actually had was a LIMIT rather than a slow query:
 *
 * - SQLite's parser recursion limit - `$push: { $each: [...900] }` failed with
 *   "Recursion limit" because the obvious compilation nested one call per
 *   element. Deep documents produce deep expressions the same way.
 * - JavaScript stack depth - `encode` recurses once per level, which is why
 *   `MAX_DOCUMENT_DEPTH` is 200 and not 1000, and why the job that caught it
 *   was Windows on the oldest supported Node.
 * - Compiled statement SIZE, which nothing has ever measured.
 * - Memory, because `toArray()`, the JavaScript aggregation stages and
 *   `matchBatch`'s TEMP table all materialise.
 *
 * So the assertions are CEILINGS - it completed, it stayed under N - never
 * timings. Durations are printed at the end for a human to read.
 */

const dir = makeStressDir()
let db: Db
let client: MongoClient

/** The whole corpus, in one collection: heterogeneous types at the same paths. */
const docs = (): any => db.collection('docs')
/** A second collection, for $lookup. */
const refs = (): any => db.collection('refs')

/** `root.child.child…leaf` - a dotted path with one segment per nesting level. */
function deepPath (levels: number, tail = 'leaf'): string {
  return `root${'.child'.repeat(levels)}.${tail}`
}

const corpus = makeCorpus(DOC_COUNT)
let corpusBytes = 0

beforeAll(async () => {
  db = await openStressDb(dir, 'stress')
  client = await MongoClient.connect(`${dir}/client.db`)

  corpusBytes = await timed('seed', `serialize ${corpus.length} documents`, () =>
    corpus.reduce((total, doc) => total + JSON.stringify(doc).length, 0)
  )

  await timed('seed', `insertMany ${corpus.length} documents`, async () => {
    for (let start = 0; start < corpus.length; start += 100) {
      await docs().insertMany(corpus.slice(start, start + 100).map(doc => Object.assign({}, doc)))
    }
  })

  await timed('seed', 'insertMany 200 lookup refs', async () => {
    await refs().insertMany(Array.from({ length: 200 }, (_, i) => ({
      _id: `t${i % 7}`, tag: `t${i % 7}`, weight: i
    })).filter((r, i, all) => all.findIndex(o => o._id === r._id) === i))
  })
})

afterAll(async () => {
  await db?.close()
  await client?.close()
  printReport([
    ['documents', corpus.length],
    ['corpus JSON bytes', `${(corpusBytes / 1024 / 1024).toFixed(1)} MB`],
    ['database file bytes', `${(fileSizeBytes(`${dir}/stress.db`) / 1024 / 1024).toFixed(1)} MB`],
    ['peak RSS', `${peakRssMb()} MB`],
    ['measured work', `${(totalMs() / 1000).toFixed(1)} s`]
  ])
  const { rmSync } = await import('node:fs')
  rmSync(dir, { recursive: true, force: true })
})

describe('storage', () => {
  it('round-trips every shape byte for byte', async () => {
    for (const shape of ['deep', 'wide', 'nested', 'bigArray', 'mixed']) {
      const stored = await timed('storage', `read back ${shape}`, async () =>
        await docs().findOne({ shape, index: 0 })
      )
      expect(stored, shape).not.toBeNull()
      const original = corpus.find(d => d.shape === shape && d.index === 0)!
      // The stored copy has an _id the original did not; everything else must
      // survive exactly - Dates as Dates, NFC and NFD as two strings, a NUL
      // still inside the string it was in.
      const { _id, ...withoutId } = stored
      expect(withoutId, shape).toStrictEqual(original)
    }
  })

  it('keeps a document at the depth limit and refuses one past it', async () => {
    // MAX_DEPTH counts the document as level 1; deepDocument wraps its chain in
    // `root`, so `levels` nested wrappers plus the leaf object and its Date sit
    // a few levels below that. This is the reachable edge, not the arithmetic.
    const deepest = deepDocument(9999, MAX_DEPTH - 20)
    await timed('storage', 'insert near the depth limit', async () => await docs().insertOne(deepest))
    expect(await docs().countDocuments({ index: 9999 })).toStrictEqual(1)

    const tooDeep = deepDocument(9998, MAX_DEPTH + 50)
    await expect(docs().insertOne(tooDeep)).rejects.toThrow(/depth|nest/i)
  })

  it('stores a document far wider than the corpus uses', async () => {
    const veryWide: Record<string, any> = { shape: 'veryWide', index: 0 }
    for (let f = 0; f < WIDE_FIELDS * 10; f++) veryWide[`w${f}`] = f
    await timed('storage', `insert ${WIDE_FIELDS * 10} fields`, async () => await docs().insertOne(veryWide))
    const stored = await docs().findOne({ shape: 'veryWide' })
    expect(Object.keys(stored)).toHaveLength(WIDE_FIELDS * 10 + 3) // + _id, shape, index
  })
})

describe('queries', () => {
  it('runs every operator family over a heterogeneous collection', async () => {
    // Each entry asserts only that the query COMPLETED and returned a sane
    // count - the semantics are the dual-engine suite's job. What is being
    // stressed is the compiler meeting documents of five different shapes at
    // the same paths.
    const queries: Array<[string, any, (n: number) => boolean]> = [
      ['equality', { shape: 'mixed' }, n => n === DOC_COUNT],
      ['range', { qty: { $gt: 250 } }, n => n > 0],
      ['$in', { status: { $in: ['A', 'C'] } }, n => n > 0],
      ['$nin', { status: { $nin: ['A'] } }, n => n > 0],
      ['$ne', { status: { $ne: 'A' } }, n => n > 0],
      ['$exists on a missing path', { nothingHasThis: { $exists: true } }, n => n === 0],
      ['$exists on a present path', { shape: { $exists: true } }, n => n > 0],
      ['$type', { qty: { $type: 'number' } }, n => n > 0],
      ['$regex', { item: { $regex: /^item_1\d$/ } }, n => n > 0],
      ['$mod', { qty: { $mod: [7, 0] } }, n => n > 0],
      ['implicit array match', { tags: 'rare' }, n => n > 0],
      ['$all', { tags: { $all: ['common'] } }, n => n > 0],
      ['$size', { scores: { $size: 10 } }, n => n === DOC_COUNT],
      ['$elemMatch', { instock: { $elemMatch: { qty: { $gt: 50 } } } }, n => n > 0],
      ['nested $elemMatch', { orders: { $elemMatch: { lines: { $elemMatch: { qty: { $gt: 15 } } } } } }, n => n > 0],
      ['$and of many terms', { $and: Array.from({ length: 50 }, (_, i) => ({ qty: { $gte: -i } })) }, n => n > 0],
      ['$or of many terms', { $or: Array.from({ length: 50 }, (_, i) => ({ index: i })) }, n => n > 0],
      ['$not', { qty: { $not: { $gt: 10 } } }, n => n > 0],
      ['$expr comparing two fields', { $expr: { $gt: ['$qty', '$price'] } }, n => n >= 0],
      ['$bitsAnySet', { qty: { $bitsAnySet: 1 } }, n => n > 0],
      ['unicode equality', { label: AWKWARD_STRINGS[3] }, n => n > 0],
      ['date range', { createdAt: { $gt: new Date(Date.UTC(2020, 0, 1)) } }, n => n > 0],
      ['deep path, 1 level', { 'root.level': 1 }, n => n > 0],
      // `root` is the level-1 wrapper, so ten `.child` hops reach level 11.
      ['deep path, 10 levels', { [deepPath(10, 'level')]: 11 }, n => n > 0]
    ]

    for (const [label, filter, sane] of queries) {
      const count = await timed('queries', label, async () => await docs().countDocuments(filter))
      expect(sane(count), `${label} returned ${count}`).toStrictEqual(true)
    }
  })

  it('crosses arrays in a dotted path, up to the documented depth', async () => {
    // One array level, and two: both expand.
    expect(await timed('queries', 'dotted path, 1 array level', async () =>
      await docs().countDocuments({ 'orders.total': { $gte: 0 } }))).toBeGreaterThan(0)
    expect(await timed('queries', 'dotted path, 2 array levels', async () =>
      await docs().countDocuments({ 'orders.lines.qty': { $gte: 0 } }))).toBeGreaterThan(0)

    // THREE is past MAX_ARRAY_PATH_DEPTH, and under-matches by design - the
    // documented divergence strict mode exists to refuse.
    expect(await timed('queries', 'dotted path, 3 array levels', async () =>
      await docs().countDocuments({ 'orders.lines.parts.weight': { $gte: 0 } }))).toStrictEqual(0)
  })

  it('streams a full scan without materialising it', async () => {
    const before = process.memoryUsage().heapUsed
    let seen = 0
    await timed('queries', `iterate all ${corpus.length} documents`, async () => {
      for await (const doc of docs().find({})) {
        seen++
        if (doc == null) throw Error('null document from the cursor')
      }
    })
    expect(seen).toBeGreaterThanOrEqual(corpus.length)
    const grew = (process.memoryUsage().heapUsed - before) / 1024 / 1024
    // A cursor holds one document at a time; the whole corpus is far larger.
    expect(grew, `iteration grew the heap by ${grew.toFixed(0)} MB`).toBeLessThan(256)
  })

  it('sorts, limits and skips over mixed types at one path', async () => {
    const page = await timed('queries', 'sort + skip + limit', async () =>
      await docs().find({}).sort({ index: -1 }).skip(10).limit(25).toArray())
    expect(page).toHaveLength(25)

    // `label` holds a string in some shapes and is missing in others, which is
    // what makes this a BSON-order sort rather than a SQLite one.
    const mixed = await timed('queries', 'sort a partly-missing field', async () =>
      await docs().find({}).sort({ label: 1 }).limit(50).toArray())
    expect(mixed).toHaveLength(50)
  })

  it('projects, slices and probes arrays', async () => {
    const projected = await timed('queries', 'projection with $slice', async () =>
      await docs().find({ shape: 'nested' }, { projection: { 'orders': { $slice: 2 }, marker: 1 } }).limit(20).toArray())
    expect(projected[0].orders).toHaveLength(2)

    const elem = await timed('queries', 'projection with $elemMatch', async () =>
      await docs().find({ shape: 'mixed' }, { projection: { instock: { $elemMatch: { qty: { $gt: 10 } } } } })
        .limit(20).toArray())
    expect(elem.length).toBeGreaterThan(0)

    const positional = await timed('queries', 'projection with $ positional', async () =>
      await docs().find({ 'instock.qty': { $gt: 10 } }, { projection: { 'instock.$': 1 } }).limit(20).toArray())
    expect(positional.length).toBeGreaterThan(0)
  })
})

describe('updates', () => {
  it('applies every field operator to a wide document', async () => {
    const filter = { shape: 'wide', index: 0 }
    await timed('updates', 'field operators, wide document', async () => {
      await docs().updateOne(filter, {
        $set: { f0: 1, 'nested.new.path': 'made', [`f${WIDE_FIELDS - 1}`]: 'replaced' },
        $inc: { f6: 5 },
        $mul: { f12: 2 },
        $min: { f18: -1 },
        $max: { f24: 999_999 },
        $rename: { f30: 'renamedField' },
        $unset: { f36: '' }
      })
    })
    const after = await docs().findOne(filter)
    expect(after.nested.new.path).toStrictEqual('made')
    expect(after.renamedField).toBeDefined()
    expect(after.f36).toBeUndefined()
  })

  it('applies every array operator to a 5,000-element array', async () => {
    const filter = { shape: 'bigArray', index: 0 }
    const rng = makeRng(99)
    const additions = Array.from({ length: 1_000 }, () => Math.floor(rng() * 100_000))

    await timed('updates', '$push $each 1,000 into 5,000', async () => {
      await docs().updateOne(filter, { $push: { values: { $each: additions } } })
    })
    expect((await docs().findOne(filter)).values).toHaveLength(BIG_ARRAY_LENGTH + 1_000)

    await timed('updates', '$push with $sort and $slice', async () => {
      await docs().updateOne(filter, { $push: { values: { $each: [1, 2, 3], $sort: 1, $slice: -2_000 } } })
    })
    expect((await docs().findOne(filter)).values).toHaveLength(2_000)

    await timed('updates', '$addToSet $each 1,000', async () => {
      await docs().updateOne(filter, { $addToSet: { values: { $each: additions } } })
    })
    await timed('updates', '$pull by criterion', async () => {
      await docs().updateOne(filter, { $pull: { values: { $gt: 50_000 } } })
    })
    await timed('updates', '$pullAll', async () => {
      await docs().updateOne(filter, { $pullAll: { values: additions.slice(0, 200) } })
    })
    await timed('updates', '$pop', async () => {
      await docs().updateOne(filter, { $pop: { values: -1 } })
    })
    await timed('updates', '$push with $position', async () => {
      await docs().updateOne(filter, { $push: { values: { $each: [-1, -2], $position: 5 } } })
    })
    const values = (await docs().findOne(filter)).values
    expect(values[5]).toStrictEqual(-1)
    expect(values.every((v: number) => v <= 50_000)).toStrictEqual(true)
  })

  it('writes through arrays with the positional operators', async () => {
    await timed('updates', '$ positional through an array of documents', async () => {
      await docs().updateOne({ shape: 'nested', 'orders.id': 'o1_0' }, { $set: { 'orders.$.total': -1 } })
    })
    const one = await docs().findOne({ shape: 'nested', index: 1 })
    expect(one.orders.find((o: any) => o.id === 'o1_0').total).toStrictEqual(-1)

    await timed('updates', '$[] over every element', async () => {
      await docs().updateOne({ shape: 'nested', index: 2 }, { $inc: { 'orders.$[].total': 1_000 } })
    })
    const all = await docs().findOne({ shape: 'nested', index: 2 })
    expect(all.orders.every((o: any) => o.total > 900)).toStrictEqual(true)

    await timed('updates', '$[<identifier>] with arrayFilters', async () => {
      await docs().updateOne(
        { shape: 'nested', index: 3 },
        { $set: { 'orders.$[big].flagged': true } },
        { arrayFilters: [{ 'big.total': { $gt: 50 } }] }
      )
    })
  })

  it('updates many documents in one statement', async () => {
    const result = await timed('updates', `updateMany over ${DOC_COUNT} documents`, async () =>
      await docs().updateMany({ shape: 'mixed' }, { $inc: { qty: 1 }, $set: { touched: true } }))
    expect(result.matchedCount).toStrictEqual(DOC_COUNT)
    expect(result.modifiedCount).toStrictEqual(DOC_COUNT)
  })

  it('writes to a deeply nested path', async () => {
    // 20 segments, each one a level the JSON path has to walk.
    await timed('updates', 'set a 20-level path', async () => {
      await docs().updateOne({ shape: 'deep', index: 0 }, { $set: { [deepPath(20, 'added')]: 'yes' } })
    })
    const doc = await docs().findOne({ shape: 'deep', index: 0 })
    let node = doc.root
    for (let i = 0; i < 20; i++) node = node.child
    expect(node.added).toStrictEqual('yes')
  })

  it('upserts and finds-and-modifies', async () => {
    await timed('updates', 'upsert into a deep filter', async () => {
      await docs().updateOne(
        { shape: 'upserted', 'a.b.c': 42 },
        { $set: { made: true }, $setOnInsert: { origin: 'upsert' } },
        { upsert: true }
      )
    })
    const upserted = await docs().findOne({ shape: 'upserted' })
    expect(upserted.a.b.c).toStrictEqual(42)

    const before = await timed('updates', 'findOneAndUpdate', async () =>
      await docs().findOneAndUpdate({ shape: 'upserted' }, { $set: { made: false } }, { returnDocument: 'before' }))
    expect(before.made).toStrictEqual(true)

    await timed('updates', 'findOneAndReplace', async () =>
      await docs().findOneAndReplace({ shape: 'upserted' }, { shape: 'upserted', replaced: true }))
    await timed('updates', 'findOneAndDelete', async () =>
      await docs().findOneAndDelete({ shape: 'upserted' }))
    expect(await docs().countDocuments({ shape: 'upserted' })).toStrictEqual(0)
  })
})

describe('aggregation', () => {
  it('runs the pipeline over the corpus', async () => {
    const grouped = await timed('aggregation', '$group with every accumulator', async () =>
      await docs().aggregate([
        { $match: { shape: 'mixed' } },
        {
          $group: {
            _id: '$status',
            total: { $sum: '$qty' },
            mean: { $avg: '$price' },
            low: { $min: '$qty' },
            high: { $max: '$qty' },
            first: { $first: '$item' },
            last: { $last: '$item' },
            everyTag: { $push: '$tags' },
            distinctTags: { $addToSet: '$size.uom' },
            n: { $count: {} }
          }
        },
        { $sort: { _id: 1 } }
      ]).toArray())
    expect(grouped).toHaveLength(4)

    const unwound = await timed('aggregation', '$unwind an array of documents', async () =>
      await docs().aggregate([
        { $match: { shape: 'nested' } },
        { $unwind: '$orders' },
        { $unwind: '$orders.lines' },
        { $group: { _id: '$orders.lines.uom', qty: { $sum: '$orders.lines.qty' } } },
        { $sort: { _id: 1 } }
      ]).toArray())
    expect(unwound.length).toBeGreaterThan(0)

    const expressions = await timed('aggregation', 'a deeply nested expression', async () =>
      await docs().aggregate([
        { $match: { shape: 'mixed' } },
        {
          $project: {
            item: 1,
            band: {
              $switch: {
                branches: [
                  { case: { $lt: ['$qty', 100] }, then: 'low' },
                  { case: { $lt: ['$qty', 300] }, then: 'mid' }
                ],
                default: 'high'
              }
            },
            doubled: { $map: { input: '$scores', as: 's', in: { $multiply: ['$$s', 2] } } },
            best: { $max: '$scores' },
            passing: { $filter: { input: '$scores', as: 's', cond: { $gte: ['$$s', 50] } } },
            summed: { $reduce: { input: '$scores', initialValue: 0, in: { $add: ['$$value', '$$this'] } } },
            when: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d' } },
            nested: { $cond: [{ $gt: ['$qty', 0] }, { $concat: ['$item', '-', '$status'] }, '$$REMOVE'] }
          }
        },
        { $limit: 100 }
      ]).toArray())
    expect(expressions).toHaveLength(100)

    const joined = await timed('aggregation', '$lookup', async () =>
      await docs().aggregate([
        { $match: { shape: 'mixed' } },
        { $unwind: '$tags' },
        { $lookup: { from: 'refs', localField: 'tags', foreignField: 'tag', as: 'ref' } },
        { $limit: 200 }
      ]).toArray())
    expect(joined).toHaveLength(200)

    const midMatch = await timed('aggregation', '$match after $group (TEMP table)', async () =>
      await docs().aggregate([
        { $group: { _id: '$shape', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray())
    expect(midMatch.length).toBeGreaterThan(0)
  })

  it('reports where the pipeline splits', async () => {
    const cursor = docs().aggregate([{ $match: { shape: 'mixed' } }, { $sort: { qty: 1 } }, { $group: { _id: '$status' } }])
    const explained = cursor.explain()
    expect(explained.pushedDown).toBeGreaterThan(0)
    expect(explained.inJavaScript).toContain('$group')
    await cursor.close()
  })
})

describe('indexes, distinct and bulk writes', () => {
  it('indexes ordinary, array and deep paths', async () => {
    for (const [label, spec] of [
      ['scalar', { qty: 1 }],
      ['compound', { status: 1, qty: -1 }],
      ['array path', { tags: 1 }],
      ['dotted', { 'size.uom': 1 }],
      ['date', { createdAt: 1 }],
      ['deep, 10 levels', { [deepPath(10, 'level')]: 1 }]
    ] as Array<[string, any]>) {
      await timed('indexes', `createIndex ${label}`, async () => await docs().createIndex(spec))
    }
    const listed = await docs().indexes()
    expect(listed.length).toBeGreaterThanOrEqual(7) // six above, plus _id_

    await timed('indexes', 'query through the deep index', async () =>
      await docs().countDocuments({ [deepPath(10, 'level')]: 11 }))
    await timed('indexes', 'dropIndex', async () => await docs().dropIndex('qty_1'))
  })

  it('takes distinct values from array and scalar fields', async () => {
    const tags = await timed('distinct', 'distinct over an array field', async () => await docs().distinct('tags'))
    expect(tags.length).toBeGreaterThan(1)
    const shapes = await timed('distinct', 'distinct over a scalar field', async () => await docs().distinct('shape'))
    expect(shapes).toContain('mixed')
  })

  it('runs a large mixed bulkWrite', async () => {
    // Built fresh each time: `insertOne` assigns `_id` to the document IN PLACE
    // (the driver does the same), so replaying one batch twice would be
    // inserting the same ids twice.
    const OPS = 200
    const batch = (tag: string): any[] => Array.from({ length: OPS }, (_, i) => (
      i % 3 === 0
        ? { insertOne: { document: { shape: 'bulk', tag, index: i } } }
        : i % 3 === 1
          ? { updateOne: { filter: { shape: 'mixed', index: i }, update: { $set: { bulked: true } } } }
          : { deleteOne: { filter: { shape: 'never', index: i } } }
    ))

    const result = await timed('bulk', `bulkWrite, ${OPS} operations`, async () =>
      await docs().bulkWrite(batch('plain')))
    expect(result.insertedCount).toBeGreaterThan(0)
    expect(result.matchedCount).toBeGreaterThan(0)

    // `bulkWrite` is not atomic (matching MongoDB), so each operation commits
    // on its own - and on a file every commit is an fsync. One transaction
    // turns N syncs into one, so this SHOULD dominate.
    await timed('bulk', `bulkWrite, ${OPS} operations, in a transaction`, async () => {
      await db.withTransaction(async () => await docs().bulkWrite(batch('txn')))
    })

    // It does not, and that is the finding. Every single-document write runs a
    // PRE-FLIGHT SELECT to locate its target by rowid (see the driver-seam
    // notes in CLAUDE.md, which call these free on a local engine), and this
    // collection holds ~10 MB of documents - so what the batch actually spends
    // its time on is reading and decoding JSON, once per operation. Indexing
    // one conjunct does not fix it either: `{ shape, index }` still scans for
    // the unindexed half. The lesson is that "free on a local synchronous
    // engine" stops being true once documents are large.
    await timed('bulk', 'createIndex on the filtered field', async () => await docs().createIndex({ index: 1 }))
    await timed('bulk', `bulkWrite, ${OPS} operations, indexed filter`, async () =>
      await docs().bulkWrite(batch('indexed')))
    await timed('bulk', `bulkWrite, ${OPS} operations, indexed + transaction`, async () => {
      await db.withTransaction(async () => await docs().bulkWrite(batch('both')))
    })
  })
})

describe('transactions and sessions', () => {
  it('commits and rolls back a large transaction', async () => {
    const before = await docs().countDocuments({})

    await timed('transactions', 'commit 1,000 inserts', async () => {
      await db.withTransaction(async () => {
        await docs().insertMany(Array.from({ length: 1_000 }, (_, i) => ({ shape: 'txn', index: i })))
      })
    })
    expect(await docs().countDocuments({ shape: 'txn' })).toStrictEqual(1_000)

    await timed('transactions', 'roll back 1,000 inserts', async () => {
      await db.withTransaction(async () => {
        await docs().insertMany(Array.from({ length: 1_000 }, (_, i) => ({ shape: 'rolled', index: i })))
        throw Error('discard')
      }).catch(() => {})
    })
    expect(await docs().countDocuments({ shape: 'rolled' })).toStrictEqual(0)
    expect(await docs().countDocuments({})).toStrictEqual(before + 1_000)
  })

  it('carries the same work through a session', async () => {
    const items = client.db('stress').collection('items')
    const session = client.startSession()
    await timed('transactions', 'session.withTransaction over 500 writes', async () => {
      await session.withTransaction(async () => {
        await items.insertMany(Array.from({ length: 500 }, (_, i) => ({ i })) as any[], { session })
        await items.updateMany({}, { $set: { seen: true } }, { session })
      })
    })
    expect(await items.countDocuments({ seen: true })).toStrictEqual(500)
    await session.endSession()
  })
})

describe('the raw SQL escape hatch', () => {
  it('reads the same rows the compiler wrote', async () => {
    const rows = await timed('raw sql', 'aggregate over the data column', async () =>
      await db.sql.all`
        SELECT json_extract(data, '$.shape') AS shape, COUNT(*) AS n
        FROM ${db.table('docs')}
        GROUP BY shape
        ORDER BY n DESC`)
    expect(rows.length).toBeGreaterThan(1)

    const row = await db.sql.get`SELECT data FROM ${db.table('docs')} LIMIT 1` as { data: string }
    expect(parseDocument(row.data)._id).toBeDefined()
  })
})

/**
 * The ceilings this suite exists for.
 *
 * Everything above proves the operations COMPLETE. These measure the two things
 * that have historically failed silently until they failed loudly: how large a
 * statement the compiler emits, and how much memory an operation holds at once.
 */
describe('compiler ceilings', () => {
  /** Bytes of SQL one compiled statement may reach for an ordinary shape. */
  const MAX_STATEMENT_BYTES = 2_000_000
  /** Megabytes of RSS the whole suite may reach. */
  const MAX_PEAK_RSS_MB = 2_048

  let debugDb: Db
  let probe: any

  beforeAll(async () => {
    debugDb = await openStressDb(dir, 'debug', { debug: true })
    probe = debugDb.collection('probe')
    const rng = makeRng(5)
    await probe.insertOne(wideDocument(0, rng))
    await probe.insertOne(deepDocument(0))
  })

  afterAll(async () => {
    await debugDb?.close()
  })

  it('keeps compiled SQL within a sane size for the shapes people write', async () => {
    const { statements } = await captureSql(async () => {
      await probe.countDocuments({ $and: Array.from({ length: 200 }, (_, i) => ({ [`f${i}`]: { $ne: null } })) })
      await probe.countDocuments({ $or: Array.from({ length: 200 }, (_, i) => ({ [`f${i}`]: i })) })
      await probe.countDocuments({ [deepPath(20, 'level')]: 21 })
      await probe.updateOne({ shape: 'deep' }, { $set: { [deepPath(DEEP_LEVELS, 'added')]: 1 } })
      await probe.updateOne({ shape: 'wide' }, { $push: { list: { $each: Array.from({ length: 5_000 }, (_, i) => i) } } })
      await probe.updateOne({ shape: 'wide' }, { $push: { list: { $each: [1], $sort: 1, $slice: -1_000 } } })
      await probe.updateOne({ shape: 'wide' }, { $pull: { list: { $gt: 2_500 } } })
    })

    const biggest = longest(statements)
    expect(biggest.length, `largest compiled statement was ${biggest.length} bytes`)
      .toBeLessThan(MAX_STATEMENT_BYTES)
  })

  /**
   * `$slice: -n` must evaluate its array ONCE.
   *
   * It used to name the whole array expression a second time inside its own
   * WHERE (`json_array_length(<the array>)`), so SQLite recomputed it per
   * element and the documented capped-list idiom was quadratic: 9.4s for 6,000
   * elements, 34s with `$sort`, against 8ms and 14ms now. A timing cannot guard
   * that on a shared runner - the SHAPE of the SQL can, which is the same trick
   * test/query-plan.spec.ts uses for index eligibility.
   */
  it('compiles a negative $slice without re-evaluating the array', async () => {
    const { statements } = await captureSql(async () => {
      await probe.updateOne({ shape: 'wide' }, { $push: { list: { $each: [1], $slice: -100 } } })
    })
    const update = statements.find(sql => sql.startsWith('UPDATE'))!
    expect(update, 'no UPDATE statement was captured').toBeDefined()
    expect(update, 'a negative $slice re-evaluated its array to take a length')
      .not.toContain('json_array_length')
  })

  /**
   * A dotted path's compiled SQL grows with the SQUARE of its depth.
   *
   * Each segment contributes an `$elemMatch` arm on that prefix (the rule that
   * makes `{ 'instock.qty': 5 }` match an array element), and each arm carries
   * the rest of the path - so n segments cost O(n^2) bytes. Measured:
   *
   *     depth  5 ->    19 KB      depth 20 ->   250 KB
   *     depth 10 ->    61 KB      depth 180 ->   65 MB
   *
   * 65 MB of SQL for one `countDocuments` is not a crash, which is why nothing
   * had noticed it. This pins the shape of the curve at a depth people might
   * plausibly reach, so a change that made it cubic - or fixed it - shows up.
   * See BACKLOG item 34.
   */
  it('grows a dotted path quadratically, and no worse', async () => {
    const sizes = new Map<number, number>()
    for (const depth of [5, 10, 20]) {
      const { statements } = await captureSql(async () => {
        await probe.countDocuments({ [deepPath(depth, 'level')]: depth + 1 })
      })
      sizes.set(depth, longest(statements).length)
    }

    const at5 = sizes.get(5)!
    const at10 = sizes.get(10)!
    const at20 = sizes.get(20)!
    console.log(`\n  dotted-path SQL: depth 5 ${at5}B, depth 10 ${at10}B, depth 20 ${at20}B\n`)

    // Doubling the depth roughly quadruples the SQL. Anything approaching 8x
    // would mean the expansion had become cubic.
    expect(at10 / at5, 'depth 5 -> 10 grew faster than quadratically').toBeLessThan(6)
    expect(at20 / at10, 'depth 10 -> 20 grew faster than quadratically').toBeLessThan(6)
    expect(at20, `a 20-segment path compiled to ${at20} bytes`).toBeLessThan(1_000_000)
  })

  it('stays under the memory ceiling for the whole run', () => {
    expect(peakRssMb(), `peak RSS was ${peakRssMb()} MB`).toBeLessThan(MAX_PEAK_RSS_MB)
  })
})
