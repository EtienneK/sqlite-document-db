import type { Db as Mdb } from 'mongodb'

import { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG item 11. Collection names used to be lowercased and then matched
 * against /^[a-z_]+[a-z0-9_]*$/, which had two consequences: ordinary names
 * like `my-data` were rejected, and - the real bug - `Users` and `users`
 * silently became ONE collection, quietly merging two sets of documents.
 * Identifiers are quoted now, so only MongoDB's own restrictions remain.
 */
describe('Collection names', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('should be case sensitive', async () => {
        await db().collection('Users').insertOne({ who: 'upper' } as any)
        await db().collection('users').insertOne({ who: 'lower' } as any)

        expect((await db().collection('Users').find().toArray()).map(d => d.who)).toStrictEqual(['upper'])
        expect((await db().collection('users').find().toArray()).map(d => d.who)).toStrictEqual(['lower'])
      })

      it('should accept names with hyphens, dots and digits', async () => {
        for (const name of ['my-data', 'audit.log', 'v2_items', 'ITEMS']) {
          await db().collection(name).insertOne({ name } as any)
          expect((await db().collection(name).findOne({}))?.name).toStrictEqual(name)
        }
      })
    })
  }

  // Rejections are enforced before any SQL is built, so they are checked
  // against this library alone - the driver defers most of them to the server.
  describe('rejected names', () => {
    it('should reject names MongoDB also rejects', async () => {
      const db = await Db.fromUrl(':memory:')
      for (const name of ['', 'has$dollar', 'system.profile', 'sqlite_master', 'nul\0byte', 'x'.repeat(201)]) {
        expect(() => db.collection(name)).toThrow()
      }
      await db.close()
    })

    it('should treat a name containing a quote as data, not SQL', async () => {
      const db = await Db.fromUrl(':memory:')
      const col = db.collection('we"ird')
      await col.insertOne({ v: 1 })
      expect(await col.countDocuments()).toStrictEqual(1)
      // A separate collection, not the same table under a mangled name
      expect(await db.collection('weird').countDocuments()).toStrictEqual(0)
      await db.close()
    })
  })
})
