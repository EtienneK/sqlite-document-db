import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * The rest of the `Collection`/`Db` surface (BACKLOG item 15): `bulkWrite`,
 * `estimatedDocumentCount`, `countDocuments` windows, unordered `insertMany`,
 * `listCollections` and `dropDatabase`.
 */
describe('bulkWrite and the admin surface', () => {
  const seed = [
    { _id: 1 as any, item: 'a', qty: 10, status: 'A' },
    { _id: 2 as any, item: 'b', qty: 20, status: 'A' },
    { _id: 3 as any, item: 'c', qty: 30, status: 'D' },
    { _id: 4 as any, item: 'd', qty: 40, status: 'D' },
    { _id: 5 as any, item: 'e', qty: 50, status: 'P' }
  ]

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(structuredClone(seed) as any)
    await mongo().collection('items').insertMany(structuredClone(seed) as any)
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const items = (): any => db().collection('items')

    describe(dbName, () => {
      describe('counting', () => {
        it('estimatedDocumentCount should count everything', async () => {
          expect(await items().estimatedDocumentCount()).toStrictEqual(5)
        })

        it('countDocuments should apply limit and skip to the MATCHED set', async () => {
          expect(await items().countDocuments({})).toStrictEqual(5)
          expect(await items().countDocuments({}, { limit: 2 })).toStrictEqual(2)
          expect(await items().countDocuments({}, { skip: 3 })).toStrictEqual(2)
          expect(await items().countDocuments({}, { skip: 1, limit: 2 })).toStrictEqual(2)
          // A limit larger than the match count does not invent rows.
          expect(await items().countDocuments({ status: 'A' }, { limit: 99 })).toStrictEqual(2)
          expect(await items().countDocuments({ status: 'A' }, { skip: 5 })).toStrictEqual(0)
        })
      })

      describe('insertMany({ ordered: false })', () => {
        it('should insert everything it can and still report the failure', async () => {
          const error = await items().insertMany(
            [{ _id: 6 }, { _id: 1 }, { _id: 7 }], { ordered: false }
          ).catch((e: any) => e)
          expect(error).toBeDefined()
          // 6 and 7 land even though 1 (in the middle) is a duplicate - an
          // ordered insert would have stopped and never tried 7.
          expect(await items().countDocuments({ _id: { $in: [6, 7] } })).toStrictEqual(2)
        })

        it('should still insert everything when nothing fails', async () => {
          const result = await items().insertMany([{ _id: 8 }, { _id: 9 }], { ordered: false })
          expect(result.insertedCount).toStrictEqual(2)
        })
      })

      describe('bulkWrite', () => {
        it('should apply a mixed batch and report each count', async () => {
          const result = await items().bulkWrite([
            { insertOne: { document: { _id: 6, item: 'f', qty: 60, status: 'A' } } },
            { updateOne: { filter: { _id: 1 }, update: { $set: { status: 'X' } } } },
            { updateMany: { filter: { status: 'D' }, update: { $inc: { qty: 1 } } } },
            { deleteOne: { filter: { _id: 5 } } }
          ])
          expect(result.insertedCount).toStrictEqual(1)
          expect(result.matchedCount).toStrictEqual(3) // 1 + 2
          expect(result.modifiedCount).toStrictEqual(3)
          expect(result.deletedCount).toStrictEqual(1)

          expect((await items().findOne({ _id: 1 })).status).toStrictEqual('X')
          expect((await items().findOne({ _id: 3 })).qty).toStrictEqual(31)
          expect(await items().countDocuments({ _id: 5 })).toStrictEqual(0)
        })

        it('should report insertedIds keyed by operation index', async () => {
          const result = await items().bulkWrite([
            { deleteOne: { filter: { _id: 5 } } },
            { insertOne: { document: { _id: 6 } } }
          ])
          expect(result.insertedIds).toStrictEqual({ 1: 6 })
        })

        it('should support replaceOne and deleteMany', async () => {
          const result = await items().bulkWrite([
            { replaceOne: { filter: { _id: 1 }, replacement: { item: 'replaced' } } },
            { deleteMany: { filter: { status: 'D' } } }
          ])
          expect(result.modifiedCount).toStrictEqual(1)
          expect(result.deletedCount).toStrictEqual(2)
          expect((await items().findOne({ _id: 1 })).item).toStrictEqual('replaced')
        })

        it('should support upsert, reporting upsertedIds by index', async () => {
          const result = await items().bulkWrite([
            { updateOne: { filter: { _id: 99 }, update: { $set: { item: 'new' } }, upsert: true } }
          ])
          expect(result.upsertedCount).toStrictEqual(1)
          expect(result.upsertedIds).toStrictEqual({ 0: 99 })
          expect((await items().findOne({ _id: 99 })).item).toStrictEqual('new')
        })

        it('should stop at the first failure when ordered', async () => {
          await expect(items().bulkWrite([
            { insertOne: { document: { _id: 6 } } },
            { insertOne: { document: { _id: 1 } } }, // duplicate
            { insertOne: { document: { _id: 7 } } }
          ])).rejects.toThrow()
          expect(await items().countDocuments({ _id: 6 })).toStrictEqual(1)
          expect(await items().countDocuments({ _id: 7 })).toStrictEqual(0) // never attempted
        })

        it('should attempt everything when unordered', async () => {
          await expect(items().bulkWrite([
            { insertOne: { document: { _id: 6 } } },
            { insertOne: { document: { _id: 1 } } }, // duplicate
            { insertOne: { document: { _id: 7 } } }
          ], { ordered: false })).rejects.toThrow()
          expect(await items().countDocuments({ _id: 6 })).toStrictEqual(1)
          expect(await items().countDocuments({ _id: 7 })).toStrictEqual(1) // attempted anyway
        })

        it('should reject an empty batch', async () => {
          await expect(items().bulkWrite([])).rejects.toThrow()
        })

        it('should surface the UNDERLYING error, not one raised while reporting it', async () => {
          // insertMany attaches a non-writable `result` to the error it throws;
          // bulkWrite adding its own report with Object.assign threw
          // "Cannot assign to read only property" and replaced the duplicate-key
          // error with a TypeError.
          const error = await items().bulkWrite([
            { insertOne: { document: { _id: 1 } } } // duplicate
          ]).catch((e: any) => e)
          expect(error.code).toStrictEqual(11000)
          expect(String(error.message)).not.toContain('read only property')
        })

        it('should report what completed on the thrown error', async () => {
          const error = await items().bulkWrite([
            { deleteOne: { filter: { _id: 5 } } },
            { insertOne: { document: { _id: 1 } } } // duplicate
          ]).catch((e: any) => e)
          expect(error.result.deletedCount).toStrictEqual(1)
        })
      })
    })
  }

  /** BACKLOG item 33. */
  describe('renameCollection', () => {
    for (const dbName of ['Sqlite', 'Mongodb']) {
      const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

      describe(dbName, () => {
        it('should move the documents, and the indexes with them', async () => {
          const items: any = db().collection('items')
          await items.createIndex({ qty: 1 })
          const renamed: any = await items.rename('archive')

          expect(renamed.collectionName).toStrictEqual('archive')
          expect(await renamed.countDocuments({})).toStrictEqual(5)
          expect((await renamed.indexes()).map((i: any) => i.name).toSorted())
            .toStrictEqual(['_id_', 'qty_1'])
          // The index still WORKS, not just still exists.
          expect((await renamed.find({ qty: { $gt: 30 } }).toArray()).map((d: any) => d._id))
            .toStrictEqual([4, 5])
        })

        it('should be reachable under the new name and empty under the old one', async () => {
          await (db().collection('items') as any).rename('archive')
          expect(await (db().collection('archive') as any).countDocuments({})).toStrictEqual(5)
          // The source is gone: MongoDB creates collections lazily and this
          // library eagerly, so "empty" is the one answer both give.
          expect(await (db().collection('items') as any).countDocuments({})).toStrictEqual(0)
        })

        it('should refuse an existing target unless told to drop it', async () => {
          const other: any = db().collection('other')
          await other.insertOne({ _id: 99 })
          await expect((db().collection('items') as any).rename('other')).rejects.toThrow()

          const renamed: any = await (db().collection('items') as any).rename('other', { dropTarget: true })
          expect(await renamed.countDocuments({})).toStrictEqual(5)
        })

        it('should reject a rename onto itself and an invalid name', async () => {
          await expect((db().collection('items') as any).rename('items')).rejects.toThrow()
          await expect((db().collection('items') as any).rename('')).rejects.toThrow()
        })

        it('db.renameCollection should do the same thing from the other end', async () => {
          const renamed: any = await (db() as any).renameCollection('items', 'archive')
          expect(await renamed.countDocuments({})).toStrictEqual(5)
        })
      })
    }

    it('Sqlite only - a renamed collection keeps its awkward name and its registry row', async () => {
      // `tableNameFor` sends an awkward name to collectionx_<slug>_<digest>,
      // which is not reversible - so the rename has to move the registry row
      // too or listCollections() loses the collection.
      const db = dbs.sqlite()
      await db.collection('Mixed-Case.Name').insertOne({ _id: 'x' } as any)
      await db.renameCollection('Mixed-Case.Name', 'Another-Awkward.One')

      const names = (await db.listCollections().toArray()).map(c => c.name)
      expect(names).toContain('Another-Awkward.One')
      expect(names).not.toContain('Mixed-Case.Name')
      expect(await db.collection('Another-Awkward.One').countDocuments({})).toStrictEqual(1)
    })

    it('Sqlite only - the cached Collection under the OLD name must not be reused', async () => {
      const db = dbs.sqlite()
      const before = db.collection('items')
      await before.rename('archive')
      // `before` is bound to a table that no longer exists; asking the Db for
      // the name again has to rebuild it rather than hand back the dead one.
      expect(await db.collection('items').countDocuments({})).toStrictEqual(0)
      expect(await db.collection('archive').countDocuments({})).toStrictEqual(5)
    })
  })

  /** BACKLOG item 33: diagnostics. `db.command()` stays unimplemented. */
  describe('Sqlite only - db.stats()', () => {
    it('should report exact counts and SQLite page arithmetic', async () => {
      const db = dbs.sqlite()
      await db.collection('extra').insertMany([{ _id: 'a' } as any, { _id: 'b' } as any])
      const stats = await db.stats()

      // The counts mean what they do on MongoDB.
      expect(stats.collections).toStrictEqual(2)
      expect(stats.objects).toStrictEqual(7)
      expect(stats.dataSize).toBeGreaterThan(0)
      expect(stats.avgObjSize).toStrictEqual(stats.dataSize / stats.objects)
      // Each collection has its _id index, and the name registry's own does
      // not count as one a caller created.
      expect(stats.indexes).toStrictEqual(2)
      // The byte figures describe the FILE, and are not MongoDB's.
      expect(stats.storageSize).toBeGreaterThan(0)
      expect(stats.totalSize).toStrictEqual(stats.storageSize)
      expect(stats.indexSize).toBeGreaterThanOrEqual(0)
      expect(stats.ok).toStrictEqual(1)
    })
  })

  /**
   * This library only. `listCollections` and `dropDatabase` exist on the driver
   * too, but the interesting behaviour here is the name REGISTRY - MongoDB has
   * no equivalent problem, because its collection names are not mangled into
   * SQLite identifiers.
   */
  describe('Sqlite only - listCollections and dropDatabase', () => {
    it('should list collections by the name they were opened with', async () => {
      const db = dbs.sqlite()
      db.collection('plain')
      db.collection('With-Awkward.Chars')
      db.collection('Users')
      db.collection('users')

      const names = (await db.listCollections().toArray()).map(c => c.name)
      expect(names).toContain('plain')
      // The awkward one maps to collectionx_<slug>_<digest>, which cannot be
      // reversed - only the registry knows what it was called.
      expect(names).toContain('With-Awkward.Chars')
      // Case-sensitive, and both survive as distinct collections.
      expect(names).toContain('Users')
      expect(names).toContain('users')
      expect(names.every(n => !n.startsWith('collection'))).toStrictEqual(true)
    })

    it('should describe each entry the way the driver does', async () => {
      const db = dbs.sqlite()
      db.collection('described')
      const entry = (await db.listCollections().toArray()).find(c => c.name === 'described')
      expect(entry).toStrictEqual({ name: 'described', type: 'collection' })
    })

    it('should not list the registry itself', async () => {
      const names = (await dbs.sqlite().listCollections().toArray()).map(c => c.name)
      expect(names).not.toContain('_sdb_collections')
    })

    it('should stop listing a dropped collection', async () => {
      const db = dbs.sqlite()
      db.collection('temporary')
      expect((await db.listCollections().toArray()).map(c => c.name)).toContain('temporary')
      await db.collection('temporary').drop()
      expect((await db.listCollections().toArray()).map(c => c.name)).not.toContain('temporary')
    })

    it('dropDatabase should remove everything and stay usable', async () => {
      const db = dbs.sqlite()
      db.collection('a')
      db.collection('b')
      expect(await db.dropDatabase()).toStrictEqual(true)
      expect(await db.listCollections().toArray()).toStrictEqual([])

      // The cache must have been cleared, or this hands back a Collection
      // bound to a dropped table.
      await db.collection('a').insertOne({ _id: 'fresh' } as any)
      expect(await db.collection('a').countDocuments({})).toStrictEqual(1)
      expect((await db.listCollections().toArray()).map(c => c.name)).toStrictEqual(['a'])
    })
  })
})
