import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { seededDualDbs } from '../helpers/dual-dbs.js'

/**
 * Iterate a Cursor - https://www.mongodb.com/docs/manual/tutorial/iterate-a-cursor/
 *
 * The PARITY half of cursor behaviour: what a cursor returns, and in what
 * order, checked against a real server. [test/cursor.spec.ts](../cursor.spec.ts)
 * is the other half — statement lifetime, closing early, reuse after partial
 * iteration — and runs against this library alone, because none of it has a
 * MongoDB counterpart.
 */
describe('Iterate a Cursor - https://www.mongodb.com/docs/manual/tutorial/iterate-a-cursor/', () => {
  const items = Array.from({ length: 12 }, (_, n) => ({ _id: (n + 1) as any, n, even: n % 2 === 0 }))

  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('items').insertMany(structuredClone(items))
    await mongo().collection('items').insertMany(structuredClone(items))
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const col = (): any => db().collection('items')

    describe(dbName, () => {
      it('should iterate with for await, in natural order', async () => {
        const seen: number[] = []
        for await (const doc of col().find({ even: true })) seen.push(doc.n)
        expect(seen).toStrictEqual([0, 2, 4, 6, 8, 10])
      })

      it('should walk one document at a time with next(), then return null', async () => {
        const cursor = col().find({ n: { $lt: 3 } })
        expect((await cursor.next()).n).toStrictEqual(0)
        expect((await cursor.next()).n).toStrictEqual(1)
        expect((await cursor.next()).n).toStrictEqual(2)
        expect(await cursor.next()).toBeNull()
        await cursor.close()
      })

      it('should return every matching document from toArray()', async () => {
        const all = await col().find({}).toArray()
        expect(all).toHaveLength(items.length)
        expect(all.map((d: any) => d.n)).toStrictEqual(items.map(i => i.n))
      })

      it('should yield nothing when nothing matches', async () => {
        expect(await col().find({ n: 999 }).toArray()).toStrictEqual([])
        const cursor = col().find({ n: 999 })
        expect(await cursor.next()).toBeNull()
        await cursor.close()
      })

      it('should honour sort, skip and limit while iterating', async () => {
        const seen: number[] = []
        for await (const doc of col().find({}).sort({ n: -1 }).skip(2).limit(3)) seen.push(doc.n)
        expect(seen).toStrictEqual([9, 8, 7])
      })

      it('should stop early when the loop breaks', async () => {
        const seen: number[] = []
        for await (const doc of col().find({})) {
          seen.push(doc.n)
          if (seen.length === 3) break
        }
        expect(seen).toStrictEqual([0, 1, 2])
      })

      it('should be closeable before it is exhausted, and closeable twice', async () => {
        const cursor = col().find({})
        expect((await cursor.next()).n).toStrictEqual(0)
        await cursor.close()
        await cursor.close() // idempotent on both
      })

      /**
       * What a cursor yields AFTER close() is deliberately not asserted here.
       * The two engines genuinely differ: the driver has already buffered a
       * batch client-side and keeps draining it, so `next()` returns the second
       * document; this library streams straight off a SQLite statement, so
       * close() finalizes it and `next()` is null immediately. Neither is
       * wrong, and there is no shared answer to pin.
       *
       * This library's side is pinned in test/cursor.spec.ts, which is
       * single-engine for exactly this reason.
       */
    })
  }
})
