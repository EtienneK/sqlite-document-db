import { parse, stringify } from '../src/ejson.js'
import { Db } from '../src/index.js'

describe('EJSON storage encoding (DR-1)', () => {
  describe('round-trip', () => {
    it('should encode Dates as {"$date": ISO} and revive them', () => {
      const when = new Date('2020-01-02T03:04:05.678Z')
      const text = stringify({ when, nested: { deep: when }, list: [when, 'x', 1] })
      expect(text).toContain('{"$date":"2020-01-02T03:04:05.678Z"}')
      expect(parse(text)).toStrictEqual({ when, nested: { deep: when }, list: [when, 'x', 1] })
    })

    it('should pass plain JSON through unchanged', () => {
      const doc = { s: 'x', n: 1.5, b: true, z: null, a: [1, 'two', { three: 3 }], o: { nested: {} } }
      expect(parse(stringify(doc))).toStrictEqual(doc)
      expect(stringify(doc)).toStrictEqual(JSON.stringify(doc))
    })

    it('should keep JSON.stringify undefined semantics: dropped in objects, null in arrays', () => {
      expect(stringify({ a: undefined, b: 1, list: [undefined, 2] }))
        .toStrictEqual('{"b":1,"list":[null,2]}')
    })
  })

  describe('rejection of unstorable values', () => {
    const cases: Array<[string, unknown]> = [
      ['RegExp', /x/i],
      ['Uint8Array', new Uint8Array([1])],
      ['Buffer', Buffer.from([1])],
      ['ArrayBuffer', new ArrayBuffer(1)],
      ['Map', new Map()],
      ['Set', new Set()],
      ['bigint', 10n],
      ['function', () => 1],
      ['non-finite number', NaN],
      ['non-finite number', Infinity],
      ['invalid Date', new Date('nope')]
    ]

    for (const [label, value] of cases) {
      it(`should reject ${label} with the offending path`, () => {
        expect(() => stringify({ outer: { bad: value } })).toThrow(/at \$\.outer\.bad/)
      })
    }

    it('should reject circular structures', () => {
      const doc: any = { name: 'loop' }
      doc.self = doc
      expect(() => stringify(doc)).toThrow(/circular/)
    })

    it('should allow the same object to appear twice non-circularly', () => {
      const shared = { v: 1 }
      expect(parse(stringify({ a: shared, b: shared }))).toStrictEqual({ a: { v: 1 }, b: { v: 1 } })
    })
  })

  describe('rejection at the API surface', () => {
    // MongoDB would accept a BSON regex here; this library rejects instead of
    // silently storing {} - a documented DR-1 deviation, so no dual-engine run.
    it('insertOne should reject unstorable values with a clear error', async () => {
      const db = await Db.fromUrl(':memory:')
      await expect(db.collection('t').insertOne({ pattern: /x/ }))
        .rejects.toThrow(/RegExp.*at \$\.pattern/)
      expect(await db.collection('t').countDocuments()).toStrictEqual(0)
      await db.close()
    })
  })
})
