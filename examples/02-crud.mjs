// Insert, read, update and delete - and what each call reports back.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const items = db.collection('items')

// ---- insert -------------------------------------------------------------
// An _id is generated when you don't supply one. insertMany assigns them in
// place, so the objects you passed in come back carrying their ids.
const doc = { item: 'canvas', qty: 100 }
const { insertedId } = await items.insertOne(doc)
console.log('insertOne ->', insertedId, '| the input now has it too:', doc._id === insertedId)

const many = await items.insertMany([
  { item: 'journal', qty: 25 },
  { item: 'mat', qty: 85 },
  { _id: 'my-own-id', item: 'mousepad', qty: 25 } // ids can be your own
])
console.log('insertMany ->', many.insertedCount, 'documents')

// ---- read ---------------------------------------------------------------
console.log('findOne    ->', await items.findOne({ item: 'journal' }))
console.log('count      ->', await items.countDocuments({ qty: { $lt: 50 } }))

// ---- update -------------------------------------------------------------
// matchedCount vs modifiedCount: a write that changes nothing reports 0
// modified, exactly as MongoDB does.
console.log('update     ->', await items.updateOne({ item: 'journal' }, { $set: { qty: 30 } }))
console.log('no-op      ->', await items.updateOne({ item: 'journal' }, { $set: { qty: 30 } }))
console.log('updateMany ->', await items.updateMany({ qty: { $lt: 50 } }, { $inc: { qty: 5 } }))

// replaceOne swaps the whole document, keeping its _id.
await items.replaceOne({ item: 'mat' }, { item: 'mat', qty: 1, note: 'replaced' })
console.log('replaced   ->', await items.findOne({ item: 'mat' }))

// An update can also be an aggregation PIPELINE (MongoDB 4.2+): the right-hand
// side is the expression language, so a field can be computed from the
// document it lands in - which no operator update can do.
await items.updateMany({}, [
  { $set: { level: { $cond: [{ $gte: ['$qty', 30] }, 'plenty', 'low'] } } }
])
console.log('pipeline   ->', await items.findOne({ item: 'journal' }))

// ---- delete -------------------------------------------------------------
console.log('deleteOne  ->', await items.deleteOne({ item: 'canvas' }))
console.log('deleteMany ->', await items.deleteMany({ qty: { $gt: 1000 } }))
console.log('remaining  ->', await items.countDocuments())

await db.close()
