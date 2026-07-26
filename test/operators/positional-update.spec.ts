import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { freshDualDbs } from '../helpers/dual-dbs.js'

/**
 * BACKLOG item 4, the last of it: `$position` inside `$push`, and the
 * positional update operators `$`, `$[]` and `$[<identifier>]`.
 *
 * All four write THROUGH an array, which is the reason they were left until
 * last: a single `json_set` addresses one literal path, and these address a
 * computed one, all of them, or the ones matching a criterion.
 */

const students = [
  {
    _id: 1,
    name: 'ada',
    tags: ['red', 'green', 'blue'],
    nums: [1, 2, 3],
    grades: [{ subject: 'maths', score: 90 }, { subject: 'art', score: 45 }, { subject: 'science', score: 55 }]
  },
  {
    _id: 2,
    name: 'bob',
    tags: ['green'],
    nums: [10],
    grades: [{ subject: 'art', score: 30 }]
  }
]

describe('positional update operators', () => {
  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('s').insertMany(structuredClone(students) as any[])
    await mongo().collection('s').insertMany(structuredClone(students) as any[])
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()
    const doc = async (id = 1): Promise<any> => await db().collection('s').findOne({ _id: id } as any)

    describe(dbName, () => {
      describe('$position inside $push', () => {
        it('inserts at an index instead of appending', async () => {
          await db().collection('s').updateOne({ _id: 1 } as any, {
            $push: { tags: { $each: ['X', 'Y'], $position: 1 } }
          } as any)
          expect((await doc()).tags).toStrictEqual(['red', 'X', 'Y', 'green', 'blue'])
        })

        it('counts a negative position back from the end', async () => {
          await db().collection('s').updateOne({ _id: 1 } as any, {
            $push: { tags: { $each: ['X'], $position: -1 } }
          } as any)
          expect((await doc()).tags).toStrictEqual(['red', 'green', 'X', 'blue'])
        })

        it('clamps a position past either end', async () => {
          await db().collection('s').updateOne({ _id: 1 } as any, {
            $push: { tags: { $each: ['X'], $position: 99 } }
          } as any)
          expect((await doc()).tags).toStrictEqual(['red', 'green', 'blue', 'X'])

          await db().collection('s').updateOne({ _id: 2 } as any, {
            $push: { tags: { $each: ['X'], $position: -99 } }
          } as any)
          expect((await doc(2)).tags).toStrictEqual(['X', 'green'])
        })

        it('inserts BEFORE $sort and $slice are applied', async () => {
          await db().collection('s').updateOne({ _id: 1 } as any, {
            $push: { nums: { $each: [0, 9], $position: 0, $sort: 1, $slice: 3 } }
          } as any)
          expect((await doc()).nums).toStrictEqual([0, 1, 2])
        })

        it('keeps types through the insert', async () => {
          await db().collection('s').updateOne({ _id: 2 } as any, {
            $push: { nums: { $each: [true, { a: 1 }, null], $position: 0 } }
          } as any)
          expect((await doc(2)).nums).toStrictEqual([true, { a: 1 }, null, 10])
        })

        it('is rejected in $addToSet, which has no order to insert into', async () => {
          await expect(db().collection('s').updateOne({ _id: 1 } as any, {
            $addToSet: { tags: { $each: ['X'], $position: 0 } }
          } as any)).rejects.toThrow()
        })
      })

      describe('$ - the element the query matched', () => {
        it('writes to the matched element itself', async () => {
          await db().collection('s').updateOne({ tags: 'green' } as any, { $set: { 'tags.$': 'GREEN' } } as any)
          expect((await doc()).tags).toStrictEqual(['red', 'GREEN', 'blue'])
        })

        it('writes to a field of the matched element', async () => {
          await db().collection('s').updateOne(
            { 'grades.score': { $lt: 50 } } as any,
            { $set: { 'grades.$.score': 50 } } as any
          )
          expect((await doc()).grades).toStrictEqual([
            { subject: 'maths', score: 90 }, { subject: 'art', score: 50 }, { subject: 'science', score: 55 }
          ])
        })

        it('works with $inc, $mul, $min, $max and $unset', async () => {
          await db().collection('s').updateOne(
            { 'grades.subject': 'art' } as any, { $inc: { 'grades.$.score': 5 } } as any
          )
          expect((await doc()).grades[1]).toStrictEqual({ subject: 'art', score: 50 })

          await db().collection('s').updateOne(
            { 'grades.subject': 'art' } as any, { $max: { 'grades.$.score': 70 } } as any
          )
          expect((await doc()).grades[1]).toStrictEqual({ subject: 'art', score: 70 })

          await db().collection('s').updateOne(
            { 'grades.subject': 'art' } as any, { $unset: { 'grades.$.score': '' } } as any
          )
          expect((await doc()).grades[1]).toStrictEqual({ subject: 'art' })
        })

        it('leaves a null when it unsets the element itself', async () => {
          await db().collection('s').updateOne({ tags: 'green' } as any, { $unset: { 'tags.$': '' } } as any)
          expect((await doc()).tags).toStrictEqual(['red', null, 'blue'])
        })

        it('updates each matched document at its OWN first match', async () => {
          await db().collection('s').updateMany({ tags: 'green' } as any, { $set: { 'tags.$': 'G' } } as any)
          expect((await doc()).tags).toStrictEqual(['red', 'G', 'blue'])
          expect((await doc(2)).tags).toStrictEqual(['G'])
        })

        it('takes the condition from an $and and from an $elemMatch', async () => {
          await db().collection('s').updateOne(
            { $and: [{ name: 'ada' }, { 'grades.score': { $lt: 50 } }] } as any,
            { $set: { 'grades.$.flagged': true } } as any
          )
          expect((await doc()).grades[1].flagged).toBe(true)

          await db().collection('s').updateOne(
            { grades: { $elemMatch: { subject: 'science' } } } as any,
            { $set: { 'grades.$.flagged': false } } as any
          )
          expect((await doc()).grades[2].flagged).toBe(false)
        })

        it('is refused when the query says nothing about the array', async () => {
          await expect(db().collection('s').updateOne(
            { name: 'ada' } as any, { $set: { 'tags.$': 'X' } } as any
          )).rejects.toThrow()
        })
      })

      describe('$[] - every element', () => {
        it('writes to a field of every element', async () => {
          await db().collection('s').updateMany({} as any, { $inc: { 'grades.$[].score': 10 } } as any)
          expect((await doc()).grades.map((g: any) => g.score)).toStrictEqual([100, 55, 65])
          expect((await doc(2)).grades.map((g: any) => g.score)).toStrictEqual([40])
        })

        it('writes to every element itself', async () => {
          await db().collection('s').updateOne({ _id: 1 } as any, { $set: { 'tags.$[]': 'same' } } as any)
          expect((await doc()).tags).toStrictEqual(['same', 'same', 'same'])

          await db().collection('s').updateOne({ _id: 1 } as any, { $mul: { 'nums.$[]': 3 } } as any)
          expect((await doc()).nums).toStrictEqual([3, 6, 9])
        })

        it('needs no condition on the array at all', async () => {
          await db().collection('s').updateOne({ name: 'bob' } as any, { $set: { 'tags.$[]': 'B' } } as any)
          expect((await doc(2)).tags).toStrictEqual(['B'])
        })

        it('leaves a missing or empty array alone', async () => {
          await db().collection('s').insertOne({ _id: 3, name: 'cid', tags: [] } as any)
          await db().collection('s').updateOne({ _id: 3 } as any, { $set: { 'tags.$[]': 'X' } } as any)
          expect((await doc(3)).tags).toStrictEqual([])
        })
      })

      describe('$[<identifier>] - the elements arrayFilters names', () => {
        it('writes only to elements matching the filter', async () => {
          await db().collection('s').updateMany(
            {} as any,
            { $set: { 'grades.$[low].score': 0 } } as any,
            { arrayFilters: [{ 'low.score': { $lt: 50 } }] }
          )
          expect((await doc()).grades.map((g: any) => g.score)).toStrictEqual([90, 0, 55])
          expect((await doc(2)).grades.map((g: any) => g.score)).toStrictEqual([0])
        })

        it('matches elements of a scalar array by the identifier itself', async () => {
          await db().collection('s').updateOne(
            { _id: 1 } as any,
            { $inc: { 'nums.$[big]': 100 } } as any,
            { arrayFilters: [{ big: { $gte: 2 } }] }
          )
          expect((await doc()).nums).toStrictEqual([1, 102, 103])
        })

        it('takes the whole criterion language in a filter', async () => {
          await db().collection('s').updateOne(
            { _id: 1 } as any,
            { $set: { 'grades.$[g].passed': true } } as any,
            { arrayFilters: [{ $and: [{ 'g.score': { $gte: 50 } }, { 'g.subject': { $ne: 'maths' } }] }] as any }
          )
          expect((await doc()).grades.map((g: any) => g.passed)).toStrictEqual([undefined, undefined, true])
        })

        it('is refused when an identifier has no filter, or a filter goes unused', async () => {
          await expect(db().collection('s').updateOne(
            {} as any, { $set: { 'grades.$[x].score': 1 } } as any
          )).rejects.toThrow()

          await expect(db().collection('s').updateOne(
            {} as any, { $set: { 'grades.$[x].score': 1 } } as any,
            { arrayFilters: [{ 'x.score': { $lt: 1 } }, { 'y.score': { $lt: 1 } }] }
          )).rejects.toThrow()
        })
      })

      it('still rejects two operators conflicting on the same positional path', async () => {
        await expect(db().collection('s').updateOne(
          { tags: 'green' } as any,
          { $set: { 'tags.$': 'a' }, $unset: { 'tags.$': '' } } as any
        )).rejects.toThrow()
      })
    })
  }
})
