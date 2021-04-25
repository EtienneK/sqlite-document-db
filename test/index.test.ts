import { MongoClient, Db as Mdb } from 'mongodb';
import MongoMemoryServer from 'mongodb-memory-server-core';
import Db from '../src/index'

describe('Db', () => {
  const mongod = new MongoMemoryServer();
  let mongoClient: MongoClient

  let mdb: Mdb
  let db: Db

  beforeEach(async () => {
    mongoClient = await MongoClient.connect(await mongod.getUri(), { useUnifiedTopology: true })
    mdb = mongoClient.db(await mongod.getDbName())
    db = await Db.fromUrl(':memory:')
  })

  afterEach(async () => {
    await db.close()
    await mongoClient.close()
    await mongod.stop()
  })

  it('should create a new database from a URL', async () => {
    expect(db).toBeDefined()
  })

  describe('Collection', () => {
    describe('find', () => {
      it('should return a Cursor that iterates through all results if no filter is specified', async () => {
        for (const toTest of [db, mdb]) {
          const one = await toTest.collection('col').insertOne({ one: 1 })
          const two = await toTest.collection('col').insertOne({ two: 2 })
          const three = await toTest.collection('col').insertOne({ three: 3 })
          const four = await toTest.collection('col').insertOne({ four: 4 })

          const cursor = toTest.collection('col').find()

          expect(await cursor.next()).toStrictEqual({ _id: one.insertedId, one: 1 })
          expect(await cursor.next()).toStrictEqual({ _id: two.insertedId, two: 2 })
          expect(await cursor.next()).toStrictEqual({ _id: three.insertedId, three: 3 })
          expect(await cursor.next()).toStrictEqual({ _id: four.insertedId, four: 4 })
          expect(await cursor.next()).toStrictEqual(null)
        }
      })
    })

    describe('deleteOne', () => {
      it('should delete a single document using _id as filter', async () => {
        for (const toTest of [db, mdb]) {
          await toTest.collection('col').insertOne({ one: 1 })
          const two = await toTest.collection('col').insertOne({ two: 2 })
          await toTest.collection('col').insertOne({ three: 3 })

          let actual: any = await toTest.collection('col').deleteOne({ _id: two.insertedId })

          if (mdb instanceof Mdb) {
            actual = { deletedCount: actual.deletedCount }
          }

          expect(actual).toStrictEqual({ deletedCount: 1 })
        }
      })

      it('should delete no documents if _id cannot be found', async () => {
        for (const toTest of [db, mdb]) {
          await toTest.collection('col').insertOne({ one: 1 })
          const two = await toTest.collection('col').insertOne({ two: 2 })
          await toTest.collection('col').insertOne({ three: 3 })

          let actual: any = await toTest.collection('col').deleteOne({ _id: two.insertedId + 'NOT_FOUND' })

          if (mdb instanceof Mdb) {
            actual = { deletedCount: actual.deletedCount }
          }

          expect(actual).toStrictEqual({ deletedCount: 0 })
        }
      })
    })

    describe('insertOne', () => {
      it('should insert a single document with no _id supplied', async () => {
        for (const toTest of [db, mdb]) {
          const expectedDoc = { username: 'Etiko', email: 'test@example.com' }
          const res = await toTest.collection('users').insertOne(expectedDoc)
          const actualDoc = await toTest.collection('users').findOne({ _id: res.insertedId })
          expect(actualDoc).toStrictEqual({ _id: res.insertedId, ...expectedDoc })
        }
      })

      it('should insert a single document with _id supplied', async () => {
        for (const toTest of [db, mdb]) {
          const expectedDoc = { _id: '123456', username: 'Etiko', email: 'test@example.com' }
          const res = await toTest.collection('users').insertOne(expectedDoc)
          const actualDoc = await toTest.collection('users').findOne({ _id: res.insertedId })
          expect(actualDoc).toStrictEqual(expectedDoc)
        }
      })
    })

    describe('insertMany', () => {
      it('should insert many documents', async () => {
        for (const toTest of [db, mdb]) {
          const expectedDocs = [
            { username: 'Etiko', email: 'test@example.com' },
            { username: 'JJ', email: 'test1@example.com' },
            { username: 'Pablo', email: 'test2@example.com' },
            { username: 'EtienneK', email: 'test3@example.com' },
            { username: 'anon', email: 'test4@example.org' }
          ]
          const res = await toTest.collection('users').insertMany(expectedDocs)
          const actualDocs = await toTest.collection('users').find().toArray()

          expect(actualDocs)
            .toStrictEqual(expectedDocs.map((doc, index) => ({ _id: res.insertedIds[index], ...doc })))
          expect(res.insertedCount).toEqual(5)
        }
      })

      it('should insert many documents - some with own ids', async () => {
        const expectedDocs = [
          { username: 'Etiko', email: 'test@example.com' },
          { username: 'JJ', email: 'test1@example.com' },
          { _id: 'custom_id0', username: 'Pablo', email: 'test2@example.com' },
          { username: 'EtienneK', email: 'test3@example.com' },
          { _id: 'custom_id1', username: 'anon', email: 'test4@example.org' }
        ]
        const res = await db.collection('users').insertMany(expectedDocs)
        const actualDocs = await db.collection('users').find().toArray()

        expect(actualDocs)
          .toStrictEqual(expectedDocs.map((doc, index) => ({ _id: res.insertedIds[index], ...doc })))
        expect(res.insertedCount).toEqual(5)
      })

      it('should insert and handle errors', async () => {
        const expectedDocs = [
          { username: 'Etiko', email: 'test@example.com' },
          { _id: 'custom_id0', username: 'JJ', email: 'test1@example.com' },
          { _id: 'custom_id0', username: 'Pablo', email: 'test2@example.com' },
          { username: 'EtienneK', email: 'test3@example.com' },
          { _id: 'custom_id0', username: 'anon', email: 'test4@example.org' }
        ]
        const res = await db.collection('users').insertMany(expectedDocs)
        const actualDocs = await db.collection('users').find().toArray()

        expect(actualDocs)
          .toStrictEqual([
            { _id: res.insertedIds[0], ...expectedDocs[0] },
            { _id: res.insertedIds[1], ...expectedDocs[1] },
            { _id: res.insertedIds[3], ...expectedDocs[3] },
          ])
        expect(res.insertedCount).toEqual(3)
      })
    })

    describe('replaceOne', () => {
      it('should replace a single document using id as filter', async () => {
        await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        await db.collection('col').insertOne({ three: 3 })

        const actual = await db.collection('col')
          .replaceOne({ _id: two.insertedId }, { four: 4 })

        expect(actual).toStrictEqual({ modifiedCount: 1 })

        const four = await db.collection('col').findOne(two.insertedId)
        expect(four).toStrictEqual({ _id: two.insertedId, four: 4 })
      })

      it('should replace a single document using id as filter ignoring new document _id', async () => {
        await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        await db.collection('col').insertOne({ three: 3 })

        const actual = await db.collection('col')
          .replaceOne({ _id: two.insertedId }, { _id: 'ThisIsANewId123', four: 4 })

        expect(actual).toStrictEqual({ modifiedCount: 1 })

        const four = await db.collection('col').findOne(two.insertedId)
        expect(four).toStrictEqual({ _id: two.insertedId, four: 4 })
      })

      it('should replace no documents if id cannot be found', async () => {
        await db.collection('col').insertOne({ one: 1 })
        const two = await db.collection('col').insertOne({ two: 2 })
        await db.collection('col').insertOne({ three: 3 })

        const actual = await db.collection('col')
          .replaceOne({ _id: two.insertedId + 'invalid' }, { four: 4 })

        expect(actual).toStrictEqual({ modifiedCount: 0 })
      })
    })
  })
})
