// Getting results out: cursors, ordering, paging and choosing fields.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const items = db.collection('items')
await items.insertMany([
  { item: 'journal', qty: 25, status: 'A', size: { h: 14, uom: 'cm' } },
  { item: 'notebook', qty: 50, status: 'A', size: { h: 8.5, uom: 'in' } },
  { item: 'paper', qty: 100, status: 'D', size: { h: 8.5, uom: 'in' } },
  { item: 'planner', qty: 75, status: 'D', size: { h: 22.85, uom: 'cm' } },
  { item: 'postcard', qty: 45, status: 'A', size: { h: 10, uom: 'cm' } }
])

// A cursor streams: it fetches one document at a time rather than building the
// whole result set, so iterating a large collection stays cheap.
for await (const doc of items.find({ status: 'A' })) {
  console.log('streamed', doc.item)
}

// next() pulls one at a time; close() releases the statement early.
const cursor = items.find()
console.log('first     ', (await cursor.next()).item)
console.log('second    ', (await cursor.next()).item)
await cursor.close()

// Sorting follows MongoDB's type order, not SQLite's.
console.log('by qty desc', (await items.find().sort({ qty: -1 }).toArray()).map(d => d.qty))
console.log('multi-key  ', (await items.find().sort({ status: 1, qty: -1 }).toArray()).map(d => `${d.status}${d.qty}`))

// Paging. limit(0) means "no limit", as in MongoDB.
console.log('page 2     ', (await items.find().sort({ qty: 1 }).skip(2).limit(2).toArray()).map(d => d.item))

// The same thing as options, if you prefer
console.log('as options ', (await items.find({}, { sort: { qty: 1 }, skip: 2, limit: 2 }).toArray()).map(d => d.item))

// Projection: include, exclude, drop _id, reach into nested documents
console.log('include    ', await items.findOne({ item: 'paper' }, { projection: { item: 1, qty: 1 } }))
console.log('no _id     ', await items.findOne({ item: 'paper' }, { projection: { item: 1, _id: 0 } }))
console.log('exclude    ', await items.findOne({ item: 'paper' }, { projection: { size: 0, status: 0 } }))
console.log('nested     ', await items.findOne({ item: 'paper' }, { projection: { 'size.uom': 1, _id: 0 } }))
console.log('chainable  ', await items.find().project({ item: 1, _id: 0 }).toArray())

await db.close()
