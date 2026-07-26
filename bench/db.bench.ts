import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, bench, describe } from 'vitest'

import { Db } from '../src/index.js'

/**
 * Performance benchmarks (BACKLOG item 17).
 *
 * Two identical 20k-document collections - one with indexes, one without -
 * make the value of expression indexes directly visible: paired benches in
 * the same describe group get a relative-speed summary from vitest.
 *
 * Data generation is deterministic (seeded LCG, no Math.random), so numbers
 * are comparable across runs and machines-with-themselves.
 *
 * **Everything runs against a real FILE, not `:memory:`.** Two reasons, and the
 * second is the stronger one:
 *
 * 1. Nearly every performance problem this library has actually had was an
 *    fsync problem, and `:memory:` cannot have one - a commit there costs
 *    nothing, so a suite that benchmarks it reports a clean bill of health for
 *    exactly the regressions worth catching. `insertMany` spent a release doing
 *    one implicit transaction, and therefore one fsync, per document: in memory
 *    it clocked 243,000 inserts/s, and on a file it managed 155/s. The same
 *    code, and only one of those numbers would have been noticed by anyone.
 * 2. **A file is what people run.** `:memory:` is for tests and for the
 *    `MongoClient` shim; a benchmark should measure the configuration that
 *    actually ships, or it is optimising a case nobody is in.
 *
 * It reports rather than asserts: shared CI runners are far too noisy to fail a
 * build on a timing. The regression guard is test/write-batching.spec.ts, which
 * COUNTS the transactions instead.
 */

const DOC_COUNT = 20_000
const BASE_TIME = Date.UTC(2020, 0, 1)

