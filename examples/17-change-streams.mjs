// Watching a collection for changes, and the boundary where a stream gives up.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const orders = db.collection('orders')
await orders.insertMany([
  { _id: 'a', item: 'journal', qty: 25 },
  { _id: 'b', item: 'planner', qty: 75 }
])

// ---------------------------------------------------------------------------
// watch() returns an async iterable of change events. Events are emitted by the
// write methods themselves, so only writes made THROUGH this library, on THIS
// connection, are described - see the invalidate below for what happens when
// something else writes.
const stream = orders.watch()

await orders.insertOne({ _id: 'c', item: 'notebook', qty: 5 })
await orders.updateOne({ _id: 'a' }, { $inc: { qty: 5 }, $unset: { item: '' } })
await orders.deleteOne({ _id: 'b' })

for (let i = 0; i < 3; i++) {
  const event = await stream.next()
  console.log(
    event.operationType.padEnd(8),
    JSON.stringify(event.documentKey),
    // An insert carries the whole document; an update carries a DIFF, which is
    // MongoDB's default (`{ fullDocument: 'updateLookup' }` asks for both); a
    // delete carries neither, only the key above.
    JSON.stringify(event.fullDocument ?? event.updateDescription ?? '')
  )
}
await stream.close()

// ---------------------------------------------------------------------------
// A pipeline filters events before you see them. Only $match, $project,
// $addFields, $set and $unset are allowed - the same list a server allows,
// because a blocking stage could never finish over a stream that does not end.
const bigOnly = orders.watch([{ $match: { 'fullDocument.qty': { $gte: 50 } } }])
await orders.insertOne({ _id: 'd', item: 'diary', qty: 10 })
await orders.insertOne({ _id: 'e', item: 'ledger', qty: 500 })

console.log('matched            ', (await bigOnly.next()).documentKey)
await bigOnly.close()

// ---------------------------------------------------------------------------
// Events are buffered inside a transaction and published when it COMMITS, so a
// rollback is never reported. A server behaves the same way.
const audited = orders.watch()
try {
  await db.withTransaction(async () => {
    await orders.insertOne({ _id: 'rolled-back' })
    throw Error('changed my mind')
  })
} catch { /* expected */ }
await orders.insertOne({ _id: 'f', item: 'binder', qty: 1 })

console.log('after rollback     ', (await audited.next()).documentKey, '<- the rolled-back insert never appears')
await audited.close()

// ---------------------------------------------------------------------------
// The boundary, and the reason this is honest. A change stream here can only
// describe writes it made itself, so anything else ENDS the stream with an
// `invalidate` rather than quietly leaving a gap. Raw SQL is one such case;
// another connection writing to the same file is the other.
const watching = db.collection('orders').watch()
await db.sql.run`DELETE FROM ${db.table('orders')} WHERE json_extract(data, '$.qty') < 5`

const ended = await watching.next()
console.log('boundary           ', ended.operationType, `(${ended.invalidateReason})`)
console.log('stream is over     ', !(await watching.hasNext()))

await db.close()
