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

await db.close()
