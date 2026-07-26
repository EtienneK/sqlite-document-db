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
       * The rest of the cursor surface (BACKLOG item 33). Ported code reaches
       * for `hasNext()` constantly, and it is the one with a rule worth
       * pinning: it PEEKS, so the document it looked at is still the next one.
       */
      describe('the cursor methods', () => {
        it('hasNext should peek without consuming', async () => {
          const cursor = col().find({ n: { $lt: 2 } })
          expect(await cursor.hasNext()).toStrictEqual(true)
          expect(await cursor.hasNext()).toStrictEqual(true)
          expect((await cursor.next()).n).toStrictEqual(0)
          expect(await cursor.hasNext()).toStrictEqual(true)
          expect((await cursor.next()).n).toStrictEqual(1)
          expect(await cursor.hasNext()).toStrictEqual(false)
          expect(await cursor.next()).toBeNull()
          await cursor.close()
        })

        it('hasNext should be false straight away when nothing matches', async () => {
          const cursor = col().find({ n: 999 })
          expect(await cursor.hasNext()).toStrictEqual(false)
          await cursor.close()
        })

        it('tryNext should hand over the next document', async () => {
          const cursor = col().find({ n: { $lt: 2 } })
          expect((await cursor.tryNext()).n).toStrictEqual(0)
          expect((await cursor.tryNext()).n).toStrictEqual(1)
          expect(await cursor.tryNext()).toBeNull()
          await cursor.close()
        })

        it('forEach should visit every remaining document', async () => {
          const seen: number[] = []
          await col().find({ even: true }).forEach((doc: any) => { seen.push(doc.n) })
          expect(seen).toStrictEqual([0, 2, 4, 6, 8, 10])

          // Only what is LEFT, so it composes with next().
          const partial = col().find({ n: { $lt: 3 } })
          await partial.next()
          const rest: number[] = []
          await partial.forEach((doc: any) => { rest.push(doc.n) })
          expect(rest).toStrictEqual([1, 2])
        })

        it('map should give a cursor over transformed documents', async () => {
          expect(await col().find({ n: { $lt: 3 } }).map((doc: any) => doc.n * 10).toArray())
            .toStrictEqual([0, 10, 20])

          const mapped = col().find({ n: { $lt: 2 } }).map((doc: any) => doc.n)
          expect(await mapped.next()).toStrictEqual(0)
          expect(await mapped.hasNext()).toStrictEqual(true)
          expect(await mapped.next()).toStrictEqual(1)
          expect(await mapped.next()).toBeNull()

          const seen: number[] = []
          for await (const n of col().find({ n: { $lt: 3 } }).map((doc: any) => doc.n)) seen.push(n as number)
          expect(seen).toStrictEqual([0, 1, 2])
        })

        it('rewind should let a cursor be iterated again', async () => {
          const cursor = col().find({ n: { $lt: 3 } })
          expect((await cursor.next()).n).toStrictEqual(0)
          cursor.rewind()
          expect((await cursor.toArray()).map((d: any) => d.n)).toStrictEqual([0, 1, 2])
        })

        it('count should honour the cursor own skip and limit', async () => {
          expect(await col().find({}).count()).toStrictEqual(12)
          expect(await col().find({ even: true }).count()).toStrictEqual(6)
          expect(await col().find({}).limit(2).count()).toStrictEqual(2)
          expect(await col().find({}).skip(9).count()).toStrictEqual(3)
          expect(await col().find({}).skip(9).limit(2).count()).toStrictEqual(2)
        })
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
