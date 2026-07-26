import type { Db as Mdb } from 'mongodb'

import type { Db } from '../../src/index.js'
import { seededDualDbs } from '../helpers/dual-dbs.js'

/**
 * BACKLOG item 28 (the operator gap sweep) and item 32 (vector similarity):
 * the expression families the MongoDB manual lists and this library did not
 * implement - regex, object, set, array, the byte twins of the string
 * operators, the rest of the arithmetic, trigonometry, `$convert` and `$rand`.
 *
 * Dual-engine like everything else, which is what settles the rules that are
 * not guessable: that `$regexMatch` over a MISSING field is false rather than
 * an error, that `$setUnion` comes back in BSON order while `$setDifference`
 * keeps the first array's, that `$firstN` counts a missing field as null while
 * `$maxN` skips it, and that `$convert` refuses int-to-date where it accepts
 * double-to-date.
 */

const docs = [
  {
    _id: 1,
    name: 'héllo wörld',
    qty: 10,
    tags: ['maths', 'engines', 'notes'],
    scores: [3, 9, 6],
    dupes: [1, 1, 2, 2, 3],
    spec: { colour: 'red', size: 'L' },
    pairs: [{ k: 'a', v: 1 }, { k: 'b', v: 2 }],
    vector: [1, 2, 2],
    other: [2, 4, 4]
  },
  { _id: 2, name: 'grace', qty: 3, tags: [], scores: [1], nothing: null }
]

