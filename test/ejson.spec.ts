import { MAX_DOCUMENT_DEPTH, parse, stringify } from '../src/ejson.js'
import { Db } from '../src/index.js'

/** A chain of `levels` nested objects, as the value of one field. */
function chain (levels: number, leaf?: unknown): any {
  const root: any = {}
  let node = root
  for (let i = 0; i < levels; i++) {
    node.a = {}
    node = node.a
  }
  if (leaf !== undefined) node.d = leaf
  return root
}

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

    // A Date is stored as {"$date": "<ISO>"}, so a plain object of that exact
    // shape is indistinguishable from one on read: it used to come back as an
    // Invalid Date, which JSON.stringify then turned into null.
    it('should reject an object shaped like the stored Date wrapper', () => {
      expect(() => stringify({ outer: { bad: { $date: '2020-01-02T03:04:05.000Z' } } }))
        .toThrow(/at \$\.outer\.bad/)
      expect(() => stringify({ outer: { bad: { $date: 'not a date at all' } } }))
        .toThrow(/at \$\.outer\.bad/)
    })

    it('should store objects that merely contain a $date key', () => {
      // Only the exact one-key wrapper shape is ambiguous.
      const doc = { a: { $date: '2020-01-02T03:04:05.000Z', tz: 'UTC' }, b: { $date: 5 } }
      expect(parse(stringify(doc))).toStrictEqual(doc)
    })

    it('should store a field literally named __proto__ instead of losing it', () => {
      // JSON.parse yields __proto__ as an ordinary own property; assigning it
      // onto a normal object would set the prototype and drop the field.
      const doc = JSON.parse('{"__proto__":{"a":1},"b":2}')
      expect(parse(stringify(doc))).toStrictEqual(doc)
      expect(stringify(doc)).toContain('__proto__')
    })

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

  /**
   * The nesting limit, pinned at BOTH edges.
   *
   * Drift upwards and the guard stops firing: users get SQLite's bare
   * "malformed JSON" back, or - as happened on Windows/Node 22.13 when this was
   * set to 1000 - a `RangeError` from the encoder's own recursion, on a limit
   * the implementation could not reach. Drift downwards and the library starts
   * refusing documents it could store. Only a test on each side catches both.
   *
   * These stay single-engine: MongoDB's limit is TIGHTER (~180), so the
   * at-the-limit document below is one a real server would refuse. That is the
   * intended direction - see MAX_DOCUMENT_DEPTH.
   */
  describe('nesting depth', () => {
    // { deep: <root> } puts the chain's deepest object at 1 + 1 + levels.
    const deepest = MAX_DOCUMENT_DEPTH - 2

    it('should store a document at exactly the limit', () => {
      expect(() => stringify({ deep: chain(deepest) })).not.toThrow()
    })

    it('should reject one level deeper, naming the limit and the path', () => {
      expect(() => stringify({ deep: chain(deepest + 1) }))
        .toThrow(new RegExp(`nests deeper than ${MAX_DOCUMENT_DEPTH} levels \\(at \\$\\.deep`))
    })

    it('should count a Date as a level, because it is stored as an object', () => {
      expect(() => stringify({ deep: chain(deepest - 1, new Date(0)) })).not.toThrow()
      expect(() => stringify({ deep: chain(deepest, new Date(0)) })).toThrow(/nests deeper/)
    })

    it('should count array nesting too', () => {
      let nested: any = []
      for (let i = 0; i < MAX_DOCUMENT_DEPTH; i++) nested = [nested]
      expect(() => stringify({ deep: nested })).toThrow(/nests deeper/)
    })

    it('should agree with what SQLite actually accepts', async () => {
      // The guard is only worth having if it fires exactly where SQLite would.
      const db = await Db.fromUrl(':memory:')
      const col = db.collection('t')
      await col.insertOne({ _id: 'ok', deep: chain(deepest) })
      expect(await col.countDocuments({ _id: 'ok' })).toStrictEqual(1)
      await expect(col.insertOne({ _id: 'too-deep', deep: chain(deepest + 1) })).rejects.toThrow(/nests deeper/)
      await db.close()
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
