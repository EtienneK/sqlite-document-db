import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient as RealClient } from 'mongodb'
import { inject } from 'vitest'

import { MongoClient as ShimClient } from '../src/index.js'

/**
 * BACKLOG item 22: the `MongoClient`-shaped shim.
 *
 * The dual-engine harness fits this better than anything else in the suite: a
 * drop-in claim is precisely "the same code runs through both", so the tests
 * below are written ONCE and the only difference between the two runs is which
 * `MongoClient` was imported. If the shim's shape diverges, the shared code
 * stops compiling or stops passing.
 */
/**
 * The surface these tests use.
 *
 * Both clients are held at this type WITHOUT a cast, which is the compile-time
 * half of the claim: if the shim's shape drifts from the driver's, the shared
 * tests below stop building. It is deliberately not `typeof MongoClient` -
 * assignability to the driver's class is all-or-nothing over ~35 members
 * (DR-2), and source-level compatibility over the methods people actually call
 * is the target.
 */
interface DbLike {
  databaseName: string
  collection: (name: string) => any
  createCollection: (name: string, options?: any) => Promise<any>
  listCollections: () => { toArray: () => Promise<Array<{ name: string }>> }
  dropDatabase: () => Promise<unknown>
}
interface ClientLike {
  connect: () => Promise<unknown>
  db: (name?: string) => DbLike
  close: () => Promise<void>
}
type ClientClass = (new (url: string) => ClientLike) & { connect: (url: string) => Promise<ClientLike> }