describe('the expression operator sweep', () => {
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

    const rejects = async (expression: unknown): Promise<void> => {
      await expect(value(expression)).rejects.toThrow()
    }

    describe(dbName, () => {
      describe('regex', () => {
        it('$regexMatch answers true, false and false-for-missing', async () => {
          expect(await value({ $regexMatch: { input: '$name', regex: 'wör' } })).toBe(true)
          expect(await value({ $regexMatch: { input: '$name', regex: '^h' } })).toBe(true)
          expect(await value({ $regexMatch: { input: '$name', regex: 'zzz' } })).toBe(false)
          // The rule worth knowing: a missing or null input is NOT an error.
          expect(await value({ $regexMatch: { input: '$absent', regex: 'a' } })).toBe(false)
          expect(await value({ $regexMatch: { input: '$nothing', regex: 'a' } }, 2)).toBe(false)
        })

        it('takes options either in the pattern or beside it, but not both', async () => {
          expect(await value({ $regexMatch: { input: '$name', regex: 'WÖR', options: 'i' } })).toBe(true)
          expect(await value({ $regexMatch: { input: '$name', regex: /WÖR/i } })).toBe(true)
          await rejects({ $regexMatch: { input: '$name', regex: /a/i, options: 'i' } })
          await rejects({ $regexMatch: { input: '$name', regex: 'a', options: 'g' } })
        })

        it('$regexFind reports the match, its code-point index and its captures', async () => {
          expect(await value({ $regexFind: { input: '$name', regex: 'wörld' } }))
            .toStrictEqual({ match: 'wörld', idx: 6, captures: [] })
          expect(await value({ $regexFind: { input: '$name', regex: '(w)(z)?ö' } }))
            .toStrictEqual({ match: 'wö', idx: 6, captures: ['w', null] })
          expect(await value({ $regexFind: { input: '$name', regex: 'zzz' } })).toBeNull()
          expect(await value({ $regexFind: { input: '$absent', regex: 'a' } })).toBeNull()
        })

        it('$regexFindAll finds every match, and terminates on an empty one', async () => {
          expect(await value({ $regexFindAll: { input: '$name', regex: 'l' } })).toStrictEqual([
            { match: 'l', idx: 2, captures: [] },
            { match: 'l', idx: 3, captures: [] },
            { match: 'l', idx: 9, captures: [] }
          ])
          // A zero-width match is attempted at every index up to the LAST
          // CHARACTER, not past it, which is where MongoDB's regex engine and
          // JavaScript's disagree - the empty string still gets one attempt.
          expect(await value({ $regexFindAll: { input: 'ab', regex: 'x*' } })).toStrictEqual([
            { match: '', idx: 0, captures: [] },
            { match: '', idx: 1, captures: [] }
          ])
          expect(await value({ $regexFindAll: { input: '', regex: 'x*' } }))
            .toStrictEqual([{ match: '', idx: 0, captures: [] }])
          expect(await value({ $regexFindAll: { input: '$name', regex: 'zzz' } })).toStrictEqual([])
          expect(await value({ $regexFindAll: { input: '$absent', regex: 'a' } })).toStrictEqual([])
        })

        it('rejects a regex that is neither a string nor a pattern', async () => {
          await rejects({ $regexMatch: { input: '$name', regex: 5 } })
          await rejects({ $regexMatch: { input: '$name' } })
        })
      })

      describe('objects', () => {
        it('$mergeObjects merges left to right and skips null and missing', async () => {
          expect(await value({ $mergeObjects: ['$spec', { size: 'XL', weight: 2 }] }))
            .toStrictEqual({ colour: 'red', size: 'XL', weight: 2 })
          expect(await value({ $mergeObjects: ['$spec', '$absent'] })).toStrictEqual({ colour: 'red', size: 'L' })
          expect(await value({ $mergeObjects: ['$spec', '$nothing'] })).toStrictEqual({ colour: 'red', size: 'L' })
          expect(await value({ $mergeObjects: '$spec' })).toStrictEqual({ colour: 'red', size: 'L' })
          // A single argument that resolves to an ARRAY merges its elements.
          expect(await value({ $mergeObjects: '$pairs' })).toStrictEqual({ k: 'b', v: 2 })
          await rejects({ $mergeObjects: ['$spec', '$qty'] })
        })

        it('$objectToArray and $arrayToObject round-trip', async () => {
          expect(await value({ $objectToArray: '$spec' }))
            .toStrictEqual([{ k: 'colour', v: 'red' }, { k: 'size', v: 'L' }])
          expect(await value({ $objectToArray: '$absent' })).toBeNull()
          expect(await value({ $arrayToObject: { $objectToArray: '$spec' } }))
            .toStrictEqual({ colour: 'red', size: 'L' })
          expect(await value({ $arrayToObject: '$pairs' })).toStrictEqual({ a: 1, b: 2 })
          expect(await value({ $arrayToObject: [[['p', 1], ['q', 2]]] })).toStrictEqual({ p: 1, q: 2 })
          // A repeated key keeps the LAST value.
          expect(await value({ $arrayToObject: [[['p', 1], ['p', 2]]] })).toStrictEqual({ p: 2 })
          await rejects({ $arrayToObject: [[['p']]] })
          await rejects({ $objectToArray: '$tags' })
        })

        it('$getField, $setField and $unsetField address a field by name', async () => {
          expect(await value({ $getField: { field: 'colour', input: '$spec' } })).toStrictEqual('red')
          expect(await value({ $getField: { field: 'nope', input: '$spec' } })).toBeUndefined()
          expect(await value({ $getField: 'qty' })).toStrictEqual(10)
          expect(await value({ $setField: { field: 'size', input: '$spec', value: 'S' } }))
            .toStrictEqual({ colour: 'red', size: 'S' })
          // $$REMOVE is how $setField deletes rather than nulls.
          expect(await value({ $setField: { field: 'size', input: '$spec', value: '$$REMOVE' } }))
            .toStrictEqual({ colour: 'red' })
          expect(await value({ $unsetField: { field: 'size', input: '$spec' } })).toStrictEqual({ colour: 'red' })
          expect(await value({ $unsetField: { field: 'nope', input: '$spec' } }))
            .toStrictEqual({ colour: 'red', size: 'L' })
        })

        it('$setField writes a LITERAL name, dots and all', async () => {
          expect(await value({ $setField: { field: 'a.b', input: '$spec', value: 1 } }))
            .toStrictEqual({ colour: 'red', size: 'L', 'a.b': 1 })
        })
      })

      describe('sets', () => {
        it('unions, intersects and subtracts, deduplicating throughout', async () => {
          expect(await value({ $setUnion: [[3, 1, 2], [2, 5]] })).toStrictEqual([1, 2, 3, 5])
          expect(await value({ $setUnion: '$dupes' })).toStrictEqual([1, 2, 3])
          expect(await value({ $setIntersection: [[3, 1, 2], [2, 5, 3]] })).toStrictEqual([2, 3])
          expect(await value({ $setDifference: [[3, 1, 2], [2]] })).toStrictEqual([3, 1])
          expect(await value({ $setUnion: [['b', 'a', 2, 1, true, null]] })).toStrictEqual([null, 1, 2, 'a', 'b', true])
        })

        it('compares sets, ignoring order and repetition', async () => {
          expect(await value({ $setEquals: [[1, 2, 2], [2, 1]] })).toBe(true)
          expect(await value({ $setEquals: [[1, 2], [2, 3]] })).toBe(false)
          expect(await value({ $setIsSubset: [[1, 2], [2, 1, 3]] })).toBe(true)
          expect(await value({ $setIsSubset: [[1, 4], [2, 1, 3]] })).toBe(false)
        })

        it('propagates null through the set-BUILDING operators only', async () => {
          expect(await value({ $setUnion: [[1], '$nothing'] }, 2)).toBeNull()
          expect(await value({ $setUnion: [[1], '$absent'] })).toBeNull()
          expect(await value({ $setIntersection: [[1], '$absent'] })).toBeNull()
          expect(await value({ $setDifference: [[1], '$absent'] })).toBeNull()
          // ...while the ones that answer a QUESTION about sets raise instead.
          await rejects({ $setEquals: [[1], '$absent'] })
          await rejects({ $setIsSubset: [[1], '$absent'] })
        })

        it('$allElementsTrue and $anyElementTrue use MongoDB truthiness', async () => {
          expect(await value({ $allElementsTrue: [[1, 'a', true, []]] })).toBe(true)
          expect(await value({ $allElementsTrue: [[1, null]] })).toBe(false)
          expect(await value({ $allElementsTrue: [[]] })).toBe(true)
          expect(await value({ $anyElementTrue: [[null, 0, false]] })).toBe(false)
          expect(await value({ $anyElementTrue: [[null, 'x']] })).toBe(true)
          expect(await value({ $anyElementTrue: [[]] })).toBe(false)
        })
      })

      describe('arrays', () => {
        it('$indexOfArray finds a value, or -1, or null for a missing array', async () => {
          expect(await value({ $indexOfArray: ['$scores', 9] })).toStrictEqual(1)
          expect(await value({ $indexOfArray: ['$scores', 42] })).toStrictEqual(-1)
          expect(await value({ $indexOfArray: ['$scores', 3, 1] })).toStrictEqual(-1)
          expect(await value({ $indexOfArray: ['$absent', 1] })).toBeNull()
          expect(await value({ $indexOfArray: ['$nothing', 1] }, 2)).toBeNull()
        })

        it('$sortArray orders elements, or documents by a field', async () => {
          expect(await value({ $sortArray: { input: '$scores', sortBy: 1 } })).toStrictEqual([3, 6, 9])
          expect(await value({ $sortArray: { input: '$scores', sortBy: -1 } })).toStrictEqual([9, 6, 3])
          expect(await value({ $sortArray: { input: '$pairs', sortBy: { v: -1 } } }))
            .toStrictEqual([{ k: 'b', v: 2 }, { k: 'a', v: 1 }])
          // A missing sort field ranks as null, which is lowest.
          expect(await value({ $sortArray: { input: [{ z: 2 }, {}, { z: 1 }], sortBy: { z: 1 } } }))
            .toStrictEqual([{}, { z: 1 }, { z: 2 }])
          expect(await value({ $sortArray: { input: '$absent', sortBy: 1 } })).toBeNull()
        })

        it('$zip transposes, and stops at the shortest unless told not to', async () => {
          expect(await value({ $zip: { inputs: [[1, 2], [3, 4]] } })).toStrictEqual([[1, 3], [2, 4]])
          expect(await value({ $zip: { inputs: [[1, 2], [3]] } })).toStrictEqual([[1, 3]])
          expect(await value({ $zip: { inputs: [[1, 2], [3]], useLongestLength: true } }))
            .toStrictEqual([[1, 3], [2, null]])
          expect(await value({ $zip: { inputs: [[1, 2], [3]], useLongestLength: true, defaults: [0, 9] } }))
            .toStrictEqual([[1, 3], [2, 9]])
          expect(await value({ $zip: { inputs: [[1, 2], '$absent'] } })).toBeNull()
        })

        it('the N-family takes ends and extremes', async () => {
          expect(await value({ $firstN: { n: 2, input: '$scores' } })).toStrictEqual([3, 9])
          expect(await value({ $firstN: { n: 99, input: '$scores' } })).toStrictEqual([3, 9, 6])
          expect(await value({ $lastN: { n: 2, input: '$scores' } })).toStrictEqual([9, 6])
          expect(await value({ $maxN: { n: 2, input: [3, 1, null, 5] } })).toStrictEqual([5, 3])
          expect(await value({ $minN: { n: 2, input: [3, 1, null, 5] } })).toStrictEqual([1, 3])
          await rejects({ $firstN: { n: 0, input: '$scores' } })
          await rejects({ $firstN: { n: 2, input: '$qty' } })
        })
      })

      describe('strings, by byte', () => {
        it('$strLenBytes counts UTF-8 bytes where $strLenCP counts characters', async () => {
          expect(await value({ $strLenBytes: '$name' })).toStrictEqual(13)
          expect(await value({ $strLenCP: '$name' })).toStrictEqual(11)
          expect(await value({ $strLenBytes: '🚀' })).toStrictEqual(4)
        })

        it('$substrBytes slices bytes, and refuses to split a character', async () => {
          expect(await value({ $substrBytes: ['$name', 0, 3] })).toStrictEqual('hé')
          expect(await value({ $substr: ['$name', 0, 3] })).toStrictEqual('hé')
          expect(await value({ $substrCP: ['$name', 0, 3] })).toStrictEqual('hél')
          expect(await value({ $substrBytes: ['$name', 3, 100] })).toStrictEqual('llo wörld')
          await rejects({ $substrBytes: ['$name', 0, 2] })
          await rejects({ $substrBytes: ['$name', -1, 2] })
        })

        it('$indexOfBytes reports a byte offset', async () => {
          expect(await value({ $indexOfBytes: ['$name', 'wörld'] })).toStrictEqual(7)
          expect(await value({ $indexOfCP: ['$name', 'wörld'] })).toStrictEqual(6)
          expect(await value({ $indexOfBytes: ['$name', 'zzz'] })).toStrictEqual(-1)
          expect(await value({ $indexOfBytes: ['$name', 'l', 99] })).toStrictEqual(-1)
        })
      })

      describe('arithmetic and trigonometry', () => {
        it('does exponentials and logarithms', async () => {
          expect(await value({ $exp: 0 })).toStrictEqual(1)
          expect(await value({ $ln: 1 })).toStrictEqual(0)
          expect(await value({ $log: [8, 2] })).toStrictEqual(3)
          expect(await value({ $log10: 100 })).toStrictEqual(2)
          expect(await value({ $exp: '$absent' })).toBeNull()
        })

        it('rejects a logarithm outside its domain', async () => {
          await rejects({ $ln: 0 })
          await rejects({ $ln: -1 })
          await rejects({ $log10: 0 })
          await rejects({ $log: [8, 1] })
          await rejects({ $log: [8, -2] })
        })

        it('does the trigonometric family in radians', async () => {
          expect(await value({ $sin: 0 })).toStrictEqual(0)
          expect(await value({ $cos: 0 })).toStrictEqual(1)
          expect(await value({ $tan: 0 })).toStrictEqual(0)
          expect(await value({ $asin: 0 })).toStrictEqual(0)
          expect(await value({ $acos: 1 })).toStrictEqual(0)
          expect(await value({ $atan: 0 })).toStrictEqual(0)
          expect(await value({ $atan2: [1, 1] })).toBeCloseTo(Math.PI / 4, 12)
          expect(await value({ $sinh: 0 })).toStrictEqual(0)
          expect(await value({ $cosh: 0 })).toStrictEqual(1)
          expect(await value({ $tanh: 0 })).toStrictEqual(0)
          expect(await value({ $asinh: 0 })).toStrictEqual(0)
          expect(await value({ $acosh: 1 })).toStrictEqual(0)
          expect(await value({ $atanh: 0 })).toStrictEqual(0)
          expect(await value({ $degreesToRadians: 180 })).toBeCloseTo(Math.PI, 12)
          expect(await value({ $radiansToDegrees: Math.PI })).toBeCloseTo(180, 12)
        })

        it('propagates missing and rejects the wrong type or an impossible angle', async () => {
          expect(await value({ $sin: '$absent' })).toBeNull()
          await rejects({ $sin: '$name' })
          await rejects({ $asin: 2 })
          await rejects({ $acosh: 0 })
        })
      })

      describe('$convert', () => {
        it('converts between the types the storage layer can hold', async () => {
          expect(await value({ $convert: { input: 5, to: 'string' } })).toStrictEqual('5')
          expect(await value({ $convert: { input: '5', to: 'int' } })).toStrictEqual(5)
          expect(await value({ $convert: { input: '5', to: 16 } })).toStrictEqual(5)
          expect(await value({ $convert: { input: '2.5', to: 'double' } })).toStrictEqual(2.5)
          expect(await value({ $convert: { input: 0, to: 'bool' } })).toBe(false)
          expect(await value({ $convert: { input: 5, to: 'long' } })).toStrictEqual(5)
        })

        it('answers with onError and onNull instead of raising', async () => {
          expect(await value({ $convert: { input: 'x', to: 'int', onError: 'bad' } })).toStrictEqual('bad')
          expect(await value({ $convert: { input: '$absent', to: 'int', onNull: -1 } })).toStrictEqual(-1)
          expect(await value({ $convert: { input: '$absent', to: 'int' } })).toBeNull()
          await rejects({ $convert: { input: 'x', to: 'int' } })
          await rejects({ $convert: { input: 1, to: 'nope' } })
        })

        it('refuses int-to-date where it accepts double-to-date', async () => {
          // Not a quirk of this library: MongoDB's own conversion table has no
          // int -> date entry, and an integral number in int32 range IS an int.
          await rejects({ $convert: { input: 0, to: 'date' } })
          await rejects({ $toDate: 0 })
          expect(await value({ $toDate: 1600000000000 })).toStrictEqual(new Date(1600000000000))
          expect(await value({ $convert: { input: 0, to: 'date', onError: 'no' } })).toStrictEqual('no')
        })
      })

      describe('vector similarity', () => {
        it('scores two vectors three ways', async () => {
          expect(await value({ $similarityDotProduct: ['$vector', '$other'] })).toStrictEqual(18)
          expect(await value({ $similarityCosine: ['$vector', '$other'] })).toBeCloseTo(1, 12)
          expect(await value({ $similarityCosine: [[1, 0], [0, 1]] })).toStrictEqual(0)
          expect(await value({ $similarityEuclidean: [[1, 2], [2, 4]] })).toBeCloseTo(Math.sqrt(5), 12)
          expect(await value({ $similarityEuclidean: ['$vector', '$vector'] })).toStrictEqual(0)
        })

        it('requires two vectors of the same length', async () => {
          await rejects({ $similarityCosine: [[1, 2], [2]] })
          await rejects({ $similarityCosine: [[1, 2]] })
          await rejects({ $similarityCosine: [[1, 2], ['a', 'b']] })
        })

        it('ranks documents by similarity, which is the point of having them', async () => {
          const rows = await db().collection('t').aggregate([
            { $match: { _id: 1 } },
            { $addFields: { score: { $similarityCosine: ['$vector', [1, 2, 2]] } } },
            { $project: { _id: 1, score: 1 } }
          ]).toArray()
          expect(rows).toStrictEqual([{ _id: 1, score: 1 }])
        })
      })

      describe('$rand', () => {
        it('answers a float in [0, 1)', async () => {
          const drawn = await value({ $rand: {} })
          expect(typeof drawn).toBe('number')
          expect(drawn).toBeGreaterThanOrEqual(0)
          expect(drawn).toBeLessThan(1)
        })
      })
    })
  }
})
