import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

describe('Indexes (BACKLOG item 2)', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('createIndex should generate MongoDB-style names', async () => {
        const col = db().collection('items')
        expect(await col.createIndex({ qty: 1 })).toStrictEqual('qty_1')
        expect(await col.createIndex({ 'size.uom': 1, status: -1 })).toStrictEqual('size.uom_1_status_-1')
        expect(await col.createIndex('plain')).toStrictEqual('plain_1')
        expect(await col.createIndex({ named: 1 }, { name: 'my_index' })).toStrictEqual('my_index')
      })

      it('a unique index should reject duplicate values', async () => {
        const col = db().collection('users')
        await col.createIndex({ email: 1 }, { unique: true })
        await col.insertOne({ email: 'a@example.com' })
        await expect(col.insertOne({ email: 'a@example.com' })).rejects.toThrow()
        await col.insertOne({ email: 'b@example.com' })
        expect(await col.countDocuments()).toStrictEqual(2)
      })

      it('indexes() should list the _id index plus created ones', async () => {
        const col = db().collection('items')
        await col.createIndex({ qty: 1 })
        await col.createIndex({ 'size.uom': 1, status: -1 })

        const normalized = (await col.indexes())
          .map(({ name, key }: any) => ({ name, key }))
          .toSorted((a: any, b: any) => a.name.localeCompare(b.name))

        expect(normalized).toStrictEqual([
          { name: '_id_', key: { _id: 1 } },
          { name: 'qty_1', key: { qty: 1 } },
          { name: 'size.uom_1_status_-1', key: { 'size.uom': 1, status: -1 } }
        ])
      })

      it('dropIndex should remove the index and reject unknown names', async () => {
        const col = db().collection('items')
        await col.createIndex({ qty: 1 })
        await col.dropIndex('qty_1')
        expect((await col.indexes()).map((i: any) => i.name)).toStrictEqual(['_id_'])
        await expect(col.dropIndex('qty_1')).rejects.toThrow()
      })

      /** BACKLOG item 29. */
      describe('index properties', () => {
        it('a non-sparse unique index should treat every missing field as the SAME key', async () => {
          // The one that is easy to get wrong: a SQL unique index treats every
          // NULL as distinct, so without a companion index the second document
          // without the field would be accepted here and refused by a server.
          const col: any = db().collection('u1')
          await col.createIndex({ email: 1 }, { unique: true })
          await col.insertOne({ _id: 1, email: 'a@example.com' })
          await col.insertOne({ _id: 2 })
          await expect(col.insertOne({ _id: 3 })).rejects.toThrow()
          // ...and a stored null counts as the same absent key.
          await expect(col.insertOne({ _id: 4, email: null })).rejects.toThrow()
          expect(await col.countDocuments()).toStrictEqual(2)
        })

        it('a sparse unique index should ignore the documents without the field', async () => {
          const col: any = db().collection('u2')
          await col.createIndex({ email: 1 }, { unique: true, sparse: true })
          await col.insertMany([{ _id: 1, email: 'a@example.com' }, { _id: 2 }, { _id: 3 }])
          await expect(col.insertOne({ _id: 4, email: 'a@example.com' })).rejects.toThrow()
          expect(await col.countDocuments()).toStrictEqual(3)
        })

        it('a sparse index should still serve ordinary queries', async () => {
          const col: any = db().collection('s1')
          await col.insertMany([{ _id: 1, qty: 5 }, { _id: 2, qty: 15 }, { _id: 3 }])
          await col.createIndex({ qty: 1 }, { sparse: true })
          expect((await col.find({ qty: { $gt: 10 } }).toArray()).map((d: any) => d._id)).toStrictEqual([2])
        })

        it('a partialFilterExpression should constrain only the documents it covers', async () => {
          const col: any = db().collection('p1')
          await col.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $exists: true } } })
          await col.insertMany([{ _id: 1, email: 'a@example.com' }, { _id: 2 }, { _id: 3 }])
          await expect(col.insertOne({ _id: 4, email: 'a@example.com' })).rejects.toThrow()
          expect(await col.countDocuments()).toStrictEqual(3)
        })

        it('indexes() should report sparse and partialFilterExpression', async () => {
          const col: any = db().collection('meta')
          await col.createIndex({ a: 1 }, { sparse: true })
          await col.createIndex({ b: 1 }, { partialFilterExpression: { b: { $exists: true } } })
          const found = (await col.indexes()).filter((i: any) => i.name !== '_id_')
            .map(({ name, key, sparse, partialFilterExpression }: any) =>
              ({ name, key, sparse, partialFilterExpression }))
            .toSorted((x: any, y: any) => x.name.localeCompare(y.name))
          expect(found).toStrictEqual([
            { name: 'a_1', key: { a: 1 }, sparse: true, partialFilterExpression: undefined },
            { name: 'b_1', key: { b: 1 }, sparse: undefined, partialFilterExpression: { b: { $exists: true } } }
          ])
        })

        it('createIndexes should build several at once', async () => {
          const col: any = db().collection('many')
          expect(await col.createIndexes([{ key: { a: 1 } }, { key: { b: -1 }, name: 'bee' }]))
            .toStrictEqual(['a_1', 'bee'])
          expect((await col.indexes()).map((i: any) => i.name).toSorted())
            .toStrictEqual(['_id_', 'a_1', 'bee'])
        })

        it('indexExists should answer for one name or several', async () => {
          const col: any = db().collection('exists')
          await col.createIndex({ a: 1 })
          expect(await col.indexExists('a_1')).toStrictEqual(true)
          expect(await col.indexExists('nope')).toStrictEqual(false)
          expect(await col.indexExists(['a_1', '_id_'])).toStrictEqual(true)
          expect(await col.indexExists(['a_1', 'nope'])).toStrictEqual(false)
        })

        it('dropIndexes should leave only the _id index', async () => {
          const col: any = db().collection('sweep')
          await col.createIndexes([{ key: { a: 1 } }, { key: { b: 1 } }])
          await col.dropIndexes()
          expect((await col.indexes()).map((i: any) => i.name)).toStrictEqual(['_id_'])
        })

        it('hint should force an index, and reject one that does not exist', async () => {
          const col: any = db().collection('hinted')
          await col.insertMany([{ _id: 1, qty: 5 }, { _id: 2, qty: 15 }, { _id: 3, qty: 25 }])
          await col.createIndex({ qty: 1 })
          expect((await col.find({ qty: { $gt: 10 } }, { hint: 'qty_1' }).toArray()).map((d: any) => d._id))
            .toStrictEqual([2, 3])
          expect((await col.find({ qty: { $gt: 10 } }, { hint: { qty: 1 } }).toArray()).map((d: any) => d._id))
            .toStrictEqual([2, 3])
          expect(await col.countDocuments({ qty: { $gt: 10 } }, { hint: 'qty_1' })).toStrictEqual(2)
          await expect(col.find({ qty: 5 }, { hint: 'no_such_index' }).toArray()).rejects.toThrow()
        })
      })
    })
  }

  /**
   * This library only: what a partial index can HOLD is a SQLite constraint,
   * not a MongoDB one, so there is nothing to compare against.
   */
  describe('Sqlite only - what a partialFilterExpression may contain', () => {
    const col = (): any => dbs.sqlite().collection('partial')

    it('should refuse a predicate that needs a subquery, and say why', async () => {
      // Every comparison this compiler emits carries an array-element arm - an
      // EXISTS - because { status: 'A' } also has to match { status: ['A'] },
      // and SQLite forbids a subquery in a partial index. Refusing is the only
      // alternative to building an index over fewer documents than MongoDB's.
      await expect(col().createIndex({ qty: 1 }, { partialFilterExpression: { status: 'A' } }))
        .rejects.toThrow(/subqueries in a partial index/)
      await expect(col().createIndex({ qty: 1 }, { partialFilterExpression: { qty: { $gt: 5 } } }))
        .rejects.toThrow(/subqueries in a partial index/)
    })

    it('should accept $exists, $and and $or', async () => {
      await col().createIndex({ a: 1 }, { name: 'e1', partialFilterExpression: { a: { $exists: true } } })
      await col().createIndex({ b: 1 }, {
        name: 'e2',
        partialFilterExpression: { $or: [{ b: { $exists: true } }, { c: { $exists: true } }] }
      })
      expect((await col().indexes()).map((i: any) => i.name).toSorted()).toStrictEqual(['_id_', 'e1', 'e2'])
    })

    it('should reject the options it cannot honour rather than ignoring them', async () => {
      await expect(col().createIndex({ a: 1 }, { hidden: true })).rejects.toThrow(/hidden/)
      await expect(col().createIndex({ a: 1 }, { expireAfterSeconds: 60 })).rejects.toThrow(/expireAfterSeconds/)
      await expect(col().createIndex({ a: 1 }, { collation: {} })).rejects.toThrow(/collation/)
      await expect(col().createIndex({ a: 1 }, { sparse: true, partialFilterExpression: { a: { $exists: true } } }))
        .rejects.toThrow()
    })
  })
})
