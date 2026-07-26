import type { Db as Mdb } from 'mongodb'

import type { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * BACKLOG item 19: text round-trips.
 *
 * [test/injection.spec.ts](injection.spec.ts) covers adversarial ASCII; this
 * file covers the rest of Unicode. It matters more here than in most libraries
 * because documents are stored as SQLite TEXT and compared with `json_extract`,
 * so a value crosses four encodings on the way to an assertion - JS UTF-16, the
 * JSON escaping in src/ejson.ts, SQLite's UTF-8, and back - and a mangling in
 * any of them is silent.
 *
 * Every case below runs through each write method and is then found again by
 * `find`, `distinct` and `$group`, dual-engine, so MongoDB decides what
 * "unchanged" means.
 */

interface Case { readonly id: number, readonly label: string, readonly value: string }

const CASES: Case[] = [
  // Non-ASCII scripts
  'Zażółć gęślą jaźń', // Polish diacritics
  'こんにちは世界', // Japanese
  '中文字符', // Chinese
  '한국어', // Korean
  'Ελληνικά', // Greek
  'Кириллица', // Cyrillic
  'مرحبا بالعالم', // Arabic, right-to-left
  'שלום עולם', // Hebrew, right-to-left
  'ไทย', // Thai, no word breaks
  // Normalisation: these two render identically and MUST stay distinct values
  'caf\u00e9', // precomposed U+00E9
  'cafe\u0301', // e + combining acute
  // Characters outside the BMP - surrogate pairs in JavaScript, four bytes in
  // UTF-8, and the case where UTF-16 code-unit order stops matching code-point
  // order (see the sort tests below).
  'rocket 🚀',
  '👨‍👩‍👧‍👦', // ZWJ sequence: one grapheme, seven code points
  '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', // astral mathematical alphanumerics
  '🇿🇦', // regional indicator pair
  '\uFFFDreplacement', // U+FFFD, the highest BMP code point in these cases
  // Invisible and format characters
  '\uFEFFleading BOM',
  'zero\u200Bwidth\u200Bspaces',
  'bidi\u202Eoverride',
  'non\u00A0breaking space',
  // Structural in JSON, in SQL, or in this library's own encodings
  'he said "hi"',
  'C:\\temp\\new',
  'line1\nline2\tend\r',
  '\\u0041 is not A', // a literal backslash-u escape, not an escape sequence
  '{"$date":"2020-01-02T03:04:05.000Z"}',
  '["not","an","array"]',
  'ends with backslash\\',
  'before\u0000after' // a NUL, which terminates a string everywhere below SQLite's API
].map((value, id) => ({ id, label: JSON.stringify(value), value }))

/** Field NAMES take a different path from values: they become JSON1 path literals. */
const FIELD_NAMES = [
  'naïve',
  '日本語',
  "it's",
  'quote"d',
  'back\\slash',
  'emoji🚀',
  'ключ',
  'with space'
]

describe('Unicode and special characters', () => {
  const docs = CASES.map(c => ({ _id: c.id, s: c.value, tags: [c.value, 'shared'] }))

  const dbs = freshDualDbs(async ({ sqlite, mongo }) => {
    await sqlite().collection('t').insertMany(structuredClone(docs) as any[])
    await mongo().collection('t').insertMany(structuredClone(docs) as any[])
  })

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    describe(dbName, () => {
      it('round-trips every value byte for byte', async () => {
        for (const c of CASES) {
          const doc = await db().collection('t').findOne({ _id: c.id } as any)
          expect(doc?.s, c.label).toStrictEqual(c.value)
          // Length too: a truncation at a NUL or a lost surrogate half would
          // still compare equal to a prefix under a sloppy assertion.
          expect(doc?.s.length, c.label).toStrictEqual(c.value.length)
          expect(doc?.tags, c.label).toStrictEqual([c.value, 'shared'])
        }
      })

      it('finds every value by equality, and matches exactly one document', async () => {
        for (const c of CASES) {
          expect((await db().collection('t').findOne({ s: c.value }))?._id, c.label).toStrictEqual(c.id)
          // Exactly one: two cases collapsing into one (Unicode normalisation,
          // truncation at a control character) would show up here first.
          expect(await db().collection('t').countDocuments({ s: c.value }), c.label).toStrictEqual(1)
        }
      })

      it('matches array elements, $in, $ne and $all', async () => {
        for (const c of CASES) {
          expect((await db().collection('t').findOne({ tags: c.value }))?._id, c.label).toStrictEqual(c.id)
          expect((await db().collection('t').findOne({ s: { $in: [c.value, 'absent'] } }))?._id, c.label)
            .toStrictEqual(c.id)
          expect(await db().collection('t').countDocuments({ s: { $ne: c.value } }), c.label)
            .toStrictEqual(CASES.length - 1)
          expect((await db().collection('t').findOne({ tags: { $all: [c.value, 'shared'] } }))?._id, c.label)
            .toStrictEqual(c.id)
        }
      })

      it('keeps precomposed and decomposed forms distinct', async () => {
        // Both render as "café". MongoDB does not normalise, so neither may we.
        expect(await db().collection('t').countDocuments({ s: 'caf\u00e9' })).toStrictEqual(1)
        expect(await db().collection('t').countDocuments({ s: 'cafe\u0301' })).toStrictEqual(1)
        expect((await db().collection('t').findOne({ s: 'caf\u00e9' }))?.s).toStrictEqual('caf\u00e9')
      })

      it('carries values through insertOne, updateOne, updateMany and replaceOne', async () => {
        const col = db().collection('w')
        for (const c of CASES) {
          await col.insertOne({ _id: c.id, s: c.value } as any)
        }
        for (const c of CASES) {
          expect((await col.findOne({ s: c.value }))?._id, c.label).toStrictEqual(c.id)
        }

        // $set writes the value; the filter finds the document by another one.
        for (const c of CASES) {
          const other = CASES[(c.id + 1) % CASES.length]!
          await col.updateOne({ s: c.value }, { $set: { t: other.value } })
        }
        for (const c of CASES) {
          const other = CASES[(c.id + 1) % CASES.length]!
          expect((await col.findOne({ _id: c.id } as any))?.t, c.label).toStrictEqual(other.value)
        }

        // updateMany over all of them, and $push into an array
        expect((await col.updateMany({}, { $push: { list: 'ok\u00e9' } } as any)).modifiedCount)
          .toStrictEqual(CASES.length)
        expect((await col.findOne({ _id: 0 } as any))?.list).toStrictEqual(['ok\u00e9'])

        // replaceOne round-trips a whole document of them
        const target = CASES[3]!
        await col.replaceOne({ _id: target.id } as any, { s: target.value, extra: '🚀\u0301' } as any)
        const replaced = await col.findOne({ _id: target.id } as any)
        expect(replaced?.s).toStrictEqual(target.value)
        expect(replaced?.extra).toStrictEqual('🚀\u0301')
      })

      it('returns every value from distinct(), deduplicated and in one order', async () => {
        const values = await db().collection('t').distinct('s')
        expect(values).toStrictEqual(CASES.map(c => c.value).toSorted(byUtf8))

        // The array field contributes its ELEMENTS, and 'shared' appears in
        // every document but must come back once.
        const tags = await db().collection('t').distinct('tags')
        expect(tags).toStrictEqual([...CASES.map(c => c.value), 'shared'].toSorted(byUtf8))
      })

      it('groups by a Unicode value in an aggregation', async () => {
        const groups = await db().collection('t').aggregate([
          { $group: { _id: '$s', n: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ]).toArray()
        expect(groups.map(g => g._id)).toStrictEqual(CASES.map(c => c.value).toSorted(byUtf8))
        expect(groups.every(g => g.n === 1)).toBe(true)
      })

      it('sorts strings by code point, in SQL and after a $group alike', async () => {
        // MongoDB's default collation compares the UTF-8 encoding byte by byte,
        // which is code-POINT order. JavaScript's `<` compares UTF-16 code
        // units, and the two disagree for astral characters: U+1F680 (🚀) is
        // above U+FFFD by code point, and below it by code unit.
        const expected = CASES.map(c => c.value).toSorted(byUtf8)

        // Sorted in SQLite, by ORDER BY
        const sorted = await db().collection('t').find().sort({ s: 1 }).toArray()
        expect(sorted.map(d => d.s)).toStrictEqual(expected)

        // Sorted in JavaScript, because $sort follows $group
        const grouped = await db().collection('t').aggregate([
          { $group: { _id: '$s' } },
          { $sort: { _id: 1 } }
        ]).toArray()
        expect(grouped.map(g => g._id)).toStrictEqual(expected)
      })

      it('matches Unicode with $regex', async () => {
        const ids = async (filter: any): Promise<any[]> =>
          (await db().collection('t').find(filter).toArray()).map(d => d._id).toSorted()

        expect(await ids({ s: { $regex: '世界' } })).toStrictEqual([byValue('こんにちは世界')])
        expect(await ids({ s: { $regex: '^🚀' } })).toStrictEqual([])
        expect(await ids({ s: { $regex: '🚀$' } })).toStrictEqual([byValue('rocket 🚀')])
        expect(await ids({ s: { $regex: 'ГРАЖДАН' } })).toStrictEqual([])
      })

      it('stores and queries Unicode field names', async () => {
        const col = db().collection('f')
        const doc: Record<string, unknown> = { _id: 1 }
        for (const [i, name] of FIELD_NAMES.entries()) doc[name] = `value ${i}`
        await col.insertOne(doc as any)

        const read = await col.findOne({ _id: 1 } as any)
        for (const [i, name] of FIELD_NAMES.entries()) {
          expect(read?.[name], name).toStrictEqual(`value ${i}`)
        }

        // Queried by that name, and by a dotted path ending in one
        for (const [i, name] of FIELD_NAMES.entries()) {
          expect((await col.findOne({ [name]: `value ${i}` }))?._id, name).toStrictEqual(1)
          expect(await col.countDocuments({ [name]: { $exists: true } }), name).toStrictEqual(1)
        }

        await col.insertOne({ _id: 2, outer: Object.fromEntries(FIELD_NAMES.map((n, i) => [n, i])) } as any)
        for (const [i, name] of FIELD_NAMES.entries()) {
          expect((await col.findOne({ [`outer.${name}`]: i }))?._id, name).toStrictEqual(2)
        }

        // And written to by name
        await col.updateOne({ _id: 1 } as any, { $set: { [FIELD_NAMES[0]!]: 'changed' } } as any)
        expect((await col.findOne({ _id: 1 } as any))?.[FIELD_NAMES[0]!]).toStrictEqual('changed')
      })

      it('projects, indexes and takes distinct on a Unicode field name', async () => {
        const col = db().collection('g')
        const name = '日本語"の\\キー'
        await col.insertMany([
          { _id: 1, [name]: 'いち', other: 'x' },
          { _id: 2, [name]: 'に', other: 'y' }
        ] as any[])

        // Projection: the name reaches src/projection.ts as a path segment
        expect(await col.find({}, { projection: { [name]: 1 } }).sort({ _id: 1 }).toArray())
          .toStrictEqual([{ _id: 1, [name]: 'いち' }, { _id: 2, [name]: 'に' }])

        // distinct: the name becomes a JSON1 path literal in two statements
        expect(await col.distinct(name)).toStrictEqual(['いち', 'に'].toSorted(byUtf8))

        // An index over it: the index expression and the query expression are
        // built by the same code, so a quoting difference would make the index
        // silently stop matching rather than fail.
        await col.createIndex({ [name]: 1 })
        expect((await col.indexes()).some(ix => ix.key[name] === 1)).toBe(true)
        expect((await col.findOne({ [name]: 'に' }))?._id).toStrictEqual(2)
      })
    })
  }
})

/** The id of the case holding this exact value. */
function byValue (value: string): number | undefined {
  return CASES.find(c => c.value === value)?.id
}

/**
 * Code-point order: what MongoDB's default collation and SQLite's BINARY
 * collation both do, and what src/bson-order.ts has to reproduce in JS.
 */
function byUtf8 (a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const ax = x[i]!.codePointAt(0)!
    const by = y[i]!.codePointAt(0)!
    if (ax !== by) return ax < by ? -1 : 1
  }
  return x.length - y.length
}
