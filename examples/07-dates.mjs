// Dates survive a round trip and can be compared - which plain JSON cannot do.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const events = db.collection('events')

await events.insertMany([
  { name: 'alpha', at: new Date('2020-01-15T09:00:00Z') },
  { name: 'beta', at: new Date('2020-06-15T12:30:00Z') },
  { name: 'gamma', at: new Date('2021-03-01T18:45:00Z') },
  { name: 'delta', at: new Date('2022-11-20T06:15:00Z') }
])

// It comes back as a real Date, not a string.
const alpha = await events.findOne({ name: 'alpha' })
console.log('round trip  ', alpha.at instanceof Date, alpha.at.toISOString())

// Equality and ranges both work.
console.log('exact       ', (await events.findOne({ at: new Date('2020-06-15T12:30:00Z') })).name)
console.log('after 2021  ', (await events.find({ at: { $gte: new Date('2021-01-01') } }).toArray()).map(d => d.name))
console.log('during 2020 ', (await events.find({
  at: { $gte: new Date('2020-01-01'), $lt: new Date('2021-01-01') }
}).toArray()).map(d => d.name))

// Sorting is chronological.
console.log('newest first', (await events.find().sort({ at: -1 }).toArray()).map(d => d.name))

// $type knows a stored Date is a date, never a plain object.
console.log('$type date  ', (await events.find({ at: { $type: 'date' } }).toArray()).length)

// Dates go through update operators too.
await events.updateOne({ name: 'alpha' }, { $set: { seenAt: new Date('2023-01-01T00:00:00Z') } })
console.log('$set date   ', (await events.findOne({ name: 'alpha' })).seenAt instanceof Date)

// A single-field index automatically covers the wrapped date, so range queries
// on it are index-served.
console.log('index       ', await events.createIndex({ at: 1 }))

// Values JSON cannot represent are refused rather than silently mangled.
try {
  await events.insertOne({ name: 'bad', pattern: /nope/ })
} catch (error) {
  console.log('rejected    ', error.message.split(':')[0])
}

await db.close()
