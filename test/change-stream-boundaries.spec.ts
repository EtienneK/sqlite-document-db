import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../src/index.js'

/**
 * BACKLOG item 27, the half that has no oracle.
 *
 * test/change-streams.spec.ts checks every event shape against a real MongoDB.
 * What is here instead is the BOUNDARY - the writes this library cannot
 * describe, and the fact that it says so rather than going quiet. A real server
 * has an oplog and reports all of them, so there is nothing to compare against;
 * this is single-engine for the same reason test/strict.spec.ts is.
 *
 * The claim being pinned is the one the whole design rests on: **every limit is
 * an `invalidate`, never a silence.**
 */
/** Every statement `debug: true` logged while `work` ran. */
async function statements (work: (db: Db) => Promise<void>): Promise<string[]> {
  const logged: string[] = []
  const debugDb = await Db.fromUrl(':memory:', { debug: true })
  const log = vi.spyOn(console, 'log').mockImplementation(sql => { logged.push(String(sql)) })
  try {
    await work(debugDb)
  } finally {
    log.mockRestore()
    await debugDb.close()
  }
  return logged
}

describe('change stream boundaries', () => {
  let db: Db
  let directory: string | undefined

  /** A file-backed database, for the tests that need a SECOND connection to it. */
  const onDisk = async (): Promise<{ file: string, db: Db }> => {
    directory = mkdtempSync(join(tmpdir(), 'sdb-watch-'))
    const file = join(directory, 'test.db')
    return { file, db: await Db.fromUrl(file) }
  }

  beforeEach(async () => {
    db = await Db.fromUrl(':memory:')
  })

  afterEach(async () => {
    await db.close()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  describe('another connection', () => {
    it('should end the stream with an invalidate when someone else writes', async () => {
      const { file, db: watched } = await onDisk()
      const orders = watched.collection('orders')
      await orders.insertOne({ _id: 'a' })
      const stream = orders.watch()
      await stream.tryNext() // establishes the data_version baseline

      const other = await Db.fromUrl(file)
      await other.collection('orders').insertOne({ _id: 'elsewhere' })
      await other.close()

      // The write is REAL and invisible: it happened on a connection this
      // stream cannot see. PRAGMA data_version is what turns that into an
      // event rather than a silence.
      const event = await stream.next()
      expect(event.operationType).toStrictEqual('invalidate')
      expect(event.invalidateReason).toStrictEqual('foreignWrite')
      // An invalidate ends the stream, exactly as MongoDB's does.
      expect(await stream.hasNext()).toStrictEqual(false)
      await watched.close()
    })

    it('should find a foreign write while a reader is blocked on next()', async () => {
      const { file, db: watched } = await onDisk()
      const orders = watched.collection('orders')
      const stream = orders.watch([], { pollIntervalMS: 10 })
      await stream.tryNext()

      // Nothing has been queued, so this can only be answered by the poll -
      // there is no write on this connection to wake the reader up.
      const waiting = stream.next()
      const other = await Db.fromUrl(file)
      await other.collection('orders').insertOne({ _id: 'elsewhere' })
      await other.close()

      expect((await waiting).invalidateReason).toStrictEqual('foreignWrite')
      await watched.close()
    })

    it('should say nothing when the other connection only READ', async () => {
      const { file, db: watched } = await onDisk()
      const orders = watched.collection('orders')
      await orders.insertOne({ _id: 'a' })
      const stream = orders.watch()
      await stream.tryNext()

      const other = await Db.fromUrl(file)
      expect(await other.collection('orders').countDocuments({})).toStrictEqual(1)
      await other.close()

      await orders.insertOne({ _id: 'b' })
      // The insert, not an invalidate: data_version tracks COMMITS.
      expect((await stream.next()).documentKey).toStrictEqual({ _id: 'b' })
      await stream.close()
      await watched.close()
    })
  })

  describe('db.sql', () => {
    it('should end the stream when a raw statement writes rows', async () => {
      const orders = db.collection('orders')
      await orders.insertOne({ _id: 'a' })
      const stream = orders.watch()
      await stream.tryNext()

      await db.sql.run`DELETE FROM ${db.table('orders')}`

      // Describing this would mean parsing arbitrary SQL. Reporting that it
      // happened costs one `total_changes()` either side of the statement.
      const event = await stream.next()
      expect(event.operationType).toStrictEqual('invalidate')
      expect(event.invalidateReason).toStrictEqual('rawSqlWrite')
    })

    it('should end the stream for a write smuggled through db.sql.all', async () => {
      const orders = db.collection('orders')
      await orders.insertOne({ _id: 'a' })
      const stream = orders.watch()
      await stream.tryNext()

      // RETURNING makes `all` a write path too, which is why the check wraps
      // all three templates rather than just `run`.
      await db.sql.all`DELETE FROM ${db.table('orders')} RETURNING data`

      expect((await stream.next()).invalidateReason).toStrictEqual('rawSqlWrite')
    })

    it('should say nothing when a raw statement only reads', async () => {
      const orders = db.collection('orders')
      await orders.insertOne({ _id: 'a' })
      const stream = orders.watch()
      await stream.tryNext()

      await db.sql.all`SELECT COUNT(*) AS n FROM ${db.table('orders')}`
      await orders.insertOne({ _id: 'b' })

      expect((await stream.next()).documentKey).toStrictEqual({ _id: 'b' })
      await stream.close()
    })

    it('should say nothing about a raw write a transaction rolled back', async () => {
      const orders = db.collection('orders')
      await orders.insertOne({ _id: 'a' })
      const stream = orders.watch()
      await stream.tryNext()

      await expect(db.withTransaction(async () => {
        await db.sql.run`DELETE FROM ${db.table('orders')}`
        throw Error('no')
      })).rejects.toThrow('no')
      await orders.insertOne({ _id: 'b' })

      // The raw write went with the transaction, so there is nothing the
      // stream missed - which is why the invalidate is buffered like any
      // other event rather than published the moment it is noticed.
      expect((await stream.next()).documentKey).toStrictEqual({ _id: 'b' })
      await stream.close()
    })
  })

  describe('what a stream costs when nobody is watching', () => {
    it('should not add RETURNING to an unwatched write', async () => {
      const logged = await statements(async debugDb => {
        const orders = debugDb.collection('orders')
        await orders.insertMany([{ _id: 'a', n: 1 }, { _id: 'b', n: 1 }])
        await orders.updateMany({}, { $inc: { n: 1 } })
        await orders.deleteMany({})
      })

      // The claim in src/change-stream.ts is that an unwatched database pays
      // NOTHING, and this is what that means in SQL. A shape assertion, like
      // the ones in test/query-plan.spec.ts - a timing would prove less.
      expect(logged.filter(sql => sql.includes('RETURNING'))).toStrictEqual([])
    })

    it('should read the rows it needs, and only while watching', async () => {
      const logged = await statements(async debugDb => {
        const orders = debugDb.collection('orders')
        await orders.insertMany([{ _id: 'a', n: 1 }, { _id: 'b', n: 1 }])
        const stream = orders.watch()
        await stream.tryNext()
        await orders.updateMany({}, { $inc: { n: 1 } })
        await orders.deleteMany({})
        await stream.close()
      })

      expect(logged.filter(sql => sql.startsWith('UPDATE') && sql.includes('RETURNING'))).toHaveLength(1)
      expect(logged.filter(sql => sql.startsWith('DELETE') && sql.includes('RETURNING'))).toHaveLength(1)
      // The pre-images REPLACE the count updateMany would otherwise run, so a
      // watched updateMany is not an extra statement.
      expect(logged.filter(sql => sql.includes('COUNT(*)'))).toStrictEqual([])
    })
  })

  describe('order and transactions', () => {
    it('should report a multi-document write in natural order', async () => {
      const orders = db.collection('orders')
      await orders.insertMany([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }])
      const stream = orders.watch()
      await stream.tryNext()

      await orders.updateMany({}, { $set: { seen: true } })

      // RETURNING promises no order; rowid is the order find() reports, so it
      // is the order the events describe.
      const keys = []
      for (let i = 0; i < 3; i++) keys.push((await stream.next()).documentKey!._id)
      expect(keys).toStrictEqual(['a', 'b', 'c'])
      await stream.close()
    })

    it('should discard the events of an inner transaction that rolled back', async () => {
      const orders = db.collection('orders')
      const stream = orders.watch()
      await stream.tryNext()

      await db.withTransaction(async () => {
        await orders.insertOne({ _id: 'outer' })
        // A nested withTransaction is a SAVEPOINT; its rollback takes its own
        // events and leaves the enclosing frame's alone.
        await expect(db.withTransaction(async () => {
          await orders.insertOne({ _id: 'inner' })
          throw Error('no')
        })).rejects.toThrow('no')
      })

      expect((await stream.next()).documentKey).toStrictEqual({ _id: 'outer' })
      await orders.insertOne({ _id: 'probe' })
      expect((await stream.next()).documentKey).toStrictEqual({ _id: 'probe' })
      await stream.close()
    })

    it('should stop paying for a stream that has been closed', async () => {
      const orders = db.collection('orders')
      const stream = orders.watch()
      await stream.tryNext()
      await stream.close()

      await orders.insertOne({ _id: 'a' })
      expect(await stream.tryNext()).toBeNull()
      // A closed stream ends its iteration rather than waiting for ever.
      const seen = []
      for await (const event of stream) seen.push(event)
      expect(seen).toStrictEqual([])
    })
  })

  describe('the pre-image, which MongoDB makes you enable', () => {
    it('should hand back the document as it was, without a collection option', async () => {
      const orders = db.collection('orders')
      await orders.insertOne({ _id: 'a', total: 10 })
      const stream = orders.watch([], { fullDocumentBeforeChange: 'whenAvailable' })
      await stream.tryNext()

      await orders.updateOne({ _id: 'a' }, { $set: { total: 20 } })
      await orders.deleteOne({ _id: 'a' })

      // A leniency, and a documented one: MongoDB errors unless the collection
      // was created with changeStreamPreAndPostImages, where the pre-image is
      // simply in hand here (findOneRow already read it).
      expect((await stream.next()).fullDocumentBeforeChange).toStrictEqual({ _id: 'a', total: 10 })
      expect((await stream.next()).fullDocumentBeforeChange).toStrictEqual({ _id: 'a', total: 20 })
      await stream.close()
    })
  })

  describe('what watch() refuses', () => {
    it('should refuse a resume token, because there is no oplog behind one', async () => {
      const orders = db.collection('orders')
      for (const option of ['resumeAfter', 'startAfter']) {
        expect(() => orders.watch([], { [option]: { _data: '1' } })).toThrow(/oplog/)
      }
      expect(() => orders.watch([], { startAtOperationTime: 1 } as any)).toThrow(/oplog/)
    })

    it('should refuse a pipeline stage a change stream cannot have', async () => {
      const orders = db.collection('orders')
      // Not a gap: a blocking stage could never complete over a stream that
      // does not end, which is why the server refuses it too.
      expect(() => orders.watch([{ $group: { _id: '$operationType' } }])).toThrow(/not permitted/)
      expect(() => orders.watch([{ $sort: { _id: 1 } }])).toThrow(/not permitted/)
      // On MongoDB's list, and not implemented here - said with that reason.
      expect(() => orders.watch([{ $replaceRoot: { newRoot: '$fullDocument' } }])).toThrow(/not implemented/)
    })

    it('should refuse an option it cannot honour', async () => {
      expect(() => db.collection('orders').watch([], { fullDocumentOnly: true } as any))
        .toThrow(/does not support/)
    })
  })
})
