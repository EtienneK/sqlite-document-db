import { MongoClient as RealClient } from 'mongodb'
import { inject } from 'vitest'

import { MongoClient as ShimClient } from '../src/index.js'

/**
 * BACKLOG item 27: change streams.
 *
 * Written the way test/client-session.spec.ts is - ONE set of test bodies, run
 * through the shim and through the real driver, both held at the structural
 * interface below with no cast. Item 26 decided against this feature partly
 * because the event shapes could not be checked against anything; a replica set
 * now boots for the session spec, and a change stream needs exactly that, so
 * every shape here is settled by the server rather than by reading the manual.
 *
 * Two things about writing change-stream tests that both engines pass:
 *
 * - **The stream has to be STARTED before the writes it must see.** The
 *   driver's `watch()` does not open a cursor until something asks it for an
 *   event, so `start()` below calls `tryNext()` first. Without it the real
 *   driver misses writes that raced its own aggregate command.
 * - **"No event" is asserted with a following event, never with a timeout.**
 *   Delivery on a real server is asynchronous, so `tryNext() === null` proves
 *   nothing there; writing something that MUST be reported and asserting it is
 *   the NEXT event proves the skipped one never arrives.
 *
 * The boundaries that are this library's alone - another connection writing,
 * `db.sql`, a refused resume token - are single-engine and live in
 * test/change-stream-boundaries.spec.ts, the way test/strict.spec.ts holds the
 * rest of the known divergences.
 */
interface ChangeStreamLike {
  next: () => Promise<any>
  tryNext: () => Promise<any>
  hasNext: () => Promise<boolean>
  close: () => Promise<void>
}
interface CollectionLike {
  watch: (pipeline?: any[], options?: any) => ChangeStreamLike
  insertOne: (doc: any, options?: any) => Promise<any>
  insertMany: (docs: any[], options?: any) => Promise<any>
  updateOne: (filter: any, update: any, options?: any) => Promise<any>
  updateMany: (filter: any, update: any, options?: any) => Promise<any>
  replaceOne: (filter: any, doc: any, options?: any) => Promise<any>
  deleteOne: (filter: any, options?: any) => Promise<any>
  deleteMany: (filter: any, options?: any) => Promise<any>
  findOneAndUpdate: (filter: any, update: any, options?: any) => Promise<any>
  findOneAndDelete: (filter: any, options?: any) => Promise<any>
  bulkWrite: (operations: any[], options?: any) => Promise<any>
  drop: () => Promise<any>
  rename: (target: string) => Promise<any>
}
interface DbLike {
  collection: (name: string) => CollectionLike
  watch: (pipeline?: any[], options?: any) => ChangeStreamLike
  dropDatabase: () => Promise<any>
}
interface SessionLike {
  withTransaction: <T>(work: (session: any) => Promise<T>) => Promise<T>
  endSession: () => Promise<void>
}
interface ClientLike {
  db: (name?: string) => DbLike
  close: () => Promise<void>
  watch: (pipeline?: any[], options?: any) => ChangeStreamLike
  startSession: () => SessionLike
}
type ClientClass = { connect: (url: string) => Promise<ClientLike> }

/** Only the parts of an event under test: the rest is a token or a clock. */
function shape (event: any): any {
  return {
    operationType: event.operationType,
    // `coll` is spread conditionally: a dropDatabase event names no collection,
    // and an explicit `coll: undefined` is not the same shape as no key at all.
    ...(event.ns === undefined
      ? {}
      : { ns: { db: event.ns.db, ...(event.ns.coll === undefined ? {} : { coll: event.ns.coll }) } }),
    ...(event.to === undefined ? {} : { to: { db: event.to.db, coll: event.to.coll } }),
    ...(event.documentKey === undefined ? {} : { documentKey: event.documentKey }),
    ...(event.fullDocument === undefined ? {} : { fullDocument: event.fullDocument }),
    ...(event.updateDescription === undefined
      ? {}
      : {
          updateDescription: {
            updatedFields: event.updateDescription.updatedFields,
            removedFields: event.updateDescription.removedFields
          }
        })
  }
}

/** The next `count` events, however long they take to arrive. */
async function take (stream: ChangeStreamLike, count: number): Promise<any[]> {
  const events: any[] = []
  while (events.length < count) events.push(await stream.next())
  return events
}

async function shapes (stream: ChangeStreamLike, count: number): Promise<any[]> {
  return (await take(stream, count)).map(shape)
}

/** documentKey._id of each event, sorted - the order of a multi-row write is the server's. */
function keys (events: any[]): any[] {
  return events.map(event => event.documentKey._id).toSorted()
}

