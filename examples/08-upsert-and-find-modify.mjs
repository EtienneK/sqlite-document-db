// Writes that create-or-update, and writes that hand the document back.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const items = db.collection('items')
await items.insertMany([
  { item: 'journal', qty: 25, status: 'A' },
  { item: 'planner', qty: 75, status: 'D' }
])

// ---- upsert -------------------------------------------------------------
// Matched: an ordinary update.
console.log('matched  ', await items.updateOne({ item: 'journal' }, { $inc: { qty: 5 } }, { upsert: true }))

// Unmatched: inserts, and tells you the id it created.
const created = await items.updateOne({ item: 'mousepad' }, { $set: { qty: 10 } }, { upsert: true })
console.log('inserted ', created.upsertedCount, created.upsertedId)

// The new document is seeded from the filter's EQUALITY conditions, then the
// update is applied over them. Note `status` carries over but `qty` does not:
// `$gt` names no single value, so there is nothing to seed from.
await items.updateOne(
  { item: 'ledger', status: 'A', qty: { $gt: 100 } },
  { $inc: { qty: 3 }, $setOnInsert: { createdAt: 'now' } },
  { upsert: true }
)
console.log('seeded   ', await items.findOne({ item: 'ledger' }))

// $setOnInsert applies only when the upsert actually inserts.
await items.updateOne({ item: 'ledger' }, { $set: { qty: 99 }, $setOnInsert: { createdAt: 'later' } }, { upsert: true })
console.log('unchanged', (await items.findOne({ item: 'ledger' })).createdAt)

// ---- find and modify ----------------------------------------------------
// By default you get the document as it was BEFORE the write.
console.log('before   ', await items.findOneAndUpdate({ item: 'journal' }, { $inc: { qty: 1 } }))
console.log('after    ', await items.findOneAndUpdate(
  { item: 'journal' }, { $inc: { qty: 1 } }, { returnDocument: 'after' }
))

// `sort` decides WHICH document is modified - useful for queue-style work.
console.log('largest  ', await items.findOneAndUpdate(
  {}, { $set: { picked: true } },
  { sort: { qty: -1 }, returnDocument: 'after', projection: { item: 1, qty: 1, _id: 0 } }
))

// Replace the whole document, or take one out of the collection.
console.log('replaced ', await items.findOneAndReplace({ item: 'mousepad' }, { item: 'mat', qty: 1 }, { returnDocument: 'after' }))
console.log('deleted  ', await items.findOneAndDelete({ item: 'mat' }))
console.log('nothing  ', await items.findOneAndDelete({ item: 'does-not-exist' }))

await db.close()
