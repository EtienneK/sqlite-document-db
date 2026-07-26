import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { freshDualDbs, seededDualDbs } from '../helpers/dual-dbs.js'

/**
 * BACKLOG item 7: the projection `$`-operators - `$slice`, `$elemMatch` and
 * `$` positional.
 *
 * The rules worth having an oracle for are the ones about MODE: `$slice`
 * decides nothing about inclusion or exclusion (a spec of nothing but `$slice`
 * returns whole documents with one field shortened), while `$elemMatch` and `$`
 * are inclusions. Nobody would guess that from the names.
 */

const docs = [
  {
    _id: 1,
    name: 'first',
    tags: ['a', 'b', 'c', 'd'],
    grades: [
      { subject: 'maths', score: 90 },
      { subject: 'art', score: 60 },
      { subject: 'science', score: 85 }
    ],
    scalar: 7
  },
  { _id: 2, name: 'second', tags: ['x'], grades: [{ subject: 'art', score: 95 }], scalar: 'text' },
  { _id: 3, name: 'third', tags: [], grades: [] }
]

describe('projection $-operators', () => {
  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('t').insertMany(structuredClone(docs) as any[])
    await mongo().collection('t').insertMany(structuredClone(docs) as any[])
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    const project = async (projection: any, filter: any = {}): Promise<any[]> =>
      await db().collection('t').find(filter, { projection }).sort({ _id: 1 }).toArray()

    describe(dbName, () => {
      describe('$slice', () => {
        it('takes the first n, or the last n when negative', async () => {
          expect((await project({ tags: { $slice: 2 } })).map(d => d.tags))
            .toStrictEqual([['a', 'b'], ['x'], []])
          expect((await project({ tags: { $slice: -2 } })).map(d => d.tags))
            .toStrictEqual([['c', 'd'], ['x'], []])
          // Past the end just stops.
          expect((await project({ tags: { $slice: 99 } })).map(d => d.tags))
            .toStrictEqual([['a', 'b', 'c', 'd'], ['x'], []])
        })

        it('takes a window with [skip, limit]', async () => {
          expect((await project({ tags: { $slice: [1, 2] } })).map(d => d.tags))
            .toStrictEqual([['b', 'c'], [], []])
          // A negative skip counts from the end, and clamps at the start.
          expect((await project({ tags: { $slice: [-3, 2] } })).map(d => d.tags))
            .toStrictEqual([['b', 'c'], ['x'], []])
          // Skipping past the end leaves nothing.
          expect((await project({ tags: { $slice: [9, 2] } })).map(d => d.tags))
            .toStrictEqual([[], [], []])
        })

        it('decides NOTHING about inclusion or exclusion on its own', async () => {
          // The whole document comes back, with one field shortened - which is
          // what makes $slice different from every other projection operator.
          expect(await project({ tags: { $slice: 1 } })).toStrictEqual([
            { ...docs[0], tags: ['a'] },
            { ...docs[1], tags: ['x'] },
            { ...docs[2], tags: [] }
          ])
        })

        it('is an inclusion when the projection includes, and survives one that excludes', async () => {
          expect(await project({ name: 1, tags: { $slice: 2 } })).toStrictEqual([
            { _id: 1, name: 'first', tags: ['a', 'b'] },
            { _id: 2, name: 'second', tags: ['x'] },
            { _id: 3, name: 'third', tags: [] }
          ])
          const excluded = await project({ name: 0, grades: 0, scalar: 0, tags: { $slice: 1 } })
          expect(excluded).toStrictEqual([
            { _id: 1, tags: ['a'] }, { _id: 2, tags: ['x'] }, { _id: 3, tags: [] }
          ])
        })

        it('leaves a non-array field alone', async () => {
          expect((await project({ scalar: { $slice: 1 } })).map(d => d.scalar))
            .toStrictEqual([7, 'text', undefined])
        })

        it('works with the _id exemption', async () => {
          expect(await project({ _id: 0, name: 1, tags: { $slice: 1 } })).toStrictEqual([
            { name: 'first', tags: ['a'] }, { name: 'second', tags: ['x'] }, { name: 'third', tags: [] }
          ])
        })
      })

      describe('$elemMatch', () => {
        it('returns only the first matching element, as a one-element array', async () => {
          expect(await project({ grades: { $elemMatch: { score: { $gt: 80 } } } })).toStrictEqual([
            { _id: 1, grades: [{ subject: 'maths', score: 90 }] },
            { _id: 2, grades: [{ subject: 'art', score: 95 }] },
            { _id: 3 }
          ])
        })

        it('is an inclusion, so other fields need asking for', async () => {
          expect(await project({ name: 1, grades: { $elemMatch: { subject: 'art' } } })).toStrictEqual([
            { _id: 1, name: 'first', grades: [{ subject: 'art', score: 60 }] },
            { _id: 2, name: 'second', grades: [{ subject: 'art', score: 95 }] },
            { _id: 3, name: 'third' }
          ])
        })

        it('omits the field entirely when nothing matches, or when it is not an array', async () => {
          expect(await project({ grades: { $elemMatch: { score: { $gt: 999 } } } }))
            .toStrictEqual([{ _id: 1 }, { _id: 2 }, { _id: 3 }])
          expect(await project({ scalar: { $elemMatch: { $gt: 1 } } }))
            .toStrictEqual([{ _id: 1 }, { _id: 2 }, { _id: 3 }])
        })

        it('takes the whole criterion language, not just equality', async () => {
          expect(await project({ grades: { $elemMatch: { score: { $gte: 60, $lt: 90 } } } })).toStrictEqual([
            { _id: 1, grades: [{ subject: 'art', score: 60 }] },
            { _id: 2 },
            { _id: 3 }
          ])
          expect(await project({ tags: { $elemMatch: { $in: ['c', 'x'] } } })).toStrictEqual([
            { _id: 1, tags: ['c'] }, { _id: 2, tags: ['x'] }, { _id: 3 }
          ])
        })
      })

      describe('$ positional', () => {
        it('returns the element that matched the query', async () => {
          expect(await project({ 'grades.$': 1 }, { 'grades.score': { $gt: 80 } })).toStrictEqual([
            { _id: 1, grades: [{ subject: 'maths', score: 90 }] },
            { _id: 2, grades: [{ subject: 'art', score: 95 }] }
          ])
          expect(await project({ 'tags.$': 1 }, { tags: 'c' }))
            .toStrictEqual([{ _id: 1, tags: ['c'] }])
        })

        it('is an inclusion, and honours the _id exemption', async () => {
          expect(await project({ name: 1, 'grades.$': 1 }, { 'grades.score': { $gt: 80 } })).toStrictEqual([
            { _id: 1, name: 'first', grades: [{ subject: 'maths', score: 90 }] },
            { _id: 2, name: 'second', grades: [{ subject: 'art', score: 95 }] }
          ])
          expect(await project({ _id: 0, 'tags.$': 1 }, { tags: 'c' }))
            .toStrictEqual([{ tags: ['c'] }])
        })

        it('reads the condition out of an $and, and out of an $elemMatch', async () => {
          expect(await project(
            { 'grades.$': 1 },
            { $and: [{ name: 'first' }, { 'grades.score': { $lt: 80 } }] }
          )).toStrictEqual([{ _id: 1, grades: [{ subject: 'art', score: 60 }] }])

          expect(await project(
            { 'grades.$': 1 },
            { grades: { $elemMatch: { subject: 'science' } } }
          )).toStrictEqual([{ _id: 1, grades: [{ subject: 'science', score: 85 }] }])
        })

        it('is refused without a condition on the array, with exclusion, or twice', async () => {
          await expect(project({ 'grades.$': 1 }, {})).rejects.toThrow()
          await expect(project({ 'tags.$': 0 }, { tags: 'c' })).rejects.toThrow()
          await expect(project({ 'tags.$': 1, 'grades.$': 1 }, { tags: 'c', 'grades.score': 90 }))
            .rejects.toThrow()
        })
      })

      it('still rejects an inclusion/exclusion mix and an unknown operator', async () => {
        await expect(project({ name: 1, scalar: 0 })).rejects.toThrow()
        await expect(project({ tags: { $nope: 1 } })).rejects.toThrow()
      })
    })
  }
})

describe('projection $-operators on findOneAnd*', () => {
  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('t').insertMany(structuredClone(docs) as any[])
    await mongo().collection('t').insertMany(structuredClone(docs) as any[])
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      // These have no cursor to hang an extra column off, so the element index
      // is resolved with one dedicated statement instead.
      it('applies $elemMatch to the returned document', async () => {
        const before = await db().collection('t').findOneAndUpdate(
          { _id: 1 } as any,
          { $set: { name: 'renamed' } },
          { projection: { grades: { $elemMatch: { score: { $lt: 80 } } } } }
        )
        expect(before).toStrictEqual({ _id: 1, grades: [{ subject: 'art', score: 60 }] })
      })

      it('applies $slice and the positional operator', async () => {
        expect(await db().collection('t').findOneAndDelete(
          { _id: 1 } as any, { projection: { name: 1, tags: { $slice: 2 } } }
        )).toStrictEqual({ _id: 1, name: 'first', tags: ['a', 'b'] })

        expect(await db().collection('t').findOneAndUpdate(
          { tags: 'x' } as any, { $set: { seen: true } }, { projection: { 'tags.$': 1 } }
        )).toStrictEqual({ _id: 2, tags: ['x'] })
      })
    })
  }
})
