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

// The array operators. $slice takes a window; note it decides NOTHING about
// inclusion or exclusion on its own - the whole document comes back, shortened.
const orders = db.collection('orders')
await orders.insertMany([
  { who: 'ann', lines: [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 9 }, { sku: 'c', qty: 4 }] },
  { who: 'bob', lines: [{ sku: 'a', qty: 7 }] }
])

console.log('\n$slice     ', JSON.stringify(await orders.findOne({ who: 'ann' }, { projection: { _id: 0, lines: { $slice: 2 } } })))
console.log('$slice last', JSON.stringify(await orders.findOne({ who: 'ann' }, { projection: { _id: 0, who: 1, lines: { $slice: -1 } } })))

// $elemMatch returns the FIRST element matching a criterion, and is an
// inclusion - so `who` has to be asked for.
console.log('$elemMatch ', JSON.stringify(await orders.find(
  {}, { projection: { who: 1, _id: 0, lines: { $elemMatch: { qty: { $gt: 5 } } } } }
).toArray()))

// $ returns the element that matched the QUERY, so the query has to say
// something about that array - without a condition it is an error, not a guess.
console.log('positional ', JSON.stringify(await orders.find(
  { 'lines.qty': { $gt: 5 } }, { projection: { _id: 0, who: 1, 'lines.$': 1 } }
).toArray()))

// The rest of the cursor surface. hasNext() PEEKS - the document it looked at
// is still the one next() returns - and map() gives a cursor over transformed
// documents rather than a chainable FindCursor, exactly as the driver's does.
const peeking = orders.find({}).sort({ who: 1 })
while (await peeking.hasNext()) console.log('hasNext    ', (await peeking.next()).who)

console.log('map        ', await orders.find({}).map(order => order.who).toArray())
console.log('count      ', await orders.find({}).limit(1).count(), '(the cursor own limit applies)')

const rewound = orders.find({})
await rewound.next()
rewound.rewind()
console.log('rewind     ', (await rewound.toArray()).length, 'documents again')

await db.close()
