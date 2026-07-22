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
          .sort((a: any, b: any) => a.name.localeCompare(b.name))

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
    })
  }
})
