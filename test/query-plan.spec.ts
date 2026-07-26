import { DatabaseSync } from 'node:sqlite'
import { Db } from '../src/index.js'

/**
 * Regression guards for BACKLOG items 1 and 2: the indexes createIndex()
 * emits must actually serve the SQL find() emits. The original cursor's
 * `WHERE rowid > ? ORDER BY rowid LIMIT 1` pagination forced a rowid-order
 * scan and silently ignored field indexes - and even a bare `ORDER BY rowid`
 * does the same. These tests fail if either ever comes back, or if index
 * paths and query paths drift apart (e.g. the Date `.$date` sub-path).
 *
 * Strategy: capture the exact statements the library runs (via the debug
 * logger), replay the CREATE INDEXes on a mirror connection, and ask SQLite
 * how it would execute the captured SELECT.
 */

/** Runs `use` against a debug Db, returning every SQL line it executed. */
async function capture (use: (db: Db) => Promise<void>): Promise<string[]> {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line) })
  try {
    const db = await Db.fromUrl(':memory:', { debug: true })
    await use(db)
    await db.close()
  } finally {
    spy.mockRestore()
  }
  return logs.filter(l => typeof l === 'string')
}

/**
 * EXPLAINs the captured SELECT on a mirror table populated with `docs` and the
 * captured indexes.
 *
 * Deliberately no `ANALYZE`: these tests ask whether the emitted SQL is
 * index-ELIGIBLE, and sqlite_stat1 answers a different question. With stats
 * over this mirror's synthetic all-distinct column, SQLite estimates an
 * open-ended `> ?` range at a quarter of the table and picks a scan on cost -
 * a reasonable choice that says nothing about the SQL's shape, and one the
 * library never triggers anyway (it does not run ANALYZE).
 */
function explain (logs: string[], docs: object[]): string {
  const select = logs.findLast(l => l.startsWith('SELECT data FROM'))
  expect(select).toBeDefined()

  const mirror = new DatabaseSync(':memory:')
  mirror.exec('CREATE TABLE "collection_items" (data JSON)')
  const ins = mirror.prepare('INSERT INTO "collection_items" VALUES(json(?))')
  for (const doc of docs) ins.run(JSON.stringify(doc))
  for (const create of logs.filter(l => l.startsWith('CREATE') && l.includes('INDEX') && !l.includes('doc_id'))) {
    mirror.exec(create)
  }

  const plan = mirror.prepare(`EXPLAIN QUERY PLAN ${select as string}`).all()
    .map(row => (row as { detail: string }).detail).join(' | ')
  mirror.close()
  return plan
}

