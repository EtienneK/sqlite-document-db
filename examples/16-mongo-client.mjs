// The MongoClient-shaped entry point: for a test suite, the swap is one import.
//
//   import { MongoClient } from 'mongodb'              <- before
//   import { MongoClient } from 'sqlite-document-db'   <- after
import { MongoClient } from '../dist/index.js'

// A mongodb:// connection string is accepted and opens an IN-MEMORY database -
// a suite's URL usually comes from configuration, and refusing it would mean
// editing the one line this exists to leave alone.
const client = await MongoClient.connect('mongodb://localhost:27017/shop')

// The database named in the URI is the default, exactly as it is for the driver.
console.log('default database   ', client.db().databaseName)

const orders = client.db().collection('orders')
await orders.insertMany([
  { _id: 1, cust: 'ann', total: 30, status: 'complete' },
  { _id: 2, cust: 'bob', total: 45, status: 'complete' },
  { _id: 3, cust: 'ann', total: 12, status: 'pending' }
])

console.log('findOne            ', await orders.findOne({ cust: 'bob' }))
console.log('aggregate          ', await orders.aggregate([
  { $match: { status: 'complete' } },
  { $group: { _id: '$cust', spent: { $sum: '$total' } } },
  { $sort: { _id: 1 } }
]).toArray())

// In memory, each name is its own database - isolated, as MongoDB's are.
await client.db('analytics').collection('orders').insertOne({ _id: 1, note: 'different database' })
console.log('other database     ', await client.db('analytics').collection('orders').findOne({}))
console.log('original untouched ', await orders.countDocuments({}), 'orders')

// Sessions work, so transaction code written for MongoDB runs unchanged. Pass
// { session } to EVERY operation inside the transaction, as you would there: a
// SQLite transaction belongs to the connection, so an operation that omits it
// takes part anyway rather than running outside - the one divergence, and
// `strict: true` turns it into an error.
const session = client.startSession()
await session.withTransaction(async () => {
  await orders.updateOne({ _id: 1 }, { $inc: { total: 5 } }, { session })
  await orders.updateOne({ _id: 2 }, { $inc: { total: -5 } }, { session })
})
await session.endSession()
console.log('after transaction  ', (await orders.find({}).sort({ _id: 1 }).toArray()).map(o => o.total))

// A rollback is the callback throwing, and nothing it wrote survives.
try {
  await client.withSession(async (scoped) => {
    await scoped.withTransaction(async () => {
      await orders.deleteMany({}, { session: scoped })
      throw Error('changed my mind')
    })
  })
} catch (error) {
  console.log('after rollback     ', error.message, '-', await orders.countDocuments({}), 'orders')
}

// db.withTransaction is the same thing without a token to thread through - this
// library's own shape, and the one to reach for when nothing is being ported.
await client.db().withTransaction(async () => {
  await orders.updateOne({ _id: 3 }, { $set: { status: 'complete' } })
})

// Where it still stops pretending: a change stream reads a replica set oplog,
// which an embedded database does not have.
try {
  client.watch()
} catch (error) {
  console.log('watch              ', error.message.slice(0, 60) + '...')
}

await client.close()