function makeRng (seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const STATUSES = ['A', 'B', 'C', 'D']
const UOMS = ['cm', 'in']
const TAG_POOL = ['red', 'blank', 'gel', 'blue', 'gray', 'cotton']

function makeDoc (i: number, rng: () => number): Record<string, unknown> {
  const tags = [TAG_POOL[i % TAG_POOL.length]!, TAG_POOL[(i * 2 + 1) % TAG_POOL.length]!]
  if (i % 500 === 0) tags.push('rare') // 40 documents carry this tag
  return {
    item: `item_${i}`,
    qty: Math.floor(rng() * 500),
    price: Math.round(rng() * 10_000) / 100,
    status: STATUSES[i % STATUSES.length],
    tags,
    size: { h: Math.round(rng() * 50), w: Math.round(rng() * 50), uom: UOMS[i % UOMS.length] },
    createdAt: new Date(BASE_TIME + i * 60_000) // one per minute from 2020-01-01
  }
}

async function seedItems (db: Db): Promise<void> {
  const rng = makeRng(42)
  const col = db.collection('items')
  for (let start = 0; start < DOC_COUNT; start += 1000) {
    // Fresh objects per db: insertMany assigns _id in place, and the two
    // collections must not share (or fight over) generated ids.
    await col.insertMany(Array.from({ length: 1000 }, (_, i) => makeDoc(start + i, rng)))
  }
}

/**
 * Where every database in this file lives.
 *
 * Deliberately NOT os.tmpdir(): /tmp is a tmpfs on many Linux systems, which
 * has no fsync cost at all - a "file-backed" benchmark there measures exactly
 * what `:memory:` already did, and would report a clean bill of health for the
 * very regression this exists to expose. The working directory is a real
 * filesystem on both CI and a normal checkout.
 *
 * Anything a previous run left behind is swept first: a killed run cannot clean
 * up after itself, and these would otherwise accumulate.
 */
for (const entry of readdirSync(process.cwd())) {
  if (entry.startsWith('.bench-')) rmSync(join(process.cwd(), entry), { recursive: true, force: true })
}
const benchDir = mkdtempSync(join(process.cwd(), '.bench-'))

const indexedDb = await Db.fromUrl(join(benchDir, 'indexed.db'))
const scanDb = await Db.fromUrl(join(benchDir, 'scan.db'))
await seedItems(indexedDb)
await seedItems(scanDb)
await indexedDb.collection('items').createIndex({ qty: 1 })
await indexedDb.collection('items').createIndex({ status: 1 })
await indexedDb.collection('items').createIndex({ tags: 1 })
await indexedDb.collection('items').createIndex({ createdAt: 1 }) // + .$date companion

const indexed = indexedDb.collection('items')
const scan = scanDb.collection('items')

// Guard against benchmarking queries that silently match nothing.
const sanity: Array<[string, number]> = [
  ['qty equality', await indexed.countDocuments({ qty: 250 })],
  ['qty range', await indexed.countDocuments({ qty: { $gt: 490 } })],
  ['date range', await indexed.countDocuments({ createdAt: { $gt: new Date(BASE_TIME + (DOC_COUNT - 100) * 60_000) } })],
  ['array element', await indexed.countDocuments({ tags: 'rare' })],
  ['$regex', await indexed.countDocuments({ item: { $regex: /^item_1999\d$/ } })]
]
for (const [name, count] of sanity) {
  if (count === 0) throw Error(`benchmark query '${name}' matches no documents - the numbers would be meaningless`)
}

describe(`equality find, ${DOC_COUNT} docs`, () => {
  bench('indexed', async () => {
    await indexed.find({ qty: 250 }).toArray()
  })
  bench('full scan', async () => {
    await scan.find({ qty: 250 }).toArray()
  })
})

describe(`range find (qty > 490), ${DOC_COUNT} docs`, () => {
  bench('indexed', async () => {
    await indexed.find({ qty: { $gt: 490 } }).toArray()
  })
  bench('full scan', async () => {
    await scan.find({ qty: { $gt: 490 } }).toArray()
  })
})

describe(`Date range find (last 100 minutes), ${DOC_COUNT} docs`, () => {
  const after = new Date(BASE_TIME + (DOC_COUNT - 100) * 60_000)
  bench('indexed (.$date companion)', async () => {
    await indexed.find({ createdAt: { $gt: after } }).toArray()
  })
  bench('full scan', async () => {
    await scan.find({ createdAt: { $gt: after } }).toArray()
  })
})

describe(`implicit array element match (tags: 'rare'), ${DOC_COUNT} docs`, () => {
  bench('indexed (rowid-union form)', async () => {
    await indexed.find({ tags: 'rare' }).toArray()
  })
  bench('full scan', async () => {
    await scan.find({ tags: 'rare' }).toArray()
  })
})

describe(`countDocuments (status: 'A'), ${DOC_COUNT} docs`, () => {
  bench('indexed', async () => {
    await indexed.countDocuments({ status: 'A' })
  })
  bench('full scan', async () => {
    await scan.countDocuments({ status: 'A' })
  })
})

describe(`unindexable queries, ${DOC_COUNT} docs`, () => {
  bench('$regex (JS RegExp per row)', async () => {
    await indexed.find({ item: { $regex: /^item_1999\d$/ } }).toArray()
  })
  bench('$elemMatch', async () => {
    await indexed.find({ tags: { $elemMatch: { $eq: 'rare' } } }).toArray()
  })
  bench('$mod', async () => {
    await indexed.find({ qty: { $mod: [499, 0] } }).toArray()
  })
  bench('sort + limit 10 (type-rank filesort)', async () => {
    await indexed.find({}).sort({ qty: -1 }).limit(10).toArray()
  })
  bench('projection over ~5k matches', async () => {
    await indexed.find({ status: 'A' }, { projection: { item: 1, qty: 1 } }).toArray()
  })
})

const writeDb = await Db.fromUrl(join(benchDir, 'writes.db'))
const writes = writeDb.collection('items')
await writes.insertOne({ _id: 'w1', item: 'target', qty: 0 } as any)
const writeRng = makeRng(7)

/**
 * Writes, where the fsync shows up.
 *
 * With `journal_mode=WAL` and SQLite's default `synchronous=FULL`, a commit is
 * an fsync - so the gap between `insertOne` and the batched `insertMany` rows
 * below is not JavaScript overhead, it is one disk sync against a hundred (or a
 * thousand) documents amortised over one. That ratio is the single most
 * important number in this file, and `:memory:` reported it as ~1.
 */
describe('writes (WAL, synchronous=FULL)', () => {
  bench('insertOne', async () => {
    await writes.insertOne(makeDoc(1, writeRng) as any)
  })
  bench('insertMany, 100 docs', async () => {
    await writes.insertMany(Array.from({ length: 100 }, (_, i) => makeDoc(i, writeRng)) as any[])
  })
  bench('insertMany, 1000 docs', async () => {
    await writes.insertMany(Array.from({ length: 1000 }, (_, i) => makeDoc(i, writeRng)) as any[])
  })
  bench('updateOne by _id ($set + $inc)', async () => {
    await writes.updateOne({ _id: 'w1' }, { $set: { item: 'updated' }, $inc: { qty: 1 } })
  })
  bench('findOne by _id', async () => {
    await writes.findOne({ _id: 'w1' })
  })
})

// afterAll, not process.on('exit'): vitest runs benchmarks in a worker whose
// exit handlers do not fire, which left a .bench-* directory behind every run.
afterAll(async () => {
  await indexedDb.close()
  await scanDb.close()
  await writeDb.close()
  rmSync(benchDir, { recursive: true, force: true })
})