describe('find() query plans', () => {
  it('a numeric-range find() should use the index createIndex() creates', async () => {
    const logs = await capture(async db => {
      await db.collection('items').createIndex({ qty: 1 })
      await db.collection('items').insertMany([{ qty: 1 }, { qty: 2 }])
      await db.collection('items').find({ qty: { $gt: 1 } }).next()
    })
    const docs = Array.from({ length: 1000 }, (_, i) => ({ _id: String(i), qty: i }))
    const plan = explain(logs, docs)
    expect(plan).toContain('INDEX ix_collection_items_qty_1')
    // Both arms of the implicit-array union must be served by the index - a
    // plan containing a full scan means only one of them was.
    expect(plan).not.toContain('SCAN collection_items')
  })

  /**
   * The claim aggregate() makes for itself: a LEADING $match is pushed into
   * SQLite and stays index-eligible. If the pushdown in splitPipeline() ever
   * regresses to "materialise everything, then filter in JavaScript", the
   * pipeline still returns the right answer and this is the only thing that
   * notices.
   */
  it('a leading $match in aggregate() should use the index too', async () => {
    const logs = await capture(async db => {
      await db.collection('items').createIndex({ qty: 1 })
      await db.collection('items').insertMany([{ qty: 1 }, { qty: 2 }])
      await db.collection('items')
        .aggregate([{ $match: { qty: { $gt: 1 } } }, { $group: { _id: null, n: { $sum: 1 } } }])
        .toArray()
    })
    const docs = Array.from({ length: 1000 }, (_, i) => ({ _id: String(i), qty: i }))
    const plan = explain(logs, docs)
    expect(plan).toContain('INDEX ix_collection_items_qty_1')
    expect(plan).not.toContain('SCAN collection_items')
  })

  it('a Date-range find() should use the .$date companion index', async () => {
    const logs = await capture(async db => {
      await db.collection('items').createIndex({ at: 1 })
      await db.collection('items').insertMany([{ at: new Date(1000) }, { at: new Date(2000) }])
      await db.collection('items').find({ at: { $gt: new Date(1500) } }).next()
    })
    const docs = Array.from({ length: 1000 }, (_, i) =>
      ({ _id: String(i), at: { $date: new Date(1_500_000_000_000 + i * 60_000).toISOString() } }))
    const plan = explain(logs, docs)
    expect(plan).toContain('INDEX ixd_collection_items_at_1')
    expect(plan).not.toContain('SCAN collection_items')
  })

  /**
   * BACKLOG item 29: a SPARSE index is a SQLite partial index over
   * `... IS NOT NULL`, and SQLite only uses a partial index when the query's
   * WHERE provably IMPLIES the index's. A range predicate implies IS NOT NULL,
   * so this one is genuinely usable - which is the thing worth pinning, since
   * a partial index that never gets used is not an index, it is overhead.
   */
  it('a sparse index should still serve a range find()', async () => {
    const logs = await capture(async db => {
      await db.collection('items').createIndex({ qty: 1 }, { sparse: true })
      await db.collection('items').insertMany([{ qty: 1 }, { qty: 2 }])
      await db.collection('items').find({ qty: { $gt: 1 } }).next()
    })
    const docs = Array.from({ length: 1000 }, (_, i) => ({ _id: String(i), qty: i }))
    const plan = explain(logs, docs)
    expect(plan).toContain('INDEX ix_collection_items_qty_1')
    expect(plan).not.toContain('SCAN collection_items')
  })
})

/**
 * `find().explain()` - the same question the tests above ask by replay, asked
 * from the public API (BACKLOG item 33). This library's own shape, not
 * MongoDB's: their explain describes a query planner that is not here.
 */
describe('find().explain()', () => {
  it('should report the SQL, its parameters and the plan SQLite chose', async () => {
    const db = await Db.fromUrl(':memory:')
    const items = db.collection('items')
    await items.insertMany(Array.from({ length: 500 }, (_unused, i) => ({ _id: String(i), qty: i })))
    await items.createIndex({ qty: 1 })

    const explained = await items.find({ qty: { $gt: 400 } }).explain()
    expect(explained.sql).toContain('SELECT data FROM')
    expect(Object.values(explained.params)).toContain(400)
    expect(explained.plan.length).toBeGreaterThan(0)
    expect(explained.indexes).toContain('ix_collection_items_qty_1')

    // An unindexed field has no index to name, which is the answer the method
    // exists to give.
    expect((await items.find({ nope: 1 }).explain()).indexes).toStrictEqual([])
    await db.close()
  })

  it('should describe the cursor as configured, including a hint', async () => {
    const db = await Db.fromUrl(':memory:')
    const items = db.collection('items')
    await items.insertMany([{ _id: '1', qty: 1 }, { _id: '2', qty: 2 }])
    await items.createIndex({ qty: 1 })

    const explained = await items.find({}).sort({ qty: -1 }).limit(5).skip(1).explain()
    expect(explained.sql).toContain('LIMIT 5')
    expect(explained.sql).toContain('OFFSET 1')

    expect((await items.find({}, { hint: 'qty_1' }).explain()).sql).toContain('INDEXED BY')
    await db.close()
  })

  it('should not consume the cursor', async () => {
    const db = await Db.fromUrl(':memory:')
    const items = db.collection('items')
    await items.insertMany([{ _id: '1' }, { _id: '2' }])
    const cursor = items.find({})
    await cursor.explain()
    expect((await cursor.toArray()).length).toStrictEqual(2)
    await db.close()
  })
})
