// Arrays, and the rule that surprises people: a filter on an array field
// matches if ANY element matches.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const items = db.collection('items')
await items.insertMany([
  { item: 'journal', tags: ['blank', 'red'], dim: [14, 21], instock: [{ warehouse: 'A', qty: 5 }] },
  { item: 'notebook', tags: ['red', 'blank'], dim: [14, 21], instock: [{ warehouse: 'C', qty: 5 }] },
  { item: 'paper', tags: ['red', 'blank', 'plain'], dim: [14, 21], instock: [{ warehouse: 'A', qty: 60 }] },
  { item: 'planner', tags: ['blank', 'red'], dim: [22.85, 30], instock: [{ warehouse: 'A', qty: 40 }] },
  { item: 'postcard', tags: ['blue'], dim: [10, 15.25], instock: [{ warehouse: 'B', qty: 15 }, { warehouse: 'C', qty: 35 }] }
])

const names = async filter => (await items.find(filter).toArray()).map(d => d.item)

// A bare value matches an ELEMENT of the array...
console.log('contains "red"      ', await names({ tags: 'red' }))
// ...while an array value matches the whole array, exactly and in order.
console.log('exactly [blank,red] ', await names({ tags: ['blank', 'red'] }))
// The same rule applies to the comparison operators.
console.log('any dim > 25        ', await names({ dim: { $gt: 25 } }))
// ...and to $in.
console.log('$in [red, blue]     ', await names({ tags: { $in: ['red', 'blue'] } }))

// $all: contains every one of these, in any order
console.log('$all [red, blank]   ', await names({ tags: { $all: ['red', 'blank'] } }))
// $size: exact array length
console.log('$size 3             ', await names({ tags: { $size: 3 } }))
// A specific position, by index
console.log('dim.1 > 25          ', await names({ 'dim.1': { $gt: 25 } }))

// Arrays of embedded documents: $elemMatch applies every condition to the
// SAME element, which is usually what you want.
console.log('one elem 15<qty<40  ', await names({ instock: { $elemMatch: { qty: { $gt: 15, $lt: 40 } } } }))
console.log('elem in warehouse A ', await names({ instock: { $elemMatch: { warehouse: 'A', qty: { $gt: 20 } } } }))

// A dotted path descends into the array: this matches any element's qty,
// which is NOT the same as the $elemMatch above once there are two conditions.
console.log('any elem qty = 5    ', await names({ 'instock.qty': 5 }))
console.log('instock.0.qty = 5   ', await names({ 'instock.0.qty': 5 }))

await db.close()
