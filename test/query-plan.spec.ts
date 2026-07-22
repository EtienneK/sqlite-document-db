import { DatabaseSync } from 'node:sqlite'
import { Db } from '../src/index.js'

/**
 * Regression guard for BACKLOG item 1/2: the SQL that find() emits must be
 * usable by a SQLite expression index. The original cursor's
 * `WHERE rowid > ? ORDER BY rowid LIMIT 1` pagination forced a rowid-order
 * scan and silently ignored field indexes - and even a bare `ORDER BY rowid`
 * does the same. This test fails if either ever comes back.
 *
 * Strategy: capture the exact SELECT that find() runs (via the debug logger),
 * then EXPLAIN QUERY PLAN it on a mirror connection that has an index on the
 * filtered field.
 */
describe('find() query plans', () => {
  it('the emitted SELECT should be able to use an expression index', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line) })

    try {
      const db = await Db.fromUrl(':memory:', { debug: true })
      await db.collection('items').insertMany([{ qty: 1 }, { qty: 2 }])
      await db.collection('items').find({ qty: { $gt: 1 } }).next()
      await db.close()
    } finally {
      spy.mockRestore()
    }

    const select = logs.find(l => typeof l === 'string' && l.startsWith('SELECT data FROM collection_items'))
    expect(select).toBeDefined()

    // Mirror the collection's schema, add the index item 2 will create, and
    // ask SQLite how it would execute the captured statement.
    const mirror = new DatabaseSync(':memory:')
    mirror.exec('CREATE TABLE collection_items (data JSON)')
    const ins = mirror.prepare('INSERT INTO collection_items VALUES(json(?))')
    for (let i = 0; i < 1000; i++) ins.run(JSON.stringify({ _id: String(i), qty: i }))
    mirror.exec("CREATE INDEX ix_qty ON collection_items(json_extract(data, '$.qty'))")
    mirror.exec('ANALYZE')

    const plan = mirror.prepare(`EXPLAIN QUERY PLAN ${select as string}`).all()
      .map(row => (row as { detail: string }).detail).join(' | ')
    mirror.close()

    expect(plan).toContain('USING INDEX ix_qty')
  })
})
