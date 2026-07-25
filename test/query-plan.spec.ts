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
})
