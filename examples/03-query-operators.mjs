// The query operators, on one small collection.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const items = db.collection('items')
await items.insertMany([
  { item: 'journal', qty: 25, status: 'A', size: { h: 14, uom: 'cm' } },
  { item: 'notebook', qty: 50, status: 'A', size: { h: 8.5, uom: 'in' } },
  { item: 'paper', qty: 100, status: 'D', size: { h: 8.5, uom: 'in' } },
  { item: 'planner', qty: 75, status: 'D', size: { h: 22.85, uom: 'cm' } },
  { item: 'postcard', qty: 45, status: 'A', size: { h: 10, uom: 'cm' } },
  { item: 'sketchbook', status: 'C' } // no qty at all
])

const names = async filter => (await items.find(filter).toArray()).map(d => d.item)

// Comparison
console.log('$eq      ', await names({ status: 'A' }))
console.log('$ne      ', await names({ status: { $ne: 'A' } }))
console.log('$lt/$gte ', await names({ qty: { $gte: 50, $lt: 100 } }))
console.log('$in      ', await names({ status: { $in: ['A', 'D'] } }))
console.log('$nin     ', await names({ status: { $nin: ['A'] } }))

// Logical
console.log('$or      ', await names({ $or: [{ qty: { $lt: 30 } }, { status: 'D' }] }))
console.log('$and     ', await names({ $and: [{ status: 'D' }, { qty: { $gt: 80 } }] }))
console.log('$nor     ', await names({ $nor: [{ status: 'A' }, { status: 'D' }] }))
console.log('$not     ', await names({ qty: { $not: { $gt: 50 } } }))

// Element: note that a missing field and a null one are different things
console.log('$exists  ', await names({ qty: { $exists: false } }))
console.log('$type    ', await names({ qty: { $type: 'number' } }))

// Nested fields use dot notation
console.log('nested   ', await names({ 'size.uom': 'in' }))
console.log('nested $lt', await names({ 'size.h': { $lt: 10 } }))

// Evaluation
console.log('$regex   ', await names({ item: /^p/ }))
console.log('$regex i ', await names({ item: { $regex: '^P', $options: 'i' } }))
console.log('$mod     ', await names({ qty: { $mod: [25, 0] } }))

// $expr puts an aggregation expression in a filter, which is the way to
// compare two fields of the SAME document - no ordinary criterion can.
console.log('$expr    ', await names({ $expr: { $gt: ['$qty', { $multiply: ['$size.h', 5] }] } }))
// It composes with ordinary criteria - and since $expr itself cannot use an
// index, pairing it with one that can is how you keep the scan small.
console.log('$expr+eq ', await names({ status: 'A', $expr: { $gte: ['$qty', { $multiply: ['$size.h', 5] }] } }))

// Bitwise: a bitmask, or the bit positions.
await db.collection('perms').insertMany([
  { who: 'ann', flags: 0b1010 },
  { who: 'bob', flags: 0b0101 },
  { who: 'cid', flags: 0b1111 }
])
const holders = async filter =>
  (await db.collection('perms').find(filter).toArray()).map(d => d.who)
console.log('$bitsAllSet  ', await holders({ flags: { $bitsAllSet: 0b1010 } }))
console.log('$bitsAnySet  ', await holders({ flags: { $bitsAnySet: [0] } }))
console.log('$bitsAllClear', await holders({ flags: { $bitsAllClear: 0b0101 } }))

// $text and $where are refused, and the error says why and what to use instead.
for (const refused of [{ $text: { $search: 'paper' } }, { $where: 'this.qty > 1' }]) {
  try {
    await names(refused)
  } catch (error) {
    console.log('refused  ', error.message.slice(0, 68) + '...')
  }
}

await db.close()
