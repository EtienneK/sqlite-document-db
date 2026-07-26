import { MongoClient as RealClient } from 'mongodb'
import { inject } from 'vitest'

import { MongoClient as ShimClient } from '../src/index.js'

/**
 * BACKLOG item 25: `client.startSession()` and `session.withTransaction()`.
 *
 * Written the same way test/mongo-client.spec.ts is - ONE set of test bodies,
 * run through the shim and through the real driver, with both clients held at
 * the structural interface below and no cast. A drop-in claim is exactly "the
 * same code runs through both", so if the session surface drifts these stop
 * compiling before they stop passing.
 *
 * It needs a real transaction on the oracle side, so it is the one spec that
 * injects `mongoReplicaSetUri` rather than `mongoUri`: MongoDB refuses
 * transactions on a standalone mongod, and a replica set is slow enough that
 * the rest of the suite should not be paying for it (see test/global-setup.ts).
 *
 * The one thing NOT tested here is the divergence - an operation inside a
 * transaction that was not given `{ session }` - because the two engines
 * genuinely disagree and there is nothing to check against. It lives in
 * test/strict.spec.ts with the rest of the known divergences.
 */
interface SessionLike {
  withTransaction: <T>(work: (session: any) => Promise<T>) => Promise<T>
  startTransaction: () => void
  commitTransaction: () => Promise<void>
  abortTransaction: () => Promise<void>
  endSession: () => Promise<void>
  readonly hasEnded: boolean
  inTransaction: () => boolean
  equals: (other: any) => boolean
}
interface DbLike {
  collection: (name: string) => any
}
interface ClientLike {
  connect: () => Promise<unknown>
  db: (name?: string) => DbLike
  close: () => Promise<void>
  startSession: () => SessionLike
  withSession: <T>(work: (session: any) => Promise<T>) => Promise<T>
}
type ClientClass = (new (url: string) => ClientLike) & { connect: (url: string) => Promise<ClientLike> }

