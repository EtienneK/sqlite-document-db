// TypeScript: pass a schema and filters, updates and results are all checked.
//
// This example is as much about what does NOT compile as what does - the
// commented-out lines are the point. Run it with:
//   node --experimental-strip-types examples/11-typed.ts   (Node 22.13+)
//   deno run --allow-read --allow-write --allow-env examples/11-typed.ts
//
// Note for Deno: it RUNS this fine, but `deno check` cannot type it, because
// Deno does not map a file-path `./x.js` import to its sibling `./x.d.ts`.
// That is specific to importing by path, as these examples do so they can use
// the local build. Depend on the package normally
// (`import Db from 'npm:sqlite-document-db'`) and the types resolve through
// package.json as usual.
import Db from '../dist/index.js'

interface Item {
  _id: string
  item: string
  qty: number
  status: 'A' | 'D'
  size: { h: number, uom: string }
  tags: string[]
}

const db = await Db.fromUrl(':memory:')

// The schema goes on collection(), and threads through everything after it.
const items = db.collection<Item>('items')

await items.insertMany([
  { _id: '1', item: 'journal', qty: 25, status: 'A', size: { h: 14, uom: 'cm' }, tags: ['blank'] },
  { _id: '2', item: 'planner', qty: 75, status: 'D', size: { h: 22.85, uom: 'cm' }, tags: ['red'] }
])

// Results are typed, so this is a `number`, not `any`.
const found = await items.findOne({ item: 'journal' })
console.log('qty is a number:', typeof found?.qty)

// Filters are checked against the schema, including nested paths.
console.log(await items.find({ qty: { $gte: 50 } }).toArray())
console.log(await items.find({ 'size.uom': 'cm' }).toArray())
console.log(await items.find({ tags: 'red' }).toArray()) // matches an element

// Updates too: $set values must fit the field, $inc needs a numeric one.
await items.updateOne({ item: 'journal' }, { $set: { status: 'D' }, $inc: { qty: 1 } })

// None of the following compile. Uncomment one to see the error:
//
// await items.find({ qtyy: { $gte: 50 } })            // no such field
// await items.find({ qty: { $gte: 'fifty' } })        // qty is a number
// await items.find({ status: 'Z' })                   // not 'A' | 'D'
// await items.find({ qty: { $gtt: 50 } })             // no such operator
// await items.find({ 'size.nope': 1 })                // no such path
// await items.updateOne({}, { $inc: { item: 1 } })    // $inc needs a number
// await items.updateOne({}, { $set: { _id: 'new' } }) // _id is immutable

// Collections opened without a schema stay completely permissive, so untyped
// code keeps working exactly as before.
const loose = db.collection('anything')
await loose.insertOne({ whatever: { shape: ['you', 'like'] } })
console.log(await loose.findOne({ 'whatever.shape': ['you', 'like'] }))

await db.close()
