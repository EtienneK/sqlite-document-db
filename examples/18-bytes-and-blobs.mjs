// Bytes: a document field cannot hold them, db.sql can - a BLOB table of your
// own, on the same connection and inside the same transactions as your
// documents.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const reports = db.collection('reports')

// ---------------------------------------------------------------------------
// Storage is JSON, so a document field cannot hold binary - and rather than
// corrupt it silently (a Uint8Array would come back as {"0":37,"1":80,...}),
// the write refuses and names the offending path.
try {
  await reports.insertOne({ name: 'q3.pdf', bytes: new Uint8Array([1, 2, 3]) })
} catch (error) {
  console.log('a document field ->', error.message)
}

// ---------------------------------------------------------------------------
// The escape hatch binds a Uint8Array as a real SQLite BLOB.
await db.sql.run`CREATE TABLE report_files (report_id TEXT PRIMARY KEY, bytes BLOB)`

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) // '%PDF-1.7'
await db.withTransaction(async () => {
  // Document and file commit or roll back TOGETHER - same connection, same
  // transaction, which a second connection to the file could never give you.
  await reports.insertOne({ _id: 'q3', name: 'q3.pdf', pages: 12 })
  await db.sql.run`INSERT INTO report_files VALUES (${'q3'}, ${pdf})`
})

// Bytes come back as a Uint8Array, byte for byte.
const row = await db.sql.get`SELECT bytes FROM report_files WHERE report_id = ${'q3'}`
console.log('round-tripped    ->', row.bytes.constructor.name, [...row.bytes])
console.log('decoded          ->', new TextDecoder().decode(row.bytes))

// length() reads the size from the record header without touching the payload,
// so a metadata query never pays for the content it is about.
const meta = await db.sql.get`SELECT typeof(bytes) AS type, length(bytes) AS size FROM report_files`
console.log('metadata         ->', meta)

// ---------------------------------------------------------------------------
// A rolled-back transaction takes both halves with it.
try {
  await db.withTransaction(async () => {
    await reports.insertOne({ _id: 'q4', name: 'q4.pdf' })
    await db.sql.run`INSERT INTO report_files VALUES (${'q4'}, ${new Uint8Array(1024)})`
    throw Error('changed my mind')
  })
} catch {}
console.log('after rollback   ->', await reports.countDocuments({}), 'document,',
  (await db.sql.get`SELECT COUNT(*) AS n FROM report_files`).n, 'file')

await db.close()
