import { Db } from '../src/index.js'

/**
 * Regression guard for the write-batching defect (BACKLOG item 17).
 *
 * `insertMany` used to run one implicit transaction per document. With
 * `journal_mode=WAL` and SQLite's default `synchronous=FULL` that is an fsync
 * per document: 4000 documents took 25.9 SECONDS on a file-backed database
 * against 122ms once batched, a 212x cliff. It survived a release because
 * `npm run bench` only measures `:memory:`, where a commit costs nothing.
 *
 * This asserts the STRUCTURE rather than the time. A timing assertion would be
 * flaky on shared CI runners and would have to be loose enough to miss real
 * regressions; counting the transactions the library actually opens is exact,
 * machine-independent, and fails the moment the batching is removed.
 *
 * This library only - there is no MongoDB counterpart to "how many SQLite
 * transactions did that take".
 */

/** Every SQL statement a `debug` Db executed, in order. */
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
  return logs.filter(line => typeof line === 'string')
}

const countOf = (logs: string[], statement: string): number =>
  logs.filter(line => line.trim() === statement).length

const docs = (n: number): any[] => Array.from({ length: n }, (_, i) => ({ i, name: `doc-${i}` }))

describe('write batching', () => {
  it('should wrap a whole insertMany batch in ONE transaction', async () => {
    const logs = await capture(async db => { await db.collection('t').insertMany(docs(500)) })

    // The number that matters: not 500.
    expect(countOf(logs, 'BEGIN')).toStrictEqual(1)
    expect(countOf(logs, 'COMMIT')).toStrictEqual(1)
    expect(countOf(logs, 'ROLLBACK')).toStrictEqual(0)
  })

  it('should open one transaction regardless of batch size', async () => {
    for (const size of [2, 50, 1000]) {
      const logs = await capture(async db => { await db.collection('t').insertMany(docs(size)) })
      expect({ size, begins: countOf(logs, 'BEGIN') }).toStrictEqual({ size, begins: 1 })
    }
  })

  it('should prepare the INSERT once and reuse it', async () => {
    const logs = await capture(async db => { await db.collection('t').insertMany(docs(100)) })
    expect(logs.filter(line => line.startsWith('INSERT INTO'))).toHaveLength(1)
  })

  it('should not open a transaction for a single document', async () => {
    // One document is already one commit; a transaction around it buys nothing
    // and would only add two statements.
    const single = await capture(async db => { await db.collection('t').insertMany(docs(1)) })
    expect(countOf(single, 'BEGIN')).toStrictEqual(0)

    const one = await capture(async db => { await db.collection('t').insertOne(docs(1)[0]) })
    expect(countOf(one, 'BEGIN')).toStrictEqual(0)
  })

  it('should still close the transaction when the batch fails part-way', async () => {
    const logs = await capture(async db => {
      const col = db.collection('t')
      await col.insertOne({ _id: 'dup' } as any)
      await col.insertMany([{ _id: 'a' }, { _id: 'dup' }, { _id: 'c' }] as any[]).catch(() => {})
    })
    expect(countOf(logs, 'BEGIN')).toStrictEqual(1)
    // COMMIT, not ROLLBACK: an ordered insert keeps what it managed to write.
    expect(countOf(logs, 'COMMIT')).toStrictEqual(1)
    expect(countOf(logs, 'ROLLBACK')).toStrictEqual(0)
  })

  it('should leave the connection usable after that failure', async () => {
    const db = await Db.fromUrl(':memory:')
    const col = db.collection('t')
    await col.insertOne({ _id: 'dup' } as any)
    await expect(col.insertMany([{ _id: 'a' }, { _id: 'dup' }] as any[])).rejects.toThrow()

    // A transaction left open would make this either fail or never commit.
    await col.insertMany([{ _id: 'x' }, { _id: 'y' }] as any[])
    expect(await col.countDocuments({})).toStrictEqual(4) // dup, a, x, y
    await db.close()
  })
})
