// Documents hold bytes now: Uint8Array stores as EJSON {"$binary": ...} and
// round-trips - where plain JSON would have corrupted it into {"0":137,...}.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const files = db.collection('files')

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const thumb = Buffer.from([1, 2, 3]) // a Buffer is a Uint8Array, so it stores too

await files.insertMany([
  { name: 'logo.png', bytes: png, meta: { thumb } },
  { name: 'empty.bin', bytes: new Uint8Array(0) },
  { name: 'frames.bin', frames: [thumb, png] }
])

// It comes back as a plain Uint8Array, not a mangled object.
const logo = await files.findOne({ name: 'logo.png' })
console.log('round trip  ', logo.bytes instanceof Uint8Array, Array.from(logo.bytes.slice(0, 4)))

// Equality matches by content - nested fields and array elements included.
console.log('by content  ', (await files.findOne({ bytes: png })).name)
console.log('nested      ', (await files.findOne({ 'meta.thumb': new Uint8Array([1, 2, 3]) })).name)
console.log('in array    ', (await files.findOne({ frames: png })).name)

// $type tells binary apart from plain objects, and $binarySize measures it.
console.log('$type       ', (await files.find({ bytes: { $type: 'binData' } }).toArray()).map(d => d.name))
console.log('$binarySize ', (await files.aggregate([
  { $match: { name: 'logo.png' } },
  { $project: { _id: 0, size: { $binarySize: '$bytes' } } }
]).toArray())[0])

// Update operators compare by content too: an equal byte array is the same
// member of a $addToSet set, and $pull removes by value.
await files.updateOne({ name: 'frames.bin' }, { $addToSet: { frames: Buffer.from([1, 2, 3]) } })
await files.updateOne({ name: 'frames.bin' }, { $pull: { frames: png } })
const frames = (await files.findOne({ name: 'frames.bin' })).frames
console.log('set + pull  ', frames.map(f => Array.from(f)))

// Two deliberate refusals: range comparison (MongoDB orders binary by length
// then bytes, which the stored base64 cannot reproduce) ...
try {
  await files.findOne({ bytes: { $gt: png } })
} catch (error) {
  console.log('no ranges   ', error.message.split(':')[0])
}

// ... and every other typed array, by name, with the fix.
try {
  await files.insertOne({ bad: new Float64Array([1]) })
} catch (error) {
  console.log('other views ', error.message.split(':')[0])
}

await db.close()
