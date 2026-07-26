import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { seededDualDbs } from '../helpers/dual-dbs.js'

/**
 * BACKLOG item 16: the aggregation expression operators.
 *
 * Every assertion runs against a real MongoDB too, which is what settles the
 * rules nobody would guess: whether `$toLower` of a missing field is null or
 * the empty string, whether `$round` breaks ties away from zero or to even,
 * what `$arrayElemAt` does past the end of the array. Where this file and the
 * implementation disagreed, the server was right.
 */

const DATE = new Date('2021-03-09T14:05:06.789Z')

const docs = [
  {
    _id: 1,
    name: 'Ada Lovelace',
    qty: 10,
    price: 2.5,
    tags: ['maths', 'engines', 'notes'],
    scores: [3, 9, 6],
    at: DATE,
    nested: { flag: true, label: '  padded  ' }
  },
  { _id: 2, name: 'grace', qty: 3, price: 10, tags: [], scores: [1], at: DATE, nothing: null },
  { _id: 3, name: 'Alan', qty: 0, price: 1, tags: ['logic'], scores: [] }
]

describe('aggregation expression operators', () => {
  const dbs = seededDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('t').insertMany(structuredClone(docs) as any[])
    await mongo().collection('t').insertMany(structuredClone(docs) as any[])
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    /** Evaluates one expression against one document, as $project would. */
    const value = async (expression: unknown, id = 1): Promise<any> => {
      const [row] = await db().collection('t').aggregate([
        { $match: { _id: id } },
        { $project: { v: expression, _id: 0 } }
      ]).toArray()
      return row === undefined ? undefined : row.v
    }

    /** True when the whole expression is REJECTED rather than answered. */
    const rejects = async (expression: unknown): Promise<void> => {
      await expect(value(expression)).rejects.toThrow()
    }

    describe(dbName, () => {
      describe('arithmetic', () => {
        it('adds, subtracts, multiplies and divides', async () => {
          expect(await value({ $add: ['$qty', 5] })).toStrictEqual(15)
          expect(await value({ $add: ['$qty', '$price', 0.5] })).toStrictEqual(13)
          expect(await value({ $subtract: ['$qty', '$price'] })).toStrictEqual(7.5)
          expect(await value({ $multiply: ['$qty', '$price'] })).toStrictEqual(25)
          expect(await value({ $divide: ['$qty', 4] })).toStrictEqual(2.5)
          expect(await value({ $mod: ['$qty', 3] })).toStrictEqual(1)
        })

        it('returns null when an operand is missing or null, and throws on the wrong type', async () => {
          // The rule worth knowing: a missing VALUE is null, a wrong TYPE throws.
          expect(await value({ $add: ['$qty', '$absent'] })).toBeNull()
          expect(await value({ $add: ['$qty', '$nothing'] }, 2)).toBeNull()
          expect(await value({ $multiply: ['$absent', 2] })).toBeNull()
          expect(await value({ $subtract: ['$absent', 1] })).toBeNull()
          await rejects({ $add: ['$name', 1] })
          await rejects({ $divide: ['$qty', 0] })
          await rejects({ $mod: ['$qty', 0] })
        })

        it('does absolute value, ceiling, floor, square root and powers', async () => {
          expect(await value({ $abs: { $subtract: ['$price', '$qty'] } })).toStrictEqual(7.5)
          expect(await value({ $ceil: '$price' })).toStrictEqual(3)
          expect(await value({ $floor: '$price' })).toStrictEqual(2)
          expect(await value({ $sqrt: 16 })).toStrictEqual(4)
          expect(await value({ $pow: ['$qty', 2] })).toStrictEqual(100)
        })

        it('rounds and truncates, to a place when asked', async () => {
          expect(await value({ $round: [12.3456, 2] })).toStrictEqual(12.35)
          expect(await value({ $round: [1234.5678, -2] })).toStrictEqual(1200)
          expect(await value({ $trunc: [3.789, 1] })).toStrictEqual(3.7)
          expect(await value({ $trunc: -3.9 })).toStrictEqual(-3)
        })

        it('breaks a rounding tie the way the server does', async () => {
          // Not a guess: $round uses half-to-even, so 2.5 and 3.5 both go to
          // the even neighbour. Math.round() would answer 3 and 4.
          expect(await value({ $round: 2.5 })).toStrictEqual(2)
          expect(await value({ $round: 3.5 })).toStrictEqual(4)
          expect(await value({ $round: -2.5 })).toStrictEqual(-2)
          expect(await value({ $round: [0.125, 2] })).toStrictEqual(0.12)
        })

        it('adds to and subtracts from dates', async () => {
          expect(await value({ $add: ['$at', 1000] })).toStrictEqual(new Date('2021-03-09T14:05:07.789Z'))
          expect(await value({ $subtract: ['$at', 789] })).toStrictEqual(new Date('2021-03-09T14:05:06.000Z'))
          // Date minus date is the gap in milliseconds.
          expect(await value({ $subtract: ['$at', new Date('2021-03-09T14:05:00.000Z')] })).toStrictEqual(6789)
        })
      })

      describe('comparison and boolean', () => {
        it('compares with the BSON order the rest of the library uses', async () => {
          expect(await value({ $eq: ['$qty', 10] })).toBe(true)
          expect(await value({ $ne: ['$qty', 10] })).toBe(false)
          expect(await value({ $gt: ['$qty', '$price'] })).toBe(true)
          expect(await value({ $gte: ['$qty', 10] })).toBe(true)
          expect(await value({ $lt: ['$price', '$qty'] })).toBe(true)
          expect(await value({ $lte: ['$price', 2.5] })).toBe(true)
          expect(await value({ $cmp: ['$qty', '$price'] })).toStrictEqual(1)
          expect(await value({ $cmp: [1, 1] })).toStrictEqual(0)
          // Different types compare rather than throwing: number < string.
          expect(await value({ $lt: ['$qty', '$name'] })).toBe(true)
          // A missing field is NOT null here - it ranks below it. ($sort and
          // $group._id do treat missing as null, which is the surprise.)
          expect(await value({ $eq: ['$absent', null] })).toBe(false)
          expect(await value({ $lt: ['$absent', null] })).toBe(true)
          expect(await value({ $eq: ['$absent', '$alsoAbsent'] })).toBe(true)
          expect(await value({ $eq: ['$nothing', null] }, 2)).toBe(true)
        })

        it('does and, or and not with MongoDB truthiness', async () => {
          expect(await value({ $and: [true, '$nested.flag'] })).toBe(true)
          expect(await value({ $and: [true, '$absent'] })).toBe(false)
          expect(await value({ $or: ['$absent', '$qty'] })).toBe(true)
          expect(await value({ $or: ['$absent', 0] })).toBe(false)
          expect(await value({ $not: ['$absent'] })).toBe(true)
          expect(await value({ $not: [0] })).toBe(true)
          expect(await value({ $not: ['$qty'] })).toBe(false)
          // Every string is truthy, including the empty one.
          expect(await value({ $and: [''] })).toBe(true)
        })
      })

      describe('conditional', () => {
        it('$cond in both its forms', async () => {
          expect(await value({ $cond: [{ $gt: ['$qty', 5] }, 'many', 'few'] })).toStrictEqual('many')
          expect(await value({ $cond: { if: { $gt: ['$qty', 50] }, then: 'many', else: 'few' } }))
            .toStrictEqual('few')
          expect(await value({ $cond: [{ $gt: ['$qty', 50] }, 'many', '$name'] })).toStrictEqual('Ada Lovelace')
        })

        it('$ifNull falls through missing AND null', async () => {
          expect(await value({ $ifNull: ['$absent', 'fallback'] })).toStrictEqual('fallback')
          expect(await value({ $ifNull: ['$nothing', 'fallback'] }, 2)).toStrictEqual('fallback')
          expect(await value({ $ifNull: ['$qty', 'fallback'] })).toStrictEqual(10)
          expect(await value({ $ifNull: ['$absent', '$nothing', 'last'] }, 2)).toStrictEqual('last')
        })

        it('$switch takes the first matching branch, or the default', async () => {
          const size = {
            $switch: {
              branches: [
                { case: { $gte: ['$qty', 10] }, then: 'large' },
                { case: { $gte: ['$qty', 1] }, then: 'small' }
              ],
              default: 'none'
            }
          }
          expect(await value(size, 1)).toStrictEqual('large')
          expect(await value(size, 2)).toStrictEqual('small')
          expect(await value(size, 3)).toStrictEqual('none')
        })

        it('$switch with no matching branch and no default is an error', async () => {
          await rejects({ $switch: { branches: [{ case: false, then: 1 }] } })
        })
      })

      describe('strings', () => {
        it('concatenates, and gives null for a missing part', async () => {
          expect(await value({ $concat: ['$name', ' <', '$name', '>'] }))
            .toStrictEqual('Ada Lovelace <Ada Lovelace>')
          expect(await value({ $concat: ['$name', '$absent'] })).toBeNull()
          await rejects({ $concat: ['$name', '$qty'] })
        })

        it('changes case, treating a missing field as the empty string', async () => {
          expect(await value({ $toUpper: '$name' })).toStrictEqual('ADA LOVELACE')
          expect(await value({ $toLower: '$name' })).toStrictEqual('ada lovelace')
          // Not null - this is the one family that does not propagate.
          expect(await value({ $toUpper: '$absent' })).toStrictEqual('')
          expect(await value({ $toLower: '$nothing' }, 2)).toStrictEqual('')
        })

        it('measures and slices by code point', async () => {
          expect(await value({ $strLenCP: '$name' })).toStrictEqual(12)
          expect(await value({ $substrCP: ['$name', 0, 3] })).toStrictEqual('Ada')
          expect(await value({ $substrCP: ['$name', 4, 100] })).toStrictEqual('Lovelace')
          expect(await value({ $indexOfCP: ['$name', 'Love'] })).toStrictEqual(4)
          expect(await value({ $indexOfCP: ['$name', 'zzz'] })).toStrictEqual(-1)
          // 'Ada Lovelace' - the 'a' at 2, then the next one at 9.
          expect(await value({ $indexOfCP: ['$name', 'a', 2] })).toStrictEqual(2)
          expect(await value({ $indexOfCP: ['$name', 'a', 3] })).toStrictEqual(9)
        })

        it('splits, trims, replaces and compares case-insensitively', async () => {
          expect(await value({ $split: ['$name', ' '] })).toStrictEqual(['Ada', 'Lovelace'])
          expect(await value({ $trim: { input: '$nested.label' } })).toStrictEqual('padded')
          expect(await value({ $ltrim: { input: '$nested.label' } })).toStrictEqual('padded  ')
          expect(await value({ $rtrim: { input: '$nested.label' } })).toStrictEqual('  padded')
          expect(await value({ $trim: { input: '$name', chars: 'Ae' } })).toStrictEqual('da Lovelac')
          expect(await value({ $replaceOne: { input: '$name', find: 'a', replacement: 'X' } }))
            .toStrictEqual('AdX Lovelace')
          expect(await value({ $replaceAll: { input: '$name', find: 'a', replacement: 'X' } }))
            .toStrictEqual('AdX LovelXce')
          expect(await value({ $strcasecmp: ['$name', 'ADA LOVELACE'] })).toStrictEqual(0)
          expect(await value({ $strcasecmp: ['$name', 'b'] })).toStrictEqual(-1)
        })

        it('handles non-ASCII by code point, not by UTF-16 unit', async () => {
          // A surrogate pair is ONE character, which is the whole reason
          // $strLenCP and $substrCP are the CP variants.
          expect(await value({ $strLenCP: { $literal: 'a🚀b' } })).toStrictEqual(3)
          expect(await value({ $substrCP: [{ $literal: 'a🚀b' }, 1, 1] })).toStrictEqual('🚀')
          expect(await value({ $indexOfCP: [{ $literal: 'a🚀b' }, 'b'] })).toStrictEqual(2)
        })
      })

      describe('arrays', () => {
        it('measures, indexes and reverses', async () => {
          expect(await value({ $size: '$tags' })).toStrictEqual(3)
          expect(await value({ $size: '$tags' }, 2)).toStrictEqual(0)
          expect(await value({ $isArray: '$tags' })).toBe(true)
          expect(await value({ $isArray: '$name' })).toBe(false)
          expect(await value({ $arrayElemAt: ['$tags', 1] })).toStrictEqual('engines')
          expect(await value({ $arrayElemAt: ['$tags', -1] })).toStrictEqual('notes')
          expect(await value({ $reverseArray: '$scores' })).toStrictEqual([6, 9, 3])
          expect(await value({ $first: '$tags' })).toStrictEqual('maths')
          expect(await value({ $last: '$tags' })).toStrictEqual('notes')
          await rejects({ $size: '$name' })
        })

        it('reads past the end as MISSING, so the field disappears', async () => {
          // Not null: the projected document has no `v` key at all.
          expect(await value({ $arrayElemAt: ['$tags', 9] })).toBeUndefined()
          expect(await value({ $arrayElemAt: ['$scores', -9] })).toBeUndefined()
          expect(await value({ $first: '$scores' }, 3)).toBeUndefined() // an empty array
          expect(await value({ $last: '$scores' }, 3)).toBeUndefined()
        })

        it('slices, concatenates and tests membership', async () => {
          expect(await value({ $slice: ['$tags', 2] })).toStrictEqual(['maths', 'engines'])
          expect(await value({ $slice: ['$tags', -1] })).toStrictEqual(['notes'])
          expect(await value({ $slice: ['$tags', 1, 2] })).toStrictEqual(['engines', 'notes'])
          expect(await value({ $concatArrays: ['$tags', ['extra']] }))
            .toStrictEqual(['maths', 'engines', 'notes', 'extra'])
          expect(await value({ $in: ['engines', '$tags'] })).toBe(true)
          expect(await value({ $in: ['nope', '$tags'] })).toBe(false)
          expect(await value({ $range: [0, 4] })).toStrictEqual([0, 1, 2, 3])
          expect(await value({ $range: [0, 10, 3] })).toStrictEqual([0, 3, 6, 9])
        })

        it('maps, filters and reduces with $$this', async () => {
          expect(await value({ $map: { input: '$scores', in: { $multiply: ['$$this', 2] } } }))
            .toStrictEqual([6, 18, 12])
          expect(await value({ $map: { input: '$scores', as: 's', in: { $add: ['$$s', 1] } } }))
            .toStrictEqual([4, 10, 7])
          expect(await value({ $filter: { input: '$scores', cond: { $gt: ['$$this', 4] } } }))
            .toStrictEqual([9, 6])
          expect(await value({ $filter: { input: '$scores', as: 'n', cond: { $gt: ['$$n', 4] }, limit: 1 } }))
            .toStrictEqual([9])
          expect(await value({
            $reduce: { input: '$scores', initialValue: 0, in: { $add: ['$$value', '$$this'] } }
          })).toStrictEqual(18)
          expect(await value({
            $reduce: { input: '$tags', initialValue: '', in: { $concat: ['$$value', '$$this', '.'] } }
          })).toStrictEqual('maths.engines.notes.')
        })

        it('sums, averages and takes extremes of an array outside $group', async () => {
          // The same names are accumulators INSIDE $group. Here they fold one
          // document's array.
          expect(await value({ $sum: '$scores' })).toStrictEqual(18)
          expect(await value({ $avg: '$scores' })).toStrictEqual(6)
          expect(await value({ $min: '$scores' })).toStrictEqual(3)
          expect(await value({ $max: '$scores' })).toStrictEqual(9)
          // A list of arguments works too.
          expect(await value({ $sum: ['$qty', '$price'] })).toStrictEqual(12.5)
          expect(await value({ $max: ['$qty', '$price'] })).toStrictEqual(10)
          // Non-numeric values are ignored rather than being an error...
          expect(await value({ $sum: '$name' })).toStrictEqual(0)
          expect(await value({ $sum: '$absent' })).toStrictEqual(0)
          // ...and an average with nothing to average is null.
          expect(await value({ $avg: '$scores' }, 3)).toBeNull()
          expect(await value({ $min: '$scores' }, 3)).toBeNull()
        })

        it('$let binds variables for one expression', async () => {
          expect(await value({
            $let: { vars: { total: { $multiply: ['$qty', '$price'] } }, in: { $add: ['$$total', 1] } }
          })).toStrictEqual(26)
        })
      })

      describe('dates', () => {
        it('takes a date apart, in UTC', async () => {
          expect(await value({ $year: '$at' })).toStrictEqual(2021)
          expect(await value({ $month: '$at' })).toStrictEqual(3)
          expect(await value({ $dayOfMonth: '$at' })).toStrictEqual(9)
          expect(await value({ $hour: '$at' })).toStrictEqual(14)
          expect(await value({ $minute: '$at' })).toStrictEqual(5)
          expect(await value({ $second: '$at' })).toStrictEqual(6)
          expect(await value({ $millisecond: '$at' })).toStrictEqual(789)
          expect(await value({ $dayOfWeek: '$at' })).toStrictEqual(3) // Tuesday
          expect(await value({ $dayOfYear: '$at' })).toStrictEqual(68)
          // A missing date is null, not an error.
          expect(await value({ $year: '$absent' })).toBeNull()
        })

        it('formats a date', async () => {
          expect(await value({ $dateToString: { date: '$at', format: '%Y-%m-%d' } }))
            .toStrictEqual('2021-03-09')
          expect(await value({ $dateToString: { date: '$at', format: '%d/%m/%Y %H:%M:%S.%L' } }))
            .toStrictEqual('09/03/2021 14:05:06.789')
          expect(await value({ $dateToString: { date: '$at', format: '%Y%%' } })).toStrictEqual('2021%')
          // No format at all is ISO-8601.
          expect(await value({ $dateToString: { date: '$at' } })).toStrictEqual('2021-03-09T14:05:06.789Z')
          // A null date gives null, or onNull when it is supplied.
          expect(await value({ $dateToString: { date: '$absent' } })).toBeNull()
          expect(await value({ $dateToString: { date: '$absent', onNull: 'never' } })).toStrictEqual('never')
          // An unknown specifier is an error, not something emitted literally.
          await rejects({ $dateToString: { date: '$at', format: '%q' } })
        })
      })

      describe('types', () => {
        it('reports the type of a value', async () => {
          expect(await value({ $type: '$name' })).toStrictEqual('string')
          expect(await value({ $type: '$qty' })).toStrictEqual('int')
          expect(await value({ $type: '$price' })).toStrictEqual('double')
          expect(await value({ $type: '$tags' })).toStrictEqual('array')
          expect(await value({ $type: '$nested' })).toStrictEqual('object')
          expect(await value({ $type: '$at' })).toStrictEqual('date')
          expect(await value({ $type: '$nested.flag' })).toStrictEqual('bool')
          expect(await value({ $type: '$nothing' }, 2)).toStrictEqual('null')
          expect(await value({ $type: '$absent' })).toStrictEqual('missing')
          expect(await value({ $isNumber: '$qty' })).toBe(true)
          expect(await value({ $isNumber: '$name' })).toBe(false)
        })

        it('converts between types, and refuses what it cannot convert', async () => {
          expect(await value({ $toString: '$qty' })).toStrictEqual('10')
          expect(await value({ $toString: '$at' })).toStrictEqual('2021-03-09T14:05:06.789Z')
          expect(await value({ $toString: '$absent' })).toBeNull()
          // A NUMBER is truncated on the way to an int...
          expect(await value({ $toInt: '$price' })).toStrictEqual(2)
          expect(await value({ $toInt: -2.9 })).toStrictEqual(-2)
          // ...but a STRING has to spell one, whole.
          expect(await value({ $toInt: { $literal: '42' } })).toStrictEqual(42)
          await rejects({ $toInt: { $literal: '2.5' } })
          expect(await value({ $toDouble: { $literal: '2.5' } })).toStrictEqual(2.5)
          expect(await value({ $toBool: '$qty' })).toBe(true)
          expect(await value({ $toBool: 0 })).toBe(false)
          expect(await value({ $toBool: { $literal: '' } })).toBe(true)
          expect(await value({ $toDate: { $literal: '2021-03-09T14:05:06.789Z' } })).toStrictEqual(DATE)
          await rejects({ $toInt: '$name' })
        })
      })

      describe('variables and shape', () => {
        it('$$ROOT is the whole document', async () => {
          expect(await value({ $type: '$$ROOT' })).toStrictEqual('object')
          expect(await value('$$ROOT.name')).toStrictEqual('Ada Lovelace')
        })

        it('$$REMOVE omits a field', async () => {
          const [row] = await db().collection('t').aggregate([
            { $match: { _id: 1 } },
            { $project: { _id: 0, name: 1, hidden: { $cond: [true, '$$REMOVE', 'kept'] } } }
          ]).toArray()
          expect(row).toStrictEqual({ name: 'Ada Lovelace' })
        })

        it('builds nested documents and arrays from expressions', async () => {
          expect(await value({ total: { $multiply: ['$qty', '$price'] }, first: { $arrayElemAt: ['$tags', 0] } }))
            .toStrictEqual({ total: 25, first: 'maths' })
          expect(await value([{ $add: [1, 1] }, '$name'])).toStrictEqual([2, 'Ada Lovelace'])
        })

        it('$literal keeps a $-string from being read as a path', async () => {
          expect(await value({ $literal: '$name' })).toStrictEqual('$name')
          expect(await value({ $literal: { $add: [1, 2] } })).toStrictEqual({ $add: [1, 2] })
        })

        it('rejects an unknown operator instead of guessing', async () => {
          await rejects({ $nosuchoperator: ['$qty'] })
          await rejects({ $add: ['$qty', 1], $subtract: ['$qty', 1] })
        })
      })

      describe('in the pipeline', () => {
        it('computes fields in $addFields and $project', async () => {
          const rows = await db().collection('t').aggregate([
            {
              $addFields: {
                value: { $multiply: ['$qty', '$price'] },
                initials: { $substrCP: ['$name', 0, 1] }
              }
            },
            { $project: { _id: 1, value: 1, initials: 1 } },
            { $sort: { _id: 1 } }
          ]).toArray()
          expect(rows).toStrictEqual([
            { _id: 1, value: 25, initials: 'A' },
            { _id: 2, value: 30, initials: 'g' },
            { _id: 3, value: 0, initials: 'A' }
          ])
        })

        it('groups by a computed key and accumulates a computed value', async () => {
          const rows = await db().collection('t').aggregate([
            {
              $group: {
                _id: { $cond: [{ $gte: ['$qty', 5] }, 'busy', 'quiet'] },
                revenue: { $sum: { $multiply: ['$qty', '$price'] } },
                names: { $push: { $toUpper: '$name' } }
              }
            },
            { $sort: { _id: 1 } }
          ]).toArray()
          expect(rows).toStrictEqual([
            { _id: 'busy', revenue: 25, names: ['ADA LOVELACE'] },
            { _id: 'quiet', revenue: 30, names: ['GRACE', 'ALAN'] }
          ])
        })

        it('filters on a computed field with a later $match', async () => {
          const rows = await db().collection('t').aggregate([
            { $addFields: { value: { $multiply: ['$qty', '$price'] } } },
            { $match: { value: { $gt: 10 } } },
            { $project: { _id: 1, value: 1 } },
            { $sort: { _id: 1 } }
          ]).toArray()
          expect(rows).toStrictEqual([{ _id: 1, value: 25 }, { _id: 2, value: 30 }])
        })
      })
    })
  }
})
