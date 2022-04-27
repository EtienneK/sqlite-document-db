import { MongoClient, Db as Mdb } from 'mongodb'
import MongoMemoryServer from 'mongodb-memory-server-core'
import { Db } from '../src/index'

describe('Api', () => {
  let mongod: MongoMemoryServer
  let mongoClient: MongoClient

  let mongodb: Mdb
  let sqldb: Db

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create()
    mongoClient = await MongoClient.connect(mongod.getUri())
    mongodb = mongoClient.db('testdb')
    sqldb = await Db.fromUrl(':memory:')
  })

  afterEach(async () => {
    await sqldb.close()
    await mongoClient.close()
    await mongod.stop()
  })

  it('should create a new database from a URL', async () => {
    expect(sqldb).toBeDefined()
  })

  describe('Db', () => {
    for (const dbName of ['Sqlite', 'Mongodb']) {
      const db = (): Db | Mdb => dbName === 'Sqlite' ? sqldb : mongodb
      describe(`${dbName} › Collection`, () => {
        describe('find', () => {
          it('should be case sensitive', async () => {
            const users = [
              { name: 'user' }, { name: 'usEr' }, { name: 'USER' }
            ]
            await db().collection('col').insertMany(users)
            expect(await db().collection('col').findOne({ name: 'user' })).toStrictEqual(users[0])
            expect(await db().collection('col').findOne({ name: 'usEr' })).toStrictEqual(users[1])
            expect(await db().collection('col').findOne({ name: 'USER' })).toStrictEqual(users[2])
          })

          it('should return a Cursor that iterates through all results if no filter is specified', async () => {
            const one = await db().collection('col').insertOne({ one: 1 })
            const two = await db().collection('col').insertOne({ two: 2 })
            const three = await db().collection('col').insertOne({ three: 3 })
            const four = await db().collection('col').insertOne({ four: 4 })

            const cursor = db().collection('col').find()

            expect(await cursor.next()).toStrictEqual({ _id: one.insertedId, one: 1 })
            expect(await cursor.next()).toStrictEqual({ _id: two.insertedId, two: 2 })
            expect(await cursor.next()).toStrictEqual({ _id: three.insertedId, three: 3 })
            expect(await cursor.next()).toStrictEqual({ _id: four.insertedId, four: 4 })
            expect(await cursor.next()).toStrictEqual(null)
          })
        })

        describe('deleteOne', () => {
          it('should delete a single document using _id as filter', async () => {
            await db().collection('col').insertOne({ one: 1 })
            const two = await db().collection('col').insertOne({ two: 2 })
            await db().collection('col').insertOne({ three: 3 })

            let actual: any = await db().collection('col').deleteOne({ _id: two.insertedId })

            if (db() instanceof Mdb) {
              actual = { deletedCount: actual.deletedCount }
            }

            expect(actual).toStrictEqual({ deletedCount: 1 })
          })

          it('should delete no documents if _id cannot be found', async () => {
            await db().collection('col').insertOne({ one: 1 })
            const two = await db().collection('col').insertOne({ two: 2 })
            await db().collection('col').insertOne({ three: 3 })

            let actual: any = await db().collection('col').deleteOne({ _id: `${two.insertedId as string}` + 'NOT_FOUND' })

            if (db() instanceof Mdb) {
              actual = { deletedCount: actual.deletedCount }
            }

            expect(actual).toStrictEqual({ deletedCount: 0 })
          })
        })

        describe('insertOne', () => {
          it('should insert a single document with no _id supplied', async () => {
            const expectedDoc = { username: 'Etiko', email: 'test@example.com' }
            const res = await db().collection('users').insertOne(expectedDoc)
            const actualDoc = await db().collection('users').findOne({ _id: res.insertedId })
            expect(actualDoc).toStrictEqual({ _id: res.insertedId, ...expectedDoc })
          })

          it('should insert a single document with _id supplied', async () => {
            const expectedDoc = { _id: '123456' as any, username: 'Etiko', email: 'test@example.com' }
            const res = await db().collection('users').insertOne(expectedDoc)
            const actualDoc = await db().collection('users').findOne({ _id: res.insertedId })
            expect(actualDoc).toStrictEqual(expectedDoc)
          })
        })

        describe('insertMany', () => {
          it('should insert many documents', async () => {
            const expectedDocs = [
              { username: 'Etiko', email: 'test@example.com' },
              { username: 'JJ', email: 'test1@example.com' },
              { username: 'Pablo', email: 'test2@example.com' },
              { username: 'EtienneK', email: 'test3@example.com' },
              { username: 'anon', email: 'test4@example.org' }
            ]
            const res = await db().collection('users').insertMany(expectedDocs)
            const actualDocs = await db().collection('users').find().toArray()

            expect(actualDocs)
              .toStrictEqual(expectedDocs.map((doc, index) => ({ _id: res.insertedIds[index], ...doc })))
            expect(res.insertedCount).toEqual(5)
          })

          it('should insert many documents - some with own ids', async () => {
            const expectedDocs = [
              { username: 'Etiko', email: 'test@example.com' },
              { username: 'JJ', email: 'test1@example.com' },
              { _id: 'custom_id0' as any, username: 'Pablo', email: 'test2@example.com' },
              { username: 'EtienneK', email: 'test3@example.com' },
              { _id: 'custom_id1' as any, username: 'anon', email: 'test4@example.org' }
            ]
            const res = await db().collection('users').insertMany(expectedDocs)
            const actualDocs = await db().collection('users').find().toArray()

            expect(actualDocs)
              .toStrictEqual(expectedDocs.map((doc, index) => ({ _id: res.insertedIds[index], ...doc })))
            expect(res.insertedCount).toEqual(5)
          })

          it('should insert throw error on duplicate _id', async () => {
            const expectedDocs = [
              { _id: 'x' as any, username: 'Etiko', email: 'test@example.com' },
              { _id: 'custom_id0' as any, username: 'JJ', email: 'test1@example.com' },
              { _id: 'custom_id0' as any, username: 'Pablo', email: 'test2@example.com' },
              { username: 'EtienneK', email: 'test3@example.com' },
              { _id: 'custom_id0' as any, username: 'anon', email: 'test4@example.org' }
            ]

            let error
            try {
              await db().collection('users').insertMany(expectedDocs)
            } catch (e) {
              error = e
            }
            expect(error).toBeDefined()
            const actualDocs = await db().collection('users').find().toArray()
            expect(actualDocs).toStrictEqual([expectedDocs[0], expectedDocs[1]])
          })
        })

        describe('replaceOne', () => {
          it('should replace a single document using id as filter', async () => {
            await db().collection('col').insertOne({ one: 1 })
            const two = await db().collection('col').insertOne({ two: 2 })
            await db().collection('col').insertOne({ three: 3 })

            let actual = await db().collection('col')
              .replaceOne({ _id: two.insertedId }, { four: 4 })

            if (db() instanceof Mdb) {
              actual = { modifiedCount: actual.modifiedCount }
            }

            expect(actual).toStrictEqual({ modifiedCount: 1 })

            const four = await db().collection('col').findOne(two.insertedId)
            expect(four).toStrictEqual({ _id: two.insertedId, four: 4 })
          })

          it('should not replace a single document when no document can be found', async () => {
            await db().collection('col').insertOne({ one: 1 })
            await db().collection('col').insertOne({ two: 2 })
            await db().collection('col').insertOne({ three: 3 })

            let actual = await db().collection('col')
              .replaceOne({ value: 'does not exist' }, { four: 4 })

            if (db() instanceof Mdb) {
              actual = { modifiedCount: actual.modifiedCount }
            }

            expect(actual).toStrictEqual({ modifiedCount: 0 })
          })

          it('should replace a single document using id as filter and doc _id is equal', async () => {
            await db().collection('col').insertOne({ one: 1 })
            const two = await db().collection('col').insertOne({ two: 2 })
            await db().collection('col').insertOne({ three: 3 })

            let actual = await db().collection('col')
              .replaceOne({ _id: two.insertedId }, { _id: two.insertedId as string, four: 4 })

            if (db() instanceof Mdb) {
              actual = { modifiedCount: actual.modifiedCount }
            }

            expect(actual).toStrictEqual({ modifiedCount: 1 })

            const four = await db().collection('col').findOne(two.insertedId)
            expect(four).toStrictEqual({ _id: two.insertedId, four: 4 })
          })

          it('should throw Error when replacing a single document and using id as filter not equal to doc _id', async () => {
            await db().collection('col').insertOne({ one: 1 })
            const two = await db().collection('col').insertOne({ two: 2 })
            await db().collection('col').insertOne({ three: 3 })

            let error
            try {
              await db().collection('col')
                .replaceOne({ _id: two.insertedId }, { _id: `${two.insertedId as string}invalid`, four: 4 })
            } catch (e) {
              error = e
            }
            expect(error).toBeDefined()
          })

          it('should replace no documents if id cannot be found', async () => {
            await db().collection('col').insertOne({ one: 1 })
            const two = await db().collection('col').insertOne({ two: 2 })
            await db().collection('col').insertOne({ three: 3 })

            let actual = await db().collection('col')
              .replaceOne({ _id: `${two.insertedId as string}invalid` }, { four: 4 })

            if (db() instanceof Mdb) {
              actual = { modifiedCount: actual.modifiedCount }
            }

            expect(actual).toStrictEqual({ modifiedCount: 0 })
          })
        })
      })
    }
  })
})
