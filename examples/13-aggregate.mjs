// Aggregation: grouping, unwinding, and knowing which half of the pipeline
// runs inside SQLite.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const orders = db.collection('orders')
await orders.insertMany([
  { cust: 'ann', status: 'complete', total: 30, items: [{ sku: 'abc', qty: 2 }, { sku: 'xyz', qty: 1 }] },
  { cust: 'bob', status: 'complete', total: 12, items: [{ sku: 'abc', qty: 1 }] },
  { cust: 'ann', status: 'pending', total: 99, items: [{ sku: 'jkl', qty: 5 }] },
  { cust: 'cid', status: 'complete', total: 45, items: [{ sku: 'xyz', qty: 3 }, { sku: 'abc', qty: 1 }] }
])

const show = async (label, pipeline) => {
  console.log(`\n${label}`)
  console.log(await orders.aggregate(pipeline).toArray())
}

// Group and total. $group's output order is unspecified (on the server too),
// so add a $sort whenever the order matters.
await show('revenue by customer', [
  { $match: { status: 'complete' } },
  { $group: { _id: '$cust', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
  { $sort: { revenue: -1 } }
])

// _id: null groups everything into one bucket.
await show('overall', [
  { $group: { _id: null, revenue: { $sum: '$total' }, average: { $avg: '$total' }, biggest: { $max: '$total' } } }
])

// $unwind turns one document per order into one per line item, which is what
// makes the items groupable at all.
await show('units sold per sku', [
  { $unwind: '$items' },
  { $group: { _id: '$items.sku', units: { $sum: '$items.qty' }, buyers: { $addToSet: '$cust' } } },
  { $sort: { _id: 1 } }
])

// A $match AFTER a $group is the HAVING clause.
await show('skus selling more than 3 units', [
  { $unwind: '$items' },
  { $group: { _id: '$items.sku', units: { $sum: '$items.qty' } } },
  { $match: { units: { $gt: 3 } } }
])

// $project reshapes; a '$path' string is a reference, not a literal.
await show('reshaped by $project', [
  { $match: { cust: 'ann' } },
  { $project: { _id: 0, who: '$cust', 'amount.gross': '$total' } }
])

// $count collapses to a single tally, and emits nothing at all when the input
// is empty (as MongoDB does).
await show('complete orders', [{ $match: { status: 'complete' } }, { $count: 'n' }])
await show('cancelled orders (empty input emits nothing)', [{ $match: { status: 'cancelled' } }, { $count: 'n' }])

// ---------------------------------------------------------------------------
// Where the work happens. A LEADING $match/$sort/$skip/$limit compiles into one
// SELECT - the same SQL find() emits, so it uses the same indexes. Everything
// after that runs in JavaScript. explain() tells you where the line fell.
await orders.createIndex({ status: 1 })

const indexed = orders.aggregate([
  { $match: { status: 'complete' } },
  { $group: { _id: '$cust', revenue: { $sum: '$total' } } }
])
console.log('\npushed into SQLite:', indexed.explain().pushedDown, 'stage(s)')
console.log('left in JavaScript:', indexed.explain().inJavaScript)

// Put $match FIRST. After a $sort or $limit it cannot be reordered without
// changing the answer, so it stays in JavaScript - still correct, just no
// longer index-assisted.
const scanned = orders.aggregate([{ $sort: { total: -1 } }, { $match: { status: 'complete' } }])
console.log('$match after $sort:', scanned.explain().inJavaScript, '<- not index-assisted')

await db.close()