describe('change streams', () => {
  const clients: Array<[string, ClientClass]> = [['Sqlite', ShimClient], ['Mongodb', RealClient]]

  for (const [engine, clientClass] of clients) {
    describe(engine, () => {
      let client: ClientLike
      const open: ChangeStreamLike[] = []

      const db = (): DbLike => client.db('changes')
      const orders = (): CollectionLike => db().collection('orders')
      const audit = (): CollectionLike => db().collection('audit')

      /**
       * Opens a stream and waits until it is really listening. `tryNext()` is
       * what forces the driver to create its cursor; without it a write can
       * race the stream's own setup and never be reported.
       */
      const start = async (stream: ChangeStreamLike): Promise<ChangeStreamLike> => {
        open.push(stream)
        await stream.tryNext()
        return stream
      }

      beforeEach(async () => {
        client = await clientClass.connect(inject('mongoReplicaSetUri'))
        // Outside any stream: the seed must not show up as events.
        await orders().deleteMany({})
        await audit().deleteMany({})
        await orders().insertMany([
          { _id: 'a', total: 10, tags: ['x'] },
          { _id: 'b', total: 20, tags: ['y'] }
        ])
      })

      afterEach(async () => {
        for (const stream of open.splice(0)) await stream.close()
        await client.close()
      })

      describe('the events a write produces', () => {
        it('should report an insert with the whole document', async () => {
          const stream = await start(orders().watch())
          await orders().insertOne({ _id: 'c', total: 30 })

          expect(await shapes(stream, 1)).toStrictEqual([{
            operationType: 'insert',
            ns: { db: 'changes', coll: 'orders' },
            documentKey: { _id: 'c' },
            fullDocument: { _id: 'c', total: 30 }
          }])
        })

        it('should report an update as a diff, and NOT as a document', async () => {
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'a' }, { $set: { total: 11 }, $unset: { tags: '' } })

          // No fullDocument: an update event carries one only when asked, which
          // is the server's default and now this library's.
          expect(await shapes(stream, 1)).toStrictEqual([{
            operationType: 'update',
            ns: { db: 'changes', coll: 'orders' },
            documentKey: { _id: 'a' },
            updateDescription: { updatedFields: { total: 11 }, removedFields: ['tags'] }
          }])
        })

        it('should name the dotted path an update wrote, not the subdocument', async () => {
          await orders().updateOne({ _id: 'a' }, { $set: { ship: { city: 'Cape Town', code: 1 } } })
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'a' }, { $set: { 'ship.city': 'Durban' } })

          // The path comes from the update SPEC. A diff of the two documents
          // could not tell `$set: { 'ship.city': ... }` from a whole new `ship`.
          expect((await take(stream, 1))[0].updateDescription.updatedFields)
            .toStrictEqual({ 'ship.city': 'Durban' })
        })

        it('should report the value an $inc arrived at', async () => {
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'a' }, { $inc: { total: 5 } })

          expect((await take(stream, 1))[0].updateDescription.updatedFields).toStrictEqual({ total: 15 })
        })

        it('should report an appended array element by its INDEX', async () => {
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'a' }, { $push: { tags: 'z' } })
          await orders().updateOne({ _id: 'b' }, { $push: { tags: { $each: ['p', 'q'] } } })

          // Not the whole array: an append names what was appended, which is
          // the server's rule and is not what a document diff would produce.
          expect((await take(stream, 2)).map(event => event.updateDescription.updatedFields))
            .toStrictEqual([{ 'tags.1': 'z' }, { 'tags.1': 'p', 'tags.2': 'q' }])
        })

        it('should report a REBUILT array whole, however long it is', async () => {
          await orders().updateOne({ _id: 'a' }, { $set: { tags: Array.from({ length: 40 }, (_, i) => i) } })
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'a' }, { $pull: { tags: 0 } })

          // $pop and $pull rewrite the array rather than extending it, so the
          // whole thing comes back - and at 40 elements, so this is a rule
          // about the OPERATION rather than a size heuristic.
          const updated = (await take(stream, 1))[0].updateDescription.updatedFields
          expect(Object.keys(updated)).toStrictEqual(['tags'])
          expect(updated.tags).toHaveLength(39)
        })

        it('should report a $push that CREATES the array as the whole array', async () => {
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'a' }, { $push: { fresh: 'z' } })

          expect((await take(stream, 1))[0].updateDescription.updatedFields).toStrictEqual({ fresh: ['z'] })
        })

        it('should report a $push with $position or $sort as the whole array', async () => {
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'a' }, { $push: { tags: { $each: ['w'], $position: 0 } } })
          await orders().updateOne({ _id: 'b' }, { $push: { tags: { $each: ['a'], $sort: 1 } } })

          // Neither EXTENDS the array, so neither is reported as an append.
          expect((await take(stream, 2)).map(event => event.updateDescription.updatedFields))
            .toStrictEqual([{ tags: ['w', 'x'] }, { tags: ['a', 'y'] }])
        })

        it('should carry the document on an update when fullDocument is asked for', async () => {
          const stream = await start(orders().watch([], { fullDocument: 'updateLookup' }))
          await orders().updateOne({ _id: 'a' }, { $set: { total: 12 } })

          expect((await take(stream, 1))[0].fullDocument).toStrictEqual({ _id: 'a', total: 12, tags: ['x'] })
        })

        it('should report a replacement with the new document', async () => {
          const stream = await start(orders().watch())
          await orders().replaceOne({ _id: 'a' }, { total: 99 })

          expect(await shapes(stream, 1)).toStrictEqual([{
            operationType: 'replace',
            ns: { db: 'changes', coll: 'orders' },
            documentKey: { _id: 'a' },
            fullDocument: { _id: 'a', total: 99 }
          }])
        })

        it('should report a delete with the key alone', async () => {
          const stream = await start(orders().watch())
          await orders().deleteOne({ _id: 'a' })

          expect(await shapes(stream, 1)).toStrictEqual([{
            operationType: 'delete',
            ns: { db: 'changes', coll: 'orders' },
            documentKey: { _id: 'a' }
          }])
        })

        it('should report one event per document an updateMany touched', async () => {
          const stream = await start(orders().watch())
          await orders().updateMany({}, { $inc: { total: 1 } })

          const events = await take(stream, 2)
          expect(events.every(event => event.operationType === 'update')).toStrictEqual(true)
          expect(keys(events)).toStrictEqual(['a', 'b'])
          expect(events.map(event => event.updateDescription.updatedFields.total).toSorted())
            .toStrictEqual([11, 21])
        })

        it('should report one event per document a deleteMany removed', async () => {
          const stream = await start(orders().watch())
          await orders().deleteMany({})

          const events = await take(stream, 2)
          expect(events.every(event => event.operationType === 'delete')).toStrictEqual(true)
          expect(keys(events)).toStrictEqual(['a', 'b'])
        })

        it('should report nothing for an update that changed nothing', async () => {
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'a' }, { $set: { total: 10 } }) // already 10
          await orders().insertOne({ _id: 'probe' })

          // The probe is what proves the no-op was skipped rather than delayed.
          expect(await shapes(stream, 1)).toStrictEqual([{
            operationType: 'insert',
            ns: { db: 'changes', coll: 'orders' },
            documentKey: { _id: 'probe' },
            fullDocument: { _id: 'probe' }
          }])
        })

        it('should report an upsert as an insert', async () => {
          const stream = await start(orders().watch())
          await orders().updateOne({ _id: 'c' }, { $set: { total: 7 } }, { upsert: true })

          expect(await shapes(stream, 1)).toStrictEqual([{
            operationType: 'insert',
            ns: { db: 'changes', coll: 'orders' },
            documentKey: { _id: 'c' },
            fullDocument: { _id: 'c', total: 7 }
          }])
        })

        it('should report the findOneAnd* family like their plain twins', async () => {
          const stream = await start(orders().watch())
          await orders().findOneAndUpdate({ _id: 'a' }, { $set: { total: 13 } })
          await orders().findOneAndDelete({ _id: 'b' })

          expect(await shapes(stream, 2)).toStrictEqual([
            {
              operationType: 'update',
              ns: { db: 'changes', coll: 'orders' },
              documentKey: { _id: 'a' },
              updateDescription: { updatedFields: { total: 13 }, removedFields: [] }
            },
            {
              operationType: 'delete',
              ns: { db: 'changes', coll: 'orders' },
              documentKey: { _id: 'b' }
            }
          ])
        })

        it('should report every operation of a bulkWrite', async () => {
          const stream = await start(orders().watch())
          await orders().bulkWrite([
            { insertOne: { document: { _id: 'c', total: 3 } } },
            { updateOne: { filter: { _id: 'a' }, update: { $set: { total: 1 } } } },
            { deleteOne: { filter: { _id: 'b' } } }
          ])

          expect((await take(stream, 3)).map(event => event.operationType))
            .toStrictEqual(['insert', 'update', 'delete'])
        })
      })

      describe('scope', () => {
        it('should not report another collection in a collection stream', async () => {
          const stream = await start(orders().watch())
          await audit().insertOne({ _id: 'noise' })
          await orders().insertOne({ _id: 'c' })

          expect(await shapes(stream, 1)).toStrictEqual([{
            operationType: 'insert',
            ns: { db: 'changes', coll: 'orders' },
            documentKey: { _id: 'c' },
            fullDocument: { _id: 'c' }
          }])
        })

        it('should report every collection in a database stream', async () => {
          const stream = await start(db().watch())
          await audit().insertOne({ _id: 'e1' })
          await orders().insertOne({ _id: 'c' })

          expect((await take(stream, 2)).map(event => event.ns.coll)).toStrictEqual(['audit', 'orders'])
        })

        it('should report a database in a client stream', async () => {
          const stream = await start(client.watch())
          await orders().insertOne({ _id: 'c' })

          expect((await take(stream, 1))[0].ns).toStrictEqual({ db: 'changes', coll: 'orders' })
        })
      })

      describe('the pipeline', () => {
        it('should filter events with $match', async () => {
          const stream = await start(orders().watch([{ $match: { operationType: 'delete' } }]))
          await orders().insertOne({ _id: 'c' })
          await orders().updateOne({ _id: 'a' }, { $set: { total: 1 } })
          await orders().deleteOne({ _id: 'b' })

          expect(await shapes(stream, 1)).toStrictEqual([{
            operationType: 'delete',
            ns: { db: 'changes', coll: 'orders' },
            documentKey: { _id: 'b' }
          }])
        })

        it('should match on a field of the document itself', async () => {
          const stream = await start(orders().watch([{ $match: { 'fullDocument.total': { $gt: 50 } } }]))
          await orders().insertOne({ _id: 'small', total: 5 })
          await orders().insertOne({ _id: 'big', total: 500 })

          expect((await take(stream, 1))[0].documentKey).toStrictEqual({ _id: 'big' })
        })

        it('should reshape events with $project', async () => {
          const stream = await start(orders().watch([{ $project: { operationType: 1, key: '$documentKey._id' } }]))
          await orders().insertOne({ _id: 'c' })

          const event = (await take(stream, 1))[0]
          expect(event.operationType).toStrictEqual('insert')
          expect(event.key).toStrictEqual('c')
          expect(event.fullDocument).toBeUndefined()
        })
      })

      describe('the events that END a stream', () => {
        it('should report a drop and then invalidate the collection stream', async () => {
          const stream = await start(orders().watch())
          await orders().drop()

          expect(await shapes(stream, 2)).toStrictEqual([
            { operationType: 'drop', ns: { db: 'changes', coll: 'orders' } },
            { operationType: 'invalidate' }
          ])
          // An invalidate ENDS the stream; there is nothing after it.
          expect(await stream.hasNext()).toStrictEqual(false)
        })

        it('should report a rename with where it went', async () => {
          const stream = await start(orders().watch())
          await orders().rename('orders_2026')

          expect(await shapes(stream, 2)).toStrictEqual([
            {
              operationType: 'rename',
              ns: { db: 'changes', coll: 'orders' },
              to: { db: 'changes', coll: 'orders_2026' }
            },
            { operationType: 'invalidate' }
          ])
          await db().collection('orders_2026').drop()
        })

        it('should report a dropDatabase to a database stream', async () => {
          const stream = await start(db().watch())
          await db().dropDatabase()

          // A drop per collection, then the database, then the invalidate -
          // the sequence a server emits.
          const events = await take(stream, 4)
          expect(events.slice(0, 2).map(event => event.operationType)).toStrictEqual(['drop', 'drop'])
          expect(events.slice(0, 2).map(event => event.ns.coll).toSorted()).toStrictEqual(['audit', 'orders'])
          expect(events.slice(2).map(shape)).toStrictEqual([
            { operationType: 'dropDatabase', ns: { db: 'changes' } },
            { operationType: 'invalidate' }
          ])
        })
      })

      describe('transactions', () => {
        let session: SessionLike

        beforeEach(() => {
          session = client.startSession()
        })

        afterEach(async () => {
          await session.endSession()
        })

        it('should publish a transaction\'s writes when it commits', async () => {
          const stream = await start(orders().watch())
          await session.withTransaction(async () => {
            await orders().insertOne({ _id: 'c' }, { session })
            await orders().insertOne({ _id: 'd' }, { session })
          })

          expect(keys(await take(stream, 2))).toStrictEqual(['c', 'd'])
        })

        it('should publish nothing a transaction rolled back', async () => {
          const stream = await start(orders().watch())
          await expect(session.withTransaction(async () => {
            await orders().insertOne({ _id: 'gone' }, { session })
            throw Error('no')
          })).rejects.toThrow('no')
          await orders().insertOne({ _id: 'probe' })

          // The probe proves the rolled-back insert is not merely late.
          expect(keys(await take(stream, 1))).toStrictEqual(['probe'])
        })
      })
    })
  }
})
