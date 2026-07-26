// The escape hatch: SQL this library does not compile, on the same connection.
import Db, { parseDocument, stringifyDocument } from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const readings = db.collection('readings')
await readings.insertMany([
  { station: 'north', celsius: 11, at: new Date('2024-01-01T00:00:00Z') },
  { station: 'north', celsius: 17, at: new Date('2024-01-02T00:00:00Z') },
  { station: 'north', celsius: 14, at: new Date('2024-01-03T00:00:00Z') },
  { station: 'south', celsius: 21, at: new Date('2024-01-01T00:00:00Z') },
  { station: 'south', celsius: 25, at: new Date('2024-01-02T00:00:00Z') }
])

// ---------------------------------------------------------------------------
// A window function. There is no aggregation stage for "each reading next to
// the running average for its station", and there does not need to be.
const trend = await db.sql.all`
  SELECT json_extract(data, '$.station')            AS station,
         json_extract(data, '$.celsius')            AS celsius,
         ROUND(AVG(json_extract(data, '$.celsius')) OVER (
           PARTITION BY json_extract(data, '$.station')
           ORDER BY json_extract(data, '$.at.$date')
         ), 1)                                      AS running_avg
  FROM ${db.table('readings')}
  ORDER BY station, json_extract(data, '$.at.$date')`

console.log('running average per station')
for (const row of trend) console.log(' ', row)

// db.table() is the ONE interpolation that is spliced rather than bound - a
// table name cannot be a parameter, and the physical name is not guessable
// ('Users' and 'users' are two collections on a case-insensitive engine).
console.log('\nphysical table    ', db.table('readings').sql)

// ---------------------------------------------------------------------------
// Values are BOUND. This one is a quoted SQL fragment, and it stays data.
const nasty = "'; DROP TABLE collection_readings; --"
const hits = await db.sql.all`
  SELECT COUNT(*) AS n FROM ${db.table('readings')}
  WHERE json_extract(data, '$.station') = ${nasty}`
console.log('rows matching a SQL fragment', hits[0].n, '- and the table is still here:',
  await readings.countDocuments({}), 'documents')

// A Date binds as its ISO string, which is what the storage layer writes at
// <field>.$date - so a range query over dates works in raw SQL too.
const recent = await db.sql.all`
  SELECT json_extract(data, '$.station') AS station FROM ${db.table('readings')}
  WHERE json_extract(data, '$.at.$date') >= ${new Date('2024-01-02T00:00:00Z')}`
console.log('readings on or after 2 Jan  ', recent.length)

// ---------------------------------------------------------------------------
// Rows come back RAW: a document is the data column's JSON text. Decoding is
// one visible call, and it revives Dates.
const [row] = await db.sql.all`SELECT data FROM ${db.table('readings')} LIMIT 1`
console.log('\nraw column        ', row.data)
const doc = parseDocument(row.data)
console.log('decoded           ', doc.station, doc.at instanceof Date ? doc.at.toISOString() : doc.at)

// Writing a document row by hand means using the same encoder, or Dates stop
// round-tripping.
await db.sql.run`
  INSERT INTO ${db.table('readings')} (data)
  VALUES (json(${stringifyDocument({ _id: 'manual', station: 'east', celsius: 30, at: new Date('2024-02-01T00:00:00Z') })}))`
console.log('inserted by hand  ', await readings.findOne({ _id: 'manual' }))

// ---------------------------------------------------------------------------
// It is the same connection, so it takes part in a transaction.
try {
  await db.withTransaction(async () => {
    await db.sql.run`DELETE FROM ${db.table('readings')}`
    console.log('\ninside transaction', await readings.countDocuments({}), 'documents')
    throw Error('changed my mind')
  })
} catch {}
console.log('after rollback    ', await readings.countDocuments({}), 'documents')

// One statement per call: node:sqlite would compile the first and silently
// ignore the rest, so a script is refused rather than half-executed.
try {
  await db.sql.run`SELECT 1; SELECT 2`
} catch (error) {
  console.log('\ntwo statements    ', error.message.split(':')[0])
}

await db.close()