describe('ClientSession', () => {
  const clients: Array<[string, ClientClass]> = [['Sqlite', ShimClient], ['Mongodb', RealClient]]

  for (const [engine, clientClass] of clients) {
    describe(engine, () => {
      let client: ClientLike
      let session: SessionLike

      const accounts = (): any => client.db('sessions').collection('accounts')
      const audit = (): any => client.db('sessions').collection('audit')
      const balances = async (): Promise<Record<string, number>> => {
        const rows = await accounts().find({}).toArray()
        return Object.fromEntries(rows.map((row: any) => [row._id, row.balance]))
      }

      beforeEach(async () => {
        client = await clientClass.connect(inject('mongoReplicaSetUri'))
        // Created OUTSIDE the transactions below on purpose: creating a
        // collection inside one is a separate MongoDB restriction, and not
        // what any of this is about.
        await accounts().deleteMany({})
        await audit().deleteMany({})
        await accounts().insertMany([{ _id: 'a', balance: 100 }, { _id: 'b', balance: 0 }])
        session = client.startSession()
      })

      afterEach(async () => {
        await session.endSession()
        await client.close()
      })

      describe('withTransaction', () => {
        it('should commit every write when the callback returns', async () => {
          await session.withTransaction(async () => {
            await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -60 } }, { session })
            await accounts().updateOne({ _id: 'b' }, { $inc: { balance: 60 } }, { session })
          })

          expect(await balances()).toStrictEqual({ a: 40, b: 60 })
        })

        it('should roll every write back when the callback throws, and rethrow', async () => {
          await expect(session.withTransaction(async () => {
            await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -60 } }, { session })
            await accounts().updateOne({ _id: 'b' }, { $inc: { balance: 60 } }, { session })
            throw Error('no')
          })).rejects.toThrow('no')

          // The half-applied transfer is the exact thing a transaction prevents.
          expect(await balances()).toStrictEqual({ a: 100, b: 0 })
        })

        it('should return whatever the callback returns', async () => {
          const result = await session.withTransaction(async () => {
            await audit().insertOne({ _id: 'e1' }, { session })
            return 'done'
          })
          expect(result).toStrictEqual('done')
        })

        it('should pass the session to the callback', async () => {
          expect(await session.withTransaction(async inner => inner === session)).toStrictEqual(true)
        })

        it('should work across collections', async () => {
          await expect(session.withTransaction(async () => {
            await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } }, { session })
            await audit().insertOne({ _id: 'e1', what: 'transfer' }, { session })
            throw Error('no')
          })).rejects.toThrow()

          expect((await balances()).a).toStrictEqual(100)
          expect(await audit().countDocuments({})).toStrictEqual(0)
        })

        it('should see its own uncommitted writes from inside', async () => {
          await session.withTransaction(async () => {
            await accounts().insertOne({ _id: 'c', balance: 5 }, { session })
            expect(await accounts().countDocuments({}, { session })).toStrictEqual(3)
            expect((await accounts().findOne({ _id: 'c' }, { session }))?.balance).toStrictEqual(5)
          })
          expect(await accounts().countDocuments({})).toStrictEqual(3)
        })

        it('should be the read-modify-write a single statement cannot express', async () => {
          await expect(session.withTransaction(async () => {
            const from = await accounts().findOne({ _id: 'a' }, { session })
            if (from.balance < 500) throw Error('insufficient funds')
            await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -500 } }, { session })
          })).rejects.toThrow('insufficient funds')

          expect(await balances()).toStrictEqual({ a: 100, b: 0 })
        })

        it('should refuse to nest on one session', async () => {
          // MongoDB has no nested transaction on a session, whatever the engine
          // underneath could support.
          await expect(session.withTransaction(async () => {
            await session.withTransaction(async () => 1)
          })).rejects.toThrow(/already in progress/i)
        })

        it('should carry every kind of write', async () => {
          await session.withTransaction(async () => {
            await accounts().insertOne({ _id: 'c', balance: 1 }, { session })
            await accounts().insertMany([{ _id: 'd', balance: 2 }], { session })
            await accounts().updateMany({ balance: { $gt: 0 } }, { $set: { seen: true } }, { session })
            await accounts().replaceOne({ _id: 'd' }, { balance: 20 }, { session })
            await accounts().findOneAndUpdate({ _id: 'c' }, { $set: { balance: 10 } }, { session })
            await accounts().bulkWrite([{ insertOne: { document: { _id: 'e', balance: 3 } } }], { session })
            await accounts().updateOne({ _id: 'f' }, { $set: { balance: 4 } }, { upsert: true, session })
            await accounts().deleteOne({ _id: 'e' }, { session })
            throw Error('discard it all')
          }).catch(() => {})

          expect(await balances()).toStrictEqual({ a: 100, b: 0 })
        })

        it('should carry every kind of read', async () => {
          await session.withTransaction(async () => {
            expect(await accounts().find({}, { session }).toArray()).toHaveLength(2)
            expect(await accounts().findOne({ _id: 'a' }, { session })).toMatchObject({ balance: 100 })
            expect(await accounts().countDocuments({}, { session })).toStrictEqual(2)
            expect((await accounts().distinct('balance', {}, { session })).toSorted()).toStrictEqual([0, 100])
            expect(await accounts().aggregate([{ $count: 'n' }], { session }).toArray()).toStrictEqual([{ n: 2 }])
          })
        })
      })

      describe('the explicit form', () => {
        it('should commit what startTransaction opened', async () => {
          session.startTransaction()
          await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } }, { session })
          await session.commitTransaction()

          expect((await balances()).a).toStrictEqual(90)
        })

        it('should discard what abortTransaction rolls back', async () => {
          session.startTransaction()
          await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } }, { session })
          await session.abortTransaction()

          expect((await balances()).a).toStrictEqual(100)
        })

        it('should report whether a transaction is in progress', async () => {
          expect(session.inTransaction()).toStrictEqual(false)
          session.startTransaction()
          expect(session.inTransaction()).toStrictEqual(true)
          await session.commitTransaction()
          expect(session.inTransaction()).toStrictEqual(false)
        })

        it('should refuse to start a second transaction on one session', () => {
          session.startTransaction()
          expect(() => session.startTransaction()).toThrow(/already in progress/i)
        })

        it('should start a fresh transaction after one has committed', async () => {
          session.startTransaction()
          await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } }, { session })
          await session.commitTransaction()

          session.startTransaction()
          await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } }, { session })
          await session.abortTransaction()

          expect((await balances()).a).toStrictEqual(90)
        })

        it('should treat a second commit as a no-op', async () => {
          session.startTransaction()
          await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } }, { session })
          await session.commitTransaction()
          await session.commitTransaction()

          expect((await balances()).a).toStrictEqual(90)
        })

        it('should reject commit and abort with no transaction started', async () => {
          await expect(session.commitTransaction()).rejects.toThrow(/No transaction started/i)
          await expect(session.abortTransaction()).rejects.toThrow(/No transaction started/i)
        })

        it('should reject aborting twice', async () => {
          session.startTransaction()
          await session.abortTransaction()
          await expect(session.abortTransaction()).rejects.toThrow(/abortTransaction twice/i)
        })

        it('should reject commit after abort, and abort after commit', async () => {
          session.startTransaction()
          await session.abortTransaction()
          await expect(session.commitTransaction()).rejects.toThrow(/after calling abortTransaction/i)

          session.startTransaction()
          await session.commitTransaction()
          await expect(session.abortTransaction()).rejects.toThrow(/after calling commitTransaction/i)
        })
      })

      describe('the session itself', () => {
        it('should roll back an open transaction when the session ends', async () => {
          const other = client.startSession()
          other.startTransaction()
          await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } }, { session: other })
          await other.endSession()

          expect((await balances()).a).toStrictEqual(100)
        })

        it('should report having ended, and end idempotently', async () => {
          const other = client.startSession()
          expect(other.hasEnded).toStrictEqual(false)
          await other.endSession()
          expect(other.hasEnded).toStrictEqual(true)
          await other.endSession()
          expect(other.hasEnded).toStrictEqual(true)
        })

        it('should refuse an operation given an ended session', async () => {
          const other = client.startSession()
          await other.endSession()

          await expect(accounts().insertOne({ _id: 'z' }, { session: other }))
            .rejects.toThrow(/expired sessions/i)
        })

        it('should refuse a session belonging to another client', async () => {
          const second = await clientClass.connect(inject('mongoReplicaSetUri'))
          const foreign = second.startSession()
          try {
            await expect(accounts().insertOne({ _id: 'z' }, { session: foreign }))
              .rejects.toThrow(/same MongoClient/i)
          } finally {
            await foreign.endSession()
            await second.close()
          }
        })

        it('should compare equal only to itself', () => {
          const other = client.startSession()
          expect(session.equals(session)).toStrictEqual(true)
          expect(session.equals(other)).toStrictEqual(false)
        })

        it('should run an operation given a session outside any transaction', async () => {
          await accounts().insertOne({ _id: 'c', balance: 7 }, { session })
          expect((await balances()).c).toStrictEqual(7)
        })

        it('should accept a session on createIndex', async () => {
          expect(await accounts().createIndex({ balance: 1 }, { session })).toStrictEqual('balance_1')
        })
      })

      describe('withSession', () => {
        it('should hand a session to the callback and return its result', async () => {
          const result = await client.withSession(async (scoped: SessionLike) => {
            return await scoped.withTransaction(async () => {
              await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -25 } }, { session: scoped })
              return 'ok'
            })
          })

          expect(result).toStrictEqual('ok')
          expect((await balances()).a).toStrictEqual(75)
        })

        it('should end the session afterwards, even when the callback throws', async () => {
          let escaped: SessionLike | undefined
          await expect(client.withSession(async (scoped: SessionLike) => {
            escaped = scoped
            throw Error('no')
          })).rejects.toThrow('no')

          expect(escaped?.hasEnded).toStrictEqual(true)
        })
      })
    })
  }

  /**
   * What only this library can be asked about: the places a session cannot
   * behave the way a real one does, each an error rather than a surprise. The
   * reason is always the same - a SQLite transaction belongs to the CONNECTION,
   * so a session can check an operation but never route it.
   */
  describe('Sqlite only - where a session stops pretending', () => {
    let client: InstanceType<typeof ShimClient>

    beforeEach(async () => {
      client = await ShimClient.connect(':memory:')
    })

    afterEach(async () => {
      await client.close()
    })

    it('refuses an operation belonging to a different session while a transaction is open', async () => {
      const first = client.startSession()
      const second = client.startSession()
      const items = client.db('a').collection('items')

      await first.withTransaction(async () => {
        await items.insertOne({ _id: 1 } as any, { session: first })
        // MongoDB would run this OUTSIDE first's transaction. Here it cannot -
        // there is one connection - so it is refused rather than enrolled.
        await expect(items.insertOne({ _id: 2 } as any, { session: second }))
          .rejects.toThrow(/another session has a transaction open/)
      })
      await first.endSession()
      await second.endSession()
    })

    it('refuses a transaction that would span two databases', async () => {
      const session = client.startSession()
      await expect(session.withTransaction(async () => {
        await client.db('one').collection('t').insertOne({ _id: 1 } as any, { session })
        // A second db() is a second SQLite connection, and a transaction is a
        // property of one connection.
        await client.db('two').collection('t').insertOne({ _id: 2 } as any, { session })
      })).rejects.toThrow(/covers ONE database/)
      await session.endSession()
    })

    it('opens the transaction on the first operation that names the session', async () => {
      const session = client.startSession()
      const items = client.db('a').collection('items')

      await session.withTransaction(async () => {
        // Nothing named the session yet, so no transaction is open and this
        // write is its own - exactly as it would be on a real server, where a
        // transaction also starts with its first operation.
        await items.insertOne({ _id: 'before' } as any)
        await items.insertOne({ _id: 'inside' } as any, { session })
        throw Error('roll back')
      }).catch(() => {})

      expect(await items.countDocuments({ _id: 'before' })).toStrictEqual(1)
      expect(await items.countDocuments({ _id: 'inside' })).toStrictEqual(0)
      await session.endSession()
    })

    it('rejects something that is not a session', async () => {
      await expect(client.db('a').collection('t').insertOne({ _id: 1 } as any, { session: {} as any }))
        .rejects.toThrow(/must be a ClientSession/)
    })

    it('refuses to start a session on a closed client', async () => {
      const closed = await ShimClient.connect(':memory:')
      await closed.close()
      expect(() => closed.startSession()).toThrow(/closed/)
    })

    it('ends open sessions when the client closes, discarding their transactions', async () => {
      const path = ':memory:'
      const scoped = await ShimClient.connect(path)
      const items = scoped.db('a').collection('items')
      await items.insertOne({ _id: 1 } as any)

      const session = scoped.startSession()
      session.startTransaction()
      await items.deleteMany({}, { session })
      expect(await items.countDocuments({}, { session })).toStrictEqual(0)

      await scoped.close()
      expect(session.hasEnded).toStrictEqual(true)
    })

    it('nests db.withTransaction inside a session transaction, via SAVEPOINT', async () => {
      const db = client.db('a')
      const session = client.startSession()
      const items = db.collection('items')

      await session.withTransaction(async () => {
        await items.insertOne({ _id: 'outer' } as any, { session })
        // db.withTransaction is this library's own shape and still composes:
        // an inner failure rolls back only its own work.
        await expect(db.withTransaction(async () => {
          await items.insertOne({ _id: 'inner' } as any, { session })
          throw Error('inner')
        })).rejects.toThrow('inner')
      })

      expect(await items.countDocuments({ _id: 'outer' })).toStrictEqual(1)
      expect(await items.countDocuments({ _id: 'inner' })).toStrictEqual(0)
      await session.endSession()
    })
  })
})
