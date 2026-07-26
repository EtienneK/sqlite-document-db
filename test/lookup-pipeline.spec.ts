import type { Db as Mdb } from 'mongodb'

import { Db } from '../src/index.js'
import { freshDualDbs } from './helpers/dual-dbs.js'

/**
 * `$lookup`'s `let` + `pipeline` form - the correlated subquery (BACKLOG
 * item 16, the priority-1 entry after pipeline updates).
 *
 * The design under test: per input document the `let` expressions are
 * evaluated, every `$$variable` in the sub-pipeline is substituted as a
 * `$literal`, and the result runs as an ORDINARY aggregation on the foreign
 * collection - so `$expr`, the `$match` pushdown and nested `$lookup`s are the
 * ones that already exist. Identical executions are memoized on the variable
 * values, which the statement-count test at the bottom pins.
 */
/** Every statement `debug: true` logged while `work` ran. */
async function statements (work: (db: Db) => Promise<void>): Promise<string[]> {
  const logged: string[] = []
  const debugDb = await Db.fromUrl(':memory:', { debug: true })
  const spy = vi.spyOn(console, 'log').mockImplementation(sql => { logged.push(String(sql)) })
  try {
    await work(debugDb)
  } finally {
    spy.mockRestore()
    await debugDb.close()
  }
  return logged
}

