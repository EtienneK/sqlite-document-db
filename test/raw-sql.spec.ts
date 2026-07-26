import { Db, parseDocument, stringifyDocument } from '../src/index.js'

/**
 * BACKLOG item 20: the raw SQL escape hatch.
 *
 * This library only - MongoDB has no SQL to arbitrate. What the oracle CAN
 * still settle is whether a raw write is visible to the document API
 * afterwards, so the tests that write go back through `find` to check.
 */
describe('db.sql - the raw SQL escape hatch', () => {
  let db: Db

  beforeEach(async () => {
    db = await Db.fromUrl(':memory:')
    await db.collection('places').insertMany([
      { _id: 'a', city: 'Cape Town', pop: 400, at: new Date('2020-01-01T00:00:00.000Z') },
      { _id: 'b', city: 'Cape Town', pop: 900, at: new Date('2021-01-01T00:00:00.000Z') },
      { _id: 'c', city: 'Durban', pop: 300, at: new Date('2022-01-01T00:00:00.000Z') }
    ])
  })

  afterEach(async () => {
    await db.close()
  })

  describe('reads', () => {
    it('runs the SQL a document query cannot express', async () => {
      // The motivating case: GROUP BY with HAVING, and a window function.
      const rows = await db.sql.all<{ city: string, n: number, total: number }>`
        SELECT json_extract(data, '$.city') AS city,
               COUNT(*) AS n,
               SUM(json_extract(data, '$.pop')) AS total
        FROM ${db.table('places')}
        GROUP BY city
        HAVING total > ${100}
        ORDER BY total DESC`
      expect(rows).toStrictEqual([
        { city: 'Cape Town', n: 2, total: 1300 },
        { city: 'Durban', n: 1, total: 300 }
      ])

      const ranked = await db.sql.all<{ id: string, rank: number }>`
        SELECT json_extract(data, '$._id') AS id,
               ROW_NUMBER() OVER (ORDER BY json_extract(data, '$.pop') DESC) AS rank
        FROM ${db.table('places')}`
      expect(ranked).toStrictEqual([{ id: 'b', rank: 1 }, { id: 'a', rank: 2 }, { id: 'c', rank: 3 }])
    })

    it('runs a recursive CTE, which the compiler has no way to emit', async () => {
      const rows = await db.sql.all<{ n: number }>`
        WITH RECURSIVE counter(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < ${5}
        )
        SELECT n FROM counter`
      expect(rows.map(r => r.n)).toStrictEqual([1, 2, 3, 4, 5])
    })

    it('get() returns the first row, or undefined', async () => {
      const row = await db.sql.get<{ n: number }>`SELECT COUNT(*) AS n FROM ${db.table('places')}`
      expect(row?.n).toStrictEqual(3)
      expect(await db.sql.get`SELECT 1 AS x FROM ${db.table('places')} WHERE 0`).toBeUndefined()
    })

    it('hands back RAW rows, which parseDocument decodes', async () => {
      const row = await db.sql.get<{ data: string }>`
        SELECT data FROM ${db.table('places')} WHERE json_extract(data, '$._id') = ${'a'}`

      // Raw: the data column is JSON text, and a Date is still its wrapper.
      expect(typeof row?.data).toStrictEqual('string')
      expect(JSON.parse(row!.data).at).toStrictEqual({ $date: '2020-01-01T00:00:00.000Z' })

      // Decoding is one visible call, and revives the Date.
      const doc = parseDocument(row!.data)
      expect(doc._id).toStrictEqual('a')
      expect(doc.at).toBeInstanceOf(Date)
      expect(doc.at).toStrictEqual(new Date('2020-01-01T00:00:00.000Z'))
    })

    it('returns ordinary objects, not the driver-shaped ones', async () => {
      // node:sqlite hands back NULL-prototype rows. That is an artefact of the
      // engine, and letting it through would mean a different driver returning
      // a different shape for the same query.
      const row = await db.sql.get`SELECT 1 AS a`
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
      expect(row).toStrictEqual({ a: 1 })

      // The copy is a spread, so a column aliased __proto__ stays data.
      const odd = await db.sql.get<Record<string, unknown>>`SELECT 7 AS "__proto__"`
      expect(Object.hasOwn(odd!, '__proto__')).toBe(true)
      expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype)
    })
  })

  describe('binding', () => {
    it('binds interpolations instead of splicing them', async () => {
      const nasty = "'; DROP TABLE collection_places; --"
      await db.collection('places').insertOne({ _id: 'd', city: nasty })

      const rows = await db.sql.all<{ id: string }>`
        SELECT json_extract(data, '$._id') AS id FROM ${db.table('places')}
        WHERE json_extract(data, '$.city') = ${nasty}`
      expect(rows).toStrictEqual([{ id: 'd' }])

      // The table is still there, so the value travelled as data.
      expect(await db.collection('places').countDocuments({})).toStrictEqual(4)
    })

    it('binds a Date as the ISO string the storage layer writes', async () => {
      // Which is what makes a range query over the .$date sub-path work.
      const rows = await db.sql.all<{ id: string }>`
        SELECT json_extract(data, '$._id') AS id FROM ${db.table('places')}
        WHERE json_extract(data, '$.at.$date') > ${new Date('2020-06-01T00:00:00.000Z')}
        ORDER BY id`
      expect(rows).toStrictEqual([{ id: 'b' }, { id: 'c' }])
    })

    it('binds objects and arrays as their storage JSON', async () => {
      const row = await db.sql.get<{ same: number }>`
        SELECT json(${{ city: 'Durban' }}) = json('{"city":"Durban"}') AS same`
      expect(row?.same).toStrictEqual(1)

      const list = await db.sql.get<{ n: number }>`SELECT json_array_length(json(${[1, 2, 3]})) AS n`
      expect(list?.n).toStrictEqual(3)
    })

    it('binds booleans as 1/0 and null as NULL', async () => {
      expect((await db.sql.get<{ v: number }>`SELECT ${true} AS v`)?.v).toStrictEqual(1)
      expect((await db.sql.get<{ v: number }>`SELECT ${false} AS v`)?.v).toStrictEqual(0)
      expect((await db.sql.get<{ v: null }>`SELECT ${null} AS v`)?.v).toBeNull()
    })

    it('rejects a value SQLite cannot hold, naming which one', async () => {
      await expect(db.sql.all`SELECT ${undefined} AS v`).rejects.toThrow(/type undefined \(interpolation 1\)/)
      await expect(db.sql.all`SELECT 1, ${10n} AS v`).rejects.toThrow(/type bigint \(interpolation 1\)/)
      await expect(db.sql.all`SELECT ${new Date('nope')} AS v`).rejects.toThrow(/invalid Date/)
      // The storage encoder's rules apply to objects, so a RegExp is refused
      // here for the same reason it cannot be stored.
      await expect(db.sql.all`SELECT ${/x/} AS v`).rejects.toThrow(/RegExp/)
    })
  })

  describe('writes', () => {
    it('reports how many rows changed, and the document API sees the change', async () => {
      const { changes } = await db.sql.run`
        UPDATE ${db.table('places')}
        SET data = json_set(data, '$.pop', json_extract(data, '$.pop') + ${1})
        WHERE json_extract(data, '$.city') = ${'Cape Town'}`
      expect(changes).toStrictEqual(2)

      expect((await db.collection('places').findOne({ _id: 'a' }))?.pop).toStrictEqual(401)
      expect((await db.collection('places').findOne({ _id: 'c' }))?.pop).toStrictEqual(300)
    })

    it('inserts a document row that the document API reads back intact', async () => {
      // stringifyDocument is exported for exactly this: a hand-written row has
      // to match what the storage encoder produces, or Dates stop reviving.
      const doc = { _id: 'z', city: 'Knysna', at: new Date('2023-03-03T00:00:00.000Z') }
      const { changes } = await db.sql.run`
        INSERT INTO ${db.table('places')} (data) VALUES (json(${stringifyDocument(doc)}))`
      expect(changes).toStrictEqual(1)

      const read = await db.collection('places').findOne({ _id: 'z' })
      expect(read).toStrictEqual(doc)
      expect(read?.at).toBeInstanceOf(Date)
    })

    it('still hits the _id unique index, as SQLite reports it', async () => {
      // No error translation here: you are writing SQL, not calling insertOne.
      await expect(db.sql.run`
        INSERT INTO ${db.table('places')} (data) VALUES (json(${stringifyDocument({ _id: 'a' })}))`
      ).rejects.toThrow(/UNIQUE constraint failed/)
    })

    it('takes part in withTransaction, and rolls back with it', async () => {
      await expect(db.withTransaction(async () => {
        await db.sql.run`DELETE FROM ${db.table('places')}`
        // Visible to the rest of the transaction on the same connection
        expect(await db.collection('places').countDocuments({})).toStrictEqual(0)
        throw Error('abandon')
      })).rejects.toThrow('abandon')

      expect(await db.collection('places').countDocuments({})).toStrictEqual(3)
    })
  })

  describe('table()', () => {
    it('resolves the physical table, including names that are not guessable', async () => {
      // Simple names keep the readable form...
      expect(db.table('places').sql).toStrictEqual('"collection_places"')

      // ...and awkward ones are digested, because SQLite compares identifiers
      // case-insensitively and these are two different collections.
      await db.collection('Users').insertOne({ _id: 1, of: 'upper' })
      await db.collection('users').insertOne({ _id: 1, of: 'lower' })
      expect(db.table('Users').sql).not.toStrictEqual(db.table('users').sql)

      expect((await db.sql.get<{ data: string }>`SELECT data FROM ${db.table('Users')}`)?.data)
        .toContain('upper')
      expect((await db.sql.get<{ data: string }>`SELECT data FROM ${db.table('users')}`)?.data)
        .toContain('lower')
    })

    it('validates the collection name it is given', () => {
      expect(() => db.table('with$dollar')).toThrow(/must not contain/)
      expect(() => db.table('')).toThrow(/non-empty/)
    })

    it('does not create the collection, and says so when it is missing', async () => {
      expect(await db.listCollections().toArray()).toStrictEqual([{ name: 'places', type: 'collection' }])
      db.table('never_opened')
      expect(await db.listCollections().toArray()).toStrictEqual([{ name: 'places', type: 'collection' }])
      await expect(db.sql.all`SELECT 1 FROM ${db.table('never_opened')}`).rejects.toThrow(/no such table/)
    })
  })

  describe('refusals', () => {
    it('rejects more than one statement', async () => {
      // node:sqlite compiles the first and silently discards the rest, so this
      // would otherwise insert one row and report success.
      await expect(db.sql.run`
        INSERT INTO ${db.table('places')} (data) VALUES (json('{"_id":"x"}'));
        INSERT INTO ${db.table('places')} (data) VALUES (json('{"_id":"y"}'))`
      ).rejects.toThrow(/takes ONE statement/)
      expect(await db.collection('places').countDocuments({})).toStrictEqual(3)
    })

    it('allows a trailing semicolon, and one inside a literal or a comment', async () => {
      expect((await db.sql.get<{ n: number }>`SELECT COUNT(*) AS n FROM ${db.table('places')};`)?.n)
        .toStrictEqual(3)
      expect((await db.sql.get<{ v: string }>`SELECT 'a;b' AS v`)?.v).toStrictEqual('a;b')
      expect((await db.sql.get<{ v: string }>`SELECT 'it''s ; fine' AS v`)?.v).toStrictEqual("it's ; fine")
      expect((await db.sql.get<{ v: number }>`SELECT 1 AS v -- ; not a statement\n`)?.v).toStrictEqual(1)
      expect((await db.sql.get<{ v: number }>`SELECT 1 /* ; still not */ AS v`)?.v).toStrictEqual(1)
      // A semicolon in a BOUND value is never SQL at all.
      expect((await db.sql.get<{ v: string }>`SELECT ${'a; DROP TABLE t'} AS v`)?.v)
        .toStrictEqual('a; DROP TABLE t')
    })

    it('rejects being called as a plain function rather than a tag', async () => {
      await expect((db.sql.all as any)('SELECT 1')).rejects.toThrow(/tagged template/)
    })
  })
})