describe('MongoClient', () => {
  // The real client gets a real server; the shim resolves the same connection
  // string to an in-memory database, which is the point of accepting it.
  const clients: Array<[string, ClientClass, () => string]> = [
    ['Sqlite', ShimClient, () => inject('mongoUri')],
    ['Mongodb', RealClient, () => inject('mongoUri')]
  ]

  for (const [name, clientClass, uri] of clients) {
    describe(name, () => {
      let client: ClientLike

      beforeEach(async () => {
        client = await clientClass.connect(uri())
      })

      afterEach(async () => {
        // The real server keeps what it was given; the shim's memory goes with it.
        if (name === 'Mongodb') await client.db('shim_a').dropDatabase()
        if (name === 'Mongodb') await client.db('shim_b').dropDatabase()
        await client.close()
      })

      it('connects, and the whole CRUD surface works through it', async () => {
        const items = client.db('shim_a').collection('items')
        await items.insertMany([
          { _id: 1, item: 'journal', qty: 25 },
          { _id: 2, item: 'notebook', qty: 50 }
        ] as any[])

        expect((await items.findOne({ _id: 1 } as any))?.item).toStrictEqual('journal')
        expect(await items.countDocuments({ qty: { $gt: 30 } })).toStrictEqual(1)
        await items.updateOne({ _id: 1 } as any, { $inc: { qty: 5 } })
        expect((await items.findOne({ _id: 1 } as any))?.qty).toStrictEqual(30)
        expect((await items.deleteOne({ _id: 2 } as any)).deletedCount).toStrictEqual(1)
        expect(await items.countDocuments({})).toStrictEqual(1)
      })

      it('aggregates through it too', async () => {
        await client.db('shim_a').collection('orders').insertMany([
          { cust: 'ann', total: 30 }, { cust: 'ann', total: 12 }, { cust: 'bob', total: 45 }
        ] as any[])

        expect(await client.db('shim_a').collection('orders').aggregate([
          { $group: { _id: '$cust', spent: { $sum: '$total' } } },
          { $sort: { _id: 1 } },
          { $project: { _id: 1, spent: 1 } }
        ]).toArray()).toStrictEqual([{ _id: 'ann', spent: 42 }, { _id: 'bob', spent: 45 }])
      })

      it('reaches the same data through two db() calls with the same name', async () => {
        // The real driver builds a fresh Db object each call, over one pooled
        // connection; the shim caches, because each Db here OWNS a connection
        // and a second in-memory one would be a second, empty database. What
        // both promise is this - the name is what identifies the data.
        await client.db('shim_a').collection('t').insertOne({ _id: 1 } as any)
        expect(await client.db('shim_a').collection('t').countDocuments({})).toStrictEqual(1)
      })

      it('reports the database name it was opened with', () => {
        expect(client.db('shim_a').databaseName).toStrictEqual('shim_a')
      })

      it('keeps two databases isolated', async () => {
        await client.db('shim_a').collection('t').insertOne({ _id: 1, from: 'a' } as any)
        await client.db('shim_b').collection('t').insertOne({ _id: 1, from: 'b' } as any)

        expect((await client.db('shim_a').collection('t').findOne({} as any))?.from).toStrictEqual('a')
        expect((await client.db('shim_b').collection('t').findOne({} as any))?.from).toStrictEqual('b')
      })

      it('creates a collection by name, and lists it', async () => {
        await client.db('shim_a').createCollection('made')
        await client.db('shim_a').collection('made').insertOne({ _id: 1 } as any)

        const names = (await client.db('shim_a').listCollections().toArray()).map(c => c.name)
        expect(names).toContain('made')
      })

      it('supports the constructor-then-connect form', async () => {
        const second = new clientClass(uri())
        await second.connect()
        await second.db('shim_a').collection('t').insertOne({ _id: 99 } as any)
        expect(await second.db('shim_a').collection('t').countDocuments({})).toStrictEqual(1)
        await second.close()
      })
    })
  }

  /**
   * What only the shim can be asked about: the places it deliberately differs
   * from a real client, each of which is an error rather than a surprise.
   */
  describe('Sqlite only - where the shim stops pretending', () => {
    it('resolves a mongodb:// URI to an in-memory database', async () => {
      const client = await ShimClient.connect('mongodb://localhost:27017/myapp')
      // The database in the URI path is the default, as it is for the driver.
      expect(client.db().databaseName).toStrictEqual('myapp')
      await client.db().collection('t').insertOne({ _id: 1 } as any)
      expect(await client.db('myapp').collection('t').countDocuments({})).toStrictEqual(1)
      await client.close()
    })

    it("defaults to 'test' when the URI names no database", async () => {
      const client = await ShimClient.connect('mongodb://localhost:27017')
      expect(client.db().databaseName).toStrictEqual('test')
      await client.close()
    })

    it('opens a file path directly', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sdb-shim-'))
      try {
        const path = join(directory, 'app.db')
        const client = await ShimClient.connect(path)
        await client.db('one').collection('t').insertOne({ _id: 1, kept: true } as any)
        await client.close()

        const reopened = await ShimClient.connect(path)
        expect(await reopened.db('one').collection('t').countDocuments({})).toStrictEqual(1)
        await reopened.close()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    it('refuses a SECOND database name on a file, rather than merging them', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sdb-shim-'))
      try {
        const client = await ShimClient.connect(join(directory, 'app.db'))
        client.db('one')
        // A SQLite file IS a database. Handing back the same collections under
        // a second name is the silent merge tableNameFor exists to prevent.
        expect(() => client.db('two')).toThrow(/ONE database/)
        await client.close()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    it('ignores connection options a network client would use', async () => {
      // Refusing these would mean editing the line the shim exists to leave
      // alone, and they cannot make an answer wrong - there is no connection.
      const client = await ShimClient.connect('mongodb://localhost/app', {
        maxPoolSize: 50, tls: true, retryWrites: false, serverSelectionTimeoutMS: 5000
      })
      await client.db().collection('t').insertOne({ _id: 1 } as any)
      expect(await client.db().collection('t').countDocuments({})).toStrictEqual(1)
      await client.close()
    })

    it('passes this library\'s own options through', async () => {
      const client = await ShimClient.connect(':memory:', { strict: true })
      const t = client.db('a').collection('t')
      await t.insertOne({ _id: 1, sizes: [{ uom: 'cm' }] } as any)
      // strict rejects an aggregation path through an array; without it this
      // would quietly read as missing.
      await expect(t.aggregate([{ $project: { u: '$sizes.uom' } }]).toArray()).rejects.toThrow(/strict/)
      await client.close()
    })

    it('fails loudly on the surface it does not have', async () => {
      const client = await ShimClient.connect(':memory:')
      // Sessions and change streams both work now (test/client-session.spec.ts,
      // test/change-streams.spec.ts). What a change stream cannot do is resume
      // from a token, because there is no oplog to point one into - and it says
      // so rather than starting from now and calling that a resume.
      expect(() => client.watch([], { resumeAfter: { _data: '1' } })).toThrow(/oplog/)
      await client.close()
    })

    it('refuses to hand out a database after close', async () => {
      const client = await ShimClient.connect(':memory:')
      await client.close()
      expect(() => client.db('a')).toThrow(/closed/)
    })

    it('rejects a createCollection option it cannot honour', async () => {
      const client = await ShimClient.connect(':memory:')
      await expect(client.db('a').createCollection('c', { capped: true, size: 1000 }))
        .rejects.toThrow(/does not support/)
      await client.close()
    })
  })
})