describe('$lookup with let + pipeline', () => {
  const dbs = freshDualDbs()

  for (const dbName of ['Sqlite', 'Mongodb']) {
    const db = (): Db | Mdb => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

    /** The manual's own example pair: orders joined to stock on two conditions. */
    const seedWarehouses = async (): Promise<void> => {
      await db().collection('orders').insertMany([
        { _id: 1, item: 'almonds', price: 12, ordered: 2 },
        { _id: 2, item: 'pecans', price: 20, ordered: 1 },
        { _id: 3, item: 'cookies', price: 10, ordered: 60 }
      ] as any[])
      await db().collection('warehouses').insertMany([
        { _id: 1, stock_item: 'almonds', warehouse: 'A', instock: 120 },
        { _id: 2, stock_item: 'pecans', warehouse: 'A', instock: 80 },
        { _id: 3, stock_item: 'almonds', warehouse: 'B', instock: 60 },
        { _id: 4, stock_item: 'cookies', warehouse: 'B', instock: 40 },
        { _id: 5, stock_item: 'cookies', warehouse: 'A', instock: 80 }
      ] as any[])
    }

    describe(dbName, () => {
      it('should run the correlated two-condition join from the manual', async () => {
        await seedWarehouses()

        const result = await db().collection('orders').aggregate([
          { $lookup: {
            from: 'warehouses',
            let: { order_item: '$item', order_qty: '$ordered' },
            pipeline: [
              { $match: { $expr: { $and: [
                { $eq: ['$stock_item', '$$order_item'] },
                { $gte: ['$instock', '$$order_qty'] }
              ] } } },
              { $project: { stock_item: 0, _id: 0 } }
            ],
            as: 'stockdata'
          } },
          { $sort: { _id: 1 } }
        ]).toArray()

        expect(result).toStrictEqual([
          { _id: 1, item: 'almonds', price: 12, ordered: 2, stockdata: [
            { warehouse: 'A', instock: 120 }, { warehouse: 'B', instock: 60 }
          ] },
          { _id: 2, item: 'pecans', price: 20, ordered: 1, stockdata: [
            { warehouse: 'A', instock: 80 }
          ] },
          { _id: 3, item: 'cookies', price: 10, ordered: 60, stockdata: [
            { warehouse: 'A', instock: 80 }
          ] }
        ])
      })

      it('should join an uncorrelated pipeline to every input document', async () => {
        await db().collection('absences').insertMany([
          { _id: 1, student: 'Ann', sickdays: 4 },
          { _id: 2, student: 'Brad', sickdays: 6 }
        ] as any[])
        await db().collection('holidays').insertMany([
          { _id: 1, year: 2018, name: 'New Year' },
          { _id: 2, year: 2019, name: 'Spring Festival' }
        ] as any[])

        const result = await db().collection('absences').aggregate([
          { $lookup: {
            from: 'holidays',
            pipeline: [
              { $match: { year: 2018 } },
              { $project: { _id: 0, name: 1 } }
            ],
            as: 'holidays'
          } },
          { $sort: { _id: 1 } }
        ]).toArray()

        expect(result).toStrictEqual([
          { _id: 1, student: 'Ann', sickdays: 4, holidays: [{ name: 'New Year' }] },
          { _id: 2, student: 'Brad', sickdays: 6, holidays: [{ name: 'New Year' }] }
        ])
      })

      it('should join everything through an empty pipeline', async () => {
        await db().collection('a').insertOne({ _id: 1 } as any)
        await db().collection('b').insertMany([{ _id: 1, v: 'x' }, { _id: 2, v: 'y' }] as any[])

        const result = await db().collection('a').aggregate([
          { $lookup: { from: 'b', pipeline: [], as: 'all' } }
        ]).toArray()
        expect(result).toStrictEqual([{ _id: 1, all: [{ _id: 1, v: 'x' }, { _id: 2, v: 'y' }] }])
      })

      it('should reach a variable through a dotted path into its value', async () => {
        await db().collection('orders').insertOne({ _id: 1, ship: { city: 'CPT', code: 7 } } as any)
        await db().collection('depots').insertMany([
          { _id: 1, city: 'CPT' },
          { _id: 2, city: 'JNB' }
        ] as any[])

        const result = await db().collection('orders').aggregate([
          { $lookup: {
            from: 'depots',
            let: { dest: '$ship' },
            pipeline: [{ $match: { $expr: { $eq: ['$city', '$$dest.city'] } } }],
            as: 'depots'
          } }
        ]).toArray()
        expect(result[0]!.depots).toStrictEqual([{ _id: 1, city: 'CPT' }])
      })

      it('should use variables in a $project inside the sub-pipeline', async () => {
        await db().collection('orders').insertOne({ _id: 1, markup: 5 } as any)
        await db().collection('items').insertOne({ _id: 1, price: 10 } as any)

        const result = await db().collection('orders').aggregate([
          { $lookup: {
            from: 'items',
            let: { extra: '$markup' },
            pipeline: [{ $project: { _id: 0, quoted: { $add: ['$price', '$$extra'] } } }],
            as: 'quotes'
          } }
        ]).toArray()
        expect(result[0]!.quotes).toStrictEqual([{ quoted: 15 }])
      })

      it('should let an inner $let SHADOW an outer variable of the same name', async () => {
        await db().collection('a').insertOne({ _id: 1, v: 'outer' } as any)
        await db().collection('b').insertOne({ _id: 1 } as any)

        const result = await db().collection('a').aggregate([
          { $lookup: {
            from: 'b',
            let: { x: '$v' },
            pipeline: [{ $project: {
              _id: 0,
              // The inner binding wins for $$x; the outer value is still
              // reachable outside the $let.
              inner: { $let: { vars: { x: 'shadow' }, in: '$$x' } },
              outer: '$$x'
            } }],
            as: 'joined'
          } }
        ]).toArray()
        expect(result[0]!.joined).toStrictEqual([{ inner: 'shadow', outer: 'outer' }])
      })

      it('should treat $$var OUTSIDE $expr in a $match as a literal string', async () => {
        await db().collection('a').insertOne({ _id: 1, v: 'real' } as any)
        await db().collection('b').insertMany([
          { _id: 1, tag: 'real' },
          { _id: 2, tag: '$$want' }
        ] as any[])

        const result = await db().collection('a').aggregate([
          { $lookup: {
            from: 'b',
            let: { want: '$v' },
            // Query syntax, not an expression: '$$want' here is just a string.
            pipeline: [{ $match: { tag: '$$want' } }],
            as: 'joined'
          } }
        ]).toArray()
        expect(result[0]!.joined).toStrictEqual([{ _id: 2, tag: '$$want' }])
      })

      it('should correlate on Dates', async () => {
        const day1 = new Date('2020-01-01T00:00:00Z')
        const day2 = new Date('2020-01-02T00:00:00Z')
        await db().collection('shifts').insertMany([
          { _id: 1, on: day1 },
          { _id: 2, on: day2 }
        ] as any[])
        await db().collection('deliveries').insertMany([
          { _id: 1, at: day1, parcel: 'p1' },
          { _id: 2, at: day2, parcel: 'p2' },
          { _id: 3, at: day2, parcel: 'p3' }
        ] as any[])

        const result = await db().collection('shifts').aggregate([
          { $lookup: {
            from: 'deliveries',
            let: { day: '$on' },
            pipeline: [
              { $match: { $expr: { $eq: ['$at', '$$day'] } } },
              { $project: { _id: 0, parcel: 1 } }
            ],
            as: 'parcels'
          } },
          { $sort: { _id: 1 } }
        ]).toArray()
        expect(result.map(doc => doc.parcels)).toStrictEqual([
          [{ parcel: 'p1' }],
          [{ parcel: 'p2' }, { parcel: 'p3' }]
        ])
      })

      it('should run $group and $sort inside the sub-pipeline', async () => {
        await db().collection('regions').insertMany([
          { _id: 1, region: 'west' },
          { _id: 2, region: 'east' }
        ] as any[])
        await db().collection('sales').insertMany([
          { _id: 1, region: 'west', amount: 10 },
          { _id: 2, region: 'west', amount: 5 },
          { _id: 3, region: 'east', amount: 7 }
        ] as any[])

        const result = await db().collection('regions').aggregate([
          { $lookup: {
            from: 'sales',
            let: { r: '$region' },
            pipeline: [
              { $match: { $expr: { $eq: ['$region', '$$r'] } } },
              { $group: { _id: null, total: { $sum: '$amount' } } },
              { $project: { _id: 0, total: 1 } }
            ],
            as: 'totals'
          } },
          { $sort: { _id: 1 } }
        ]).toArray()
        expect(result.map(doc => doc.totals)).toStrictEqual([[{ total: 15 }], [{ total: 7 }]])
      })

      it('should thread an OUTER variable into a NESTED $lookup', async () => {
        await db().collection('a').insertOne({ _id: 1, key: 'k1' } as any)
        await db().collection('b').insertOne({ _id: 1 } as any)
        await db().collection('c').insertMany([
          { _id: 1, ref: 'k1' },
          { _id: 2, ref: 'k2' }
        ] as any[])

        const result = await db().collection('a').aggregate([
          { $lookup: {
            from: 'b',
            let: { outerKey: '$key' },
            pipeline: [
              { $lookup: {
                from: 'c',
                pipeline: [{ $match: { $expr: { $eq: ['$ref', '$$outerKey'] } } }],
                as: 'inner'
              } },
              { $project: { _id: 0, inner: 1 } }
            ],
            as: 'joined'
          } }
        ]).toArray()
        expect(result[0]!.joined).toStrictEqual([{ inner: [{ _id: 1, ref: 'k1' }] }])
      })

      it('should reject a malformed pipeline form', async () => {
        const col = db().collection('a')
        await col.insertOne({ _id: 1 } as any)
        // Wrapped so this library's EAGER validation (a synchronous throw from
        // aggregate() itself) and the server's at-iteration one both reject.
        const run = async (stage: any): Promise<any[]> => await col.aggregate([stage]).toArray()

        await expect(run({ $lookup: { from: 'b', pipeline: 'nope', as: 'x' } })).rejects.toThrow()
        await expect(run({ $lookup: { from: 'b', pipeline: [{ $nonsense: 1 }], as: 'x' } })).rejects.toThrow()
      })
    })
  }

  describe('what only this library can show (single-engine)', () => {
    it('should run an UNCORRELATED sub-pipeline once, however many input documents', async () => {
      const logged = await statements(async db => {
        await db.collection('a').insertMany([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])
        await db.collection('b').insertMany([{ v: 1 }])
        await db.collection('a').aggregate([
          { $lookup: { from: 'b', pipeline: [{ $match: { v: 1 } }], as: 'all' } }
        ]).toArray()
      })
      // The memo keys on the substituted variable values; with no variables
      // every input document shares one execution.
      const foreignReads = logged.filter(sql => sql.startsWith('SELECT') && sql.includes('collection_b'))
      expect(foreignReads).toHaveLength(1)
    })

    it('should run a correlated sub-pipeline once per DISTINCT variable value', async () => {
      const logged = await statements(async db => {
        await db.collection('a').insertMany([{ k: 'x' }, { k: 'y' }, { k: 'x' }, { k: 'y' }, { k: 'x' }])
        await db.collection('b').insertMany([{ ref: 'x' }, { ref: 'y' }])
        await db.collection('a').aggregate([
          { $lookup: {
            from: 'b',
            let: { key: '$k' },
            pipeline: [{ $match: { $expr: { $eq: ['$ref', '$$key'] } } }],
            as: 'joined'
          } }
        ]).toArray()
      })
      const foreignReads = logged.filter(sql => sql.startsWith('SELECT') && sql.includes('collection_b'))
      expect(foreignReads).toHaveLength(2)
    })

    it('should refuse the combined localField/foreignField + pipeline form, with the alternative', async () => {
      // MongoDB 4.4+ ACCEPTS this combination, which is why the refusal is
      // single-engine: its array-vs-$eq equality rules are their own project,
      // and approximating them would be quietly wrong.
      const db = await Db.fromUrl(':memory:')
      try {
        expect(() => db.collection('a').aggregate([
          { $lookup: { from: 'b', localField: 'k', foreignField: 'ref', pipeline: [], as: 'x' } }
        ])).toThrow(/not implemented.*\$match \+ \$expr/s)
      } finally {
        await db.close()
      }
    })
  })
})
