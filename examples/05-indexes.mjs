// Indexes are the reason to build this on SQLite rather than a JSON file.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const items = db.collection('items')

// 20k documents, so the difference is measurable rather than theoretical.
const docs = Array.from({ length: 20_000 }, (_, i) => ({
  item: `item_${i}`,
  qty: i % 500,
  status: ['A', 'B', 'C', 'D'][i % 4],
  size: { uom: i % 2 ? 'cm' : 'in' }
}))
for (let i = 0; i < docs.length; i += 1000) await items.insertMany(docs.slice(i, i + 1000))

const time = async (label, fn) => {
  const started = process.hrtime.bigint()
  const n = await fn()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`${label.padEnd(22)} ${ms.toFixed(1).padStart(7)}ms  (${n} matches)`)
}

await time('equality, no index', () => items.countDocuments({ qty: 42 }))

// createIndex returns the MongoDB-style name it generated.
console.log('createIndex ->', await items.createIndex({ qty: 1 }))
await time('equality, indexed', () => items.countDocuments({ qty: 42 }))

// Compound and unique indexes, and naming one yourself.
console.log('compound    ->', await items.createIndex({ 'size.uom': 1, status: -1 }))
console.log('named       ->', await items.createIndex({ item: 1 }, { name: 'by_item', unique: true }))

console.log('indexes     ->', (await items.indexes()).map(i => `${i.name}${i.unique === true ? ' (unique)' : ''}`))

await items.dropIndex('by_item')
console.log('after drop  ->', (await items.indexes()).map(i => i.name))

// --- Index properties ------------------------------------------------------

// `sparse` indexes only the documents that HAVE the field. It also changes what
// `unique` means, exactly as it does on MongoDB: a NON-sparse unique index
// treats every document missing the field as holding the same (null) key, so
// only one of them is allowed.
const users = db.collection('users')
await users.createIndex({ nickname: 1 }, { unique: true, sparse: true })
await users.insertMany([{ name: 'ada', nickname: 'countess' }, { name: 'grace' }, { name: 'alan' }])
console.log('sparse unique ->', await users.countDocuments({}), 'users, two without a nickname')

// `partialFilterExpression` is narrower here than on MongoDB, and the error
// says why: SQLite forbids subqueries in a partial index, and every comparison
// this library compiles carries one (so that { status: 'A' } also matches
// { status: ['A'] }). $exists, $and and $or are what is left.
await users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $exists: true } } })
try {
  await users.createIndex({ name: 1 }, { partialFilterExpression: { name: 'ada' } })
} catch (error) {
  console.log('partial, refused ->', error.message.split(':')[0])
}

// --- Seeing what a query actually does -------------------------------------

// find().explain() reports the SQL and the plan SQLite chose for it, which is
// the question MongoDB's much larger explain is usually opened for.
const explained = await items.find({ qty: { $gt: 400 } }).explain()
console.log('explain     ->', explained.indexes)

// `hint` forces an index, spelled INDEXED BY. Like MongoDB's it FAILS rather
// than falling back when the index cannot serve the query.
console.log('hinted      ->', await items.countDocuments({ qty: 42 }, { hint: 'qty_1' }), 'matches')

await db.close()
