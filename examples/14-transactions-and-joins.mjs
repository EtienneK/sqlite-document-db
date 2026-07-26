// Multi-document atomicity, bulk writes, and joining two collections.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const accounts = db.collection('accounts')
await accounts.insertMany([
  { _id: 'alice', balance: 100 },
  { _id: 'bob', balance: 0 }
])

const balances = async () =>
  Object.fromEntries((await accounts.find({}).sort({ _id: 1 }).toArray()).map(a => [a._id, a.balance]))

// ---------------------------------------------------------------------------
// withTransaction: the read-modify-write a single statement cannot express.
const transfer = async (from, to, amount) =>
  await db.withTransaction(async () => {
    const source = await accounts.findOne({ _id: from })
    if (source.balance < amount) throw Error(`insufficient funds in ${from}`)
    await accounts.updateOne({ _id: from }, { $inc: { balance: -amount } })
    await accounts.updateOne({ _id: to }, { $inc: { balance: amount } })
    return `${amount} moved`
  })

console.log('before             ', await balances())
console.log('transfer 60        ', await transfer('alice', 'bob', 60))
console.log('after              ', await balances())

// A throw anywhere in the callback rolls back EVERYTHING it did - there is no
// state where one side of the transfer happened and the other did not.
try {
  await transfer('alice', 'bob', 500)
} catch (error) {
  console.log('failed transfer    ', `-> ${error.message}`)
}
console.log('unchanged          ', await balances())

// Nesting works, via SAVEPOINT: the inner failure rolls back only its own work.
await db.withTransaction(async () => {
  await accounts.updateOne({ _id: 'alice', }, { $inc: { balance: 1 } })
  try {
    await db.withTransaction(async () => {
      await accounts.updateOne({ _id: 'bob' }, { $inc: { balance: 999 } })
      throw Error('inner failed')
    })
  } catch { /* the outer transaction carries on */ }
})
console.log('outer kept, inner not', await balances())

// ---------------------------------------------------------------------------
// bulkWrite: many kinds of write, one call.
const inventory = db.collection('inventory')
const result = await inventory.bulkWrite([
  { insertOne: { document: { _id: 'sku-1', sku: 'almonds', instock: 120 } } },
  { insertOne: { document: { _id: 'sku-2', sku: 'pecans', instock: 70 } } },
  { updateOne: { filter: { sku: 'cashews' }, update: { $set: { instock: 0 } }, upsert: true } },
  { updateMany: { filter: { instock: { $gt: 50 } }, update: { $inc: { instock: -10 } } } }
])
console.log('\nbulkWrite          ', {
  inserted: result.insertedCount,
  matched: result.matchedCount,
  modified: result.modifiedCount,
  upserted: result.upsertedCount
})

// Ordered by default: it stops at the first failure. Neither mode is atomic -
// wrap the call in withTransaction if you need all-or-nothing.
try {
  await inventory.bulkWrite([
    { insertOne: { document: { _id: 'sku-3', sku: 'walnuts' } } },
    { insertOne: { document: { _id: 'sku-1', sku: 'duplicate' } } },
    { insertOne: { document: { _id: 'sku-4', sku: 'never-attempted' } } }
  ])
} catch (error) {
  console.log('ordered stopped at ', `-> ${error.message.slice(0, 48)}...`)
}
console.log('sku-3 written      ', await inventory.countDocuments({ _id: 'sku-3' }) === 1)
console.log('sku-4 not attempted', await inventory.countDocuments({ _id: 'sku-4' }) === 0)

// ---------------------------------------------------------------------------
// $lookup: a left outer join onto another collection.
const orders = db.collection('orders')
await orders.insertMany([
  { _id: 1, item: 'almonds', qty: 5 },
  { _id: 2, item: 'pecans', qty: 3 },
  { _id: 3, item: 'liquorice', qty: 1 } // nothing in inventory matches
])

const joined = await orders.aggregate([
  { $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'stock' } },
  { $sort: { _id: 1 } }
]).toArray()

for (const order of joined) {
  // Always an array - empty rather than absent when nothing matched.
  console.log(`\n${order.item.padEnd(10)} -> ${JSON.stringify(order.stock.map(s => s.instock))}`)
}

// The join is one query however many input documents there are, and it feeds
// the rest of the pipeline like any other stage.
const value = await orders.aggregate([
  { $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'stock' } },
  { $unwind: '$stock' },
  { $group: { _id: null, totalInStock: { $sum: '$stock.instock' } } }
]).toArray()
console.log('\njoined then grouped', value)

// ---------------------------------------------------------------------------
// Administration.
console.log('\ncollections        ', (await db.listCollections().toArray()).map(c => c.name))
console.log('orders count       ', await orders.estimatedDocumentCount())
console.log('a window of them   ', await orders.countDocuments({}, { skip: 1, limit: 2 }))

await db.dropDatabase()
console.log('after dropDatabase ', await db.listCollections().toArray())

await db.close()
