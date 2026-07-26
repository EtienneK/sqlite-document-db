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

// Where it stops pretending: no server means no sessions and no change streams,
// and each says what to reach for instead.
for (const [what, call] of [['startSession', () => client.startSession()], ['watch', () => client.watch()]]) {
  try {
    call()
  } catch (error) {
    console.log(`${what.padEnd(19)}`, error.message.slice(0, 60) + '...')
  }
}

// Multi-document atomicity is db.withTransaction, which is what the session
// error points at.
await client.db().withTransaction(async () => {
  await orders.updateOne({ _id: 1 }, { $inc: { total: 5 } })
  await orders.updateOne({ _id: 2 }, { $inc: { total: -5 } })
})
console.log('after transaction  ', (await orders.find({}).sort({ _id: 1 }).toArray()).map(o => o.total))

await client.close()
