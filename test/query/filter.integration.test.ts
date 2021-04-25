import Db from '../../src/index'
import convert from '../../src/query/filter'

describe('filter integration tests', () => {
  let db: Db

  const data = [
    { _id: '123', item: "journal", qty: 25, size: { h: 14, w: 21, uom: "cm" }, status: "A" },
    { _id: '124',item: "notebook", qty: 50, size: { h: 8.5, w: 11, uom: "in" }, status: "A" },
    { _id: '126',item: "paper", qty: 100, size: { h: 8.5, w: 11, uom: "in" }, status: "D" },
    { _id: '128',item: "planner", qty: 75, size: { h: 22.85, w: 30, uom: "cm" }, status: "D" },
    { _id: '129',item: "planner", qty: 75, size: { h: 22.85, w: 30, uom: "cm" }, status: "C" },
    { _id: '132',item: "postcard", qty: 45, size: { h: 10, w: 15.25, uom: "cm" }, status: "A" }
  ]

  beforeAll(async () => {
    db = await Db.fromUrl(':memory:')

    for (const d of data) {
      await db.collection('items').insertOne(d)
    }
  })

  afterAll(async () => {
    await db.close()
  })

  describe('string equality', () => {
    it('should work with single', async () => {
      const expected = data[4]
      const actual = { ...(await db.collection('items').find({ status: "C" }).toArray()).documents[0] }
      expect(actual).toStrictEqual(expected)
    })
    it('should work with multiple', function () {
    })
    it('nesting does exact document matching', function () {
    })
    it('should support nesting using the dot operator', function () {
    })
  })
})
