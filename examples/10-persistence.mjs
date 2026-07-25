// A file-backed database, and what "async but synchronous underneath" means.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Db from '../dist/index.js'

const dir = await mkdtemp(join(tmpdir(), 'sqlite-document-db-'))
const file = join(dir, 'data.db')

// busyTimeoutMs is how long a write waits behind a competing writer before
// failing. It only matters for file-backed databases; the default is 5000.
let db = await Db.fromUrl(file, { busyTimeoutMs: 10_000 })
await db.collection('notes').insertMany([
  { title: 'first', body: 'hello' },
  { title: 'second', body: 'world' }
])
await db.collection('notes').createIndex({ title: 1 })
await db.close()

// Reopen: documents and indexes are still there.
db = await Db.fromUrl(file)
console.log('after reopen', await db.collection('notes').countDocuments())
console.log('index kept  ', (await db.collection('notes').indexes()).map(i => i.name))
console.log('found       ', await db.collection('notes').findOne({ title: 'second' }))
await db.close()

// `debug: true` logs every statement, which is the quickest way to see what a
// filter compiled to.
db = await Db.fromUrl(':memory:', { debug: true })
await db.collection('notes').insertOne({ title: 'debug me' })
await db.collection('notes').find({ title: 'debug me' }).toArray()
await db.close()

// One caveat worth knowing: node:sqlite is synchronous, so the async API never
// actually yields mid-operation. Do NOT write to a collection while iterating
// a cursor over it - SQLite leaves that case unspecified. Materialise first:
db = await Db.fromUrl(':memory:')
const notes = db.collection('notes')
await notes.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }])
for (const doc of await notes.find().toArray()) {      // toArray(), not for await
  await notes.updateOne({ _id: doc._id }, { $set: { seen: true } })
}
console.log('safe update ', await notes.countDocuments({ seen: true }))
await db.close()

await rm(dir, { recursive: true, force: true })
