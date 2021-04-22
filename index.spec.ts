import Json1Client, { Db } from './index'

describe('Json1Client', () => {
  let db: Db

  beforeEach(async () => {
    db = await Json1Client.connect(':memory:')
  })

  afterEach(async () => {
    await db.close()
  })

  it('should create a new database', async () => {
    expect(db).toBeDefined()
  })

  describe('Collection', () => {

    describe('find', () => {
      it('should return a Cursor that iterates through all results if no filter is specified', async () => {
        const one = await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        const three = await db.collection('col').insertOne({ three: 3 })
        const four = await db.collection('col').insertOne({ four: 4 })

        await db.collection('col').deleteOne(three.insertedId)

        const cursor = db.collection('col').find()

        expect(await cursor.next()).toStrictEqual({ _id: one.insertedId, one: 1 })
        expect(await cursor.next()).toStrictEqual({ _id: two.insertedId, two: 2 })
        expect(await cursor.next()).toStrictEqual({ _id: four.insertedId, four: 4 })
        expect(await cursor.next()).toStrictEqual(null)
      })
    })

    describe('deleteOne', () => {
      it('should delete a single document using `_id` as filter', async () => {
        await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        await db.collection('col').insertOne({ three: 3 })

        const actual = await db.collection('col').deleteOne(two.insertedId)

        expect(actual).toStrictEqual({ deletedCount: 1 })
      })

      it('should delete no documents if `_id` cannot be found', async () => {
        await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        await db.collection('col').insertOne({ three: 3 })

        const actual = await db.collection('col').deleteOne(two.insertedId + 'NOT_FOUND')

        expect(actual).toStrictEqual({ deletedCount: 0 })
      })
    })

    describe('insertOne', () => {
      it('should insert a single document with no `_id` supplied', async () => {
        const expectedDoc = { username: 'Etiko', email: 'test@example.com' }
        const res = await db.collection('users').insertOne(expectedDoc)
        const actualDoc = await db.collection('users').findOne(res.insertedId)
        expect(actualDoc).toStrictEqual({ _id: res.insertedId, ...expectedDoc })
      })

      it('should insert a single document with `_id` supplied', async () => {
        const expectedDoc = { _id: '123456', username: 'Etiko', email: 'test@example.com' }
        const res = await db.collection('users').insertOne(expectedDoc)
        const actualDoc = await db.collection('users').findOne(res.insertedId)
        expect(actualDoc).toStrictEqual(expectedDoc)
      })
    })

    describe('replaceOne', () => {
      it('should replace a single document using `id` as filter', async () => {
        await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        await db.collection('col').insertOne({ three: 3 })

        const actual = await db.collection('col')
          .replaceOne(two.insertedId, { four: 4 })

        expect(actual).toStrictEqual({ modifiedCount: 1 })

        const four = await db.collection('col').findOne(two.insertedId)
        expect(four).toStrictEqual({ _id: two.insertedId, four: 4 })
      })

      it('should replace a single document using `id` as filter ignoring new document `_id`', async () => {
        await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        await db.collection('col').insertOne({ three: 3 })

        const actual = await db.collection('col')
          .replaceOne(two.insertedId, { _id: 'ThisIsANewId123', four: 4 })

        expect(actual).toStrictEqual({ modifiedCount: 1 })

        const four = await db.collection('col').findOne(two.insertedId)
        expect(four).toStrictEqual({ _id: two.insertedId, four: 4 })
      })

      it('should replace no documents if `id` cannot be found', async () => {
        await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        await db.collection('col').insertOne({ three: 3 })

        const actual = await db.collection('col')
          .replaceOne(two.insertedId + 'invalid', { four: 4 })

        expect(actual).toStrictEqual({ modifiedCount: 0 })
      })
    })
  })

})
