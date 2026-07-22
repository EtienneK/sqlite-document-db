# SQLite Document DB

> **Status:** under construction. The querying features listed below work and are
> verified against a real MongoDB, but plenty is still missing — see
> [Missing Features](#missing-features).

Use SQLite as a JSON Document Database.

API based on MongoDB's JavaScript API.

Documents are stored one-per-row in a `data JSON` column, and Mongo-style filter
objects are compiled into SQLite [JSON functions](https://www.sqlite.org/json1.html)
so that querying happens inside the database rather than in JavaScript.

**Zero runtime dependencies** — it uses Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html) module, so there is nothing
to compile and no native binaries to install.

## Requirements

Node.js **22.5 or newer** (`node:sqlite` is unavailable before that, and only
became stable in Node 24).

## Getting started

1. Install using NPM:

```
npm i --save sqlite-document-db
```

2. Start using it:

```javascript
import Db from 'sqlite-document-db'

const db = await Db.fromUrl(':memory:') // Can also be a path to your DB file

// Insert some users into a collection
await db.collection('users').insertOne({ username: 'test_user', email: 'test@example.com' })
await db.collection('users').insertMany([
  { username: 'test_user2', email: 'test2@example.com' },
  { username: 'test_user3', email: 'test3@example.com' },
])

const user = await db.collection('users').findOne({ email: 'test3@example.com' })

console.log(user)
```

Console output of the above:

```javascript
{
  _id: '626964400e547e782d04d7f1',
  username: 'test_user2',
  email: 'test2@example.com'
}
```

## Features and examples

### Insert documents

```javascript
// Insert a single document
db.collection('inventory').insertOne({ item: 'canvas', qty: 100, tags: ['cotton'], size: { h: 28, w: 35.5, uom: 'cm' } })

// Insert multiple documents
db.collection('inventory').insertOne([
  { _id: undefined, item: 'journal', qty: 25, tags: ['blank', 'red'], size: { h: 14, w: 21, uom: 'cm' } },
  { item: 'mat', qty: 85, tags: ['gray'], size: { h: 27.9, w: 35.5, uom: 'cm' } },
  { item: 'mousepad', qty: 25, tags: ['gel', 'blue'], size: { h: 19, w: 22.85, uom: 'cm' } }
])
```

### Query documents

```javascript
const items = [
  { item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
  { item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'A' },
  { item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
  { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'C' },
  { item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
  { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' }
]

await db.collection('items').insertMany(items)

// Select a single document
db.collection('items').findOne({ item: 'paper' })

// Select all documents in a collection
const allItemsArray = await db.collection('items').find().toArray()

// Query using equality conditions
db.collection('items').find({ status: 'D' })
db.collection('items').find({ status: { $in: ['A', 'D'] } })
db.collection('items').find({ qty: { $lt: 30 } })
db.collection('items').find({ qty: { $gt: 30 } })
db.collection('items').find({ qty: { $lte: 45 } })
db.collection('items').find({ qty: { $gte: 45 } })
db.collection('items').find({ qty: { $eq: 45 } })
db.collection('items').find({ qty: { $ne: 45 } })
db.collection('items').find({ status: 'A', qty: { $lt: 30 } })
db.collection('items').find({ $or: [{ status: 'A' }, { qty: { $lt: 30 } }] })

// Query nested fields with dot notation
db.collection('items').find({ 'size.uom': 'in' })
```

### Indexes

Collections always have a unique index on `_id`. Additional fields can be indexed with
the MongoDB `createIndex` API — backed by real SQLite expression indexes, so filtered
queries stop being full-table scans:

```javascript
await db.collection('items').createIndex({ qty: 1 })                       // -> 'qty_1'
await db.collection('items').createIndex({ 'size.uom': 1, status: -1 })    // compound
await db.collection('users').createIndex({ email: 1 }, { unique: true })   // unique
await db.collection('items').indexes()                                     // list
await db.collection('items').dropIndex('qty_1')                            // drop
```

Single-field indexes automatically cover `Date` values too (they are stored in a
wrapped format — see below — and get a companion index on the wrapped path).

### Iterate a cursor

Cursors are async-iterable, and fetch one document at a time rather than
materialising the whole result set:

```javascript
for await (const item of db.collection('items').find({ status: 'A' })) {
  console.log(item)
}
```

### Project fields to return

```javascript
// Only these fields (plus _id)...
db.collection('items').find({ status: 'A' }, { projection: { item: 1, status: 1 } })
// ...without _id, via the chainable form
db.collection('items').find({ status: 'A' }).project({ item: 1, status: 1, _id: 0 })
// Exclusions, nested fields, and fields inside arrays of documents
db.collection('items').find().project({ 'size.uom': 0 })
db.collection('items').find().project({ item: 1, 'instock.qty': 1 })
```

### Sort, limit and skip

```javascript
db.collection('items').find().sort({ qty: -1 }).skip(10).limit(5)
db.collection('items').find({}, { sort: { qty: -1 }, skip: 10, limit: 5 }) // same thing

// Multi-key sorting, in MongoDB's BSON type order
db.collection('items').find().sort({ status: 1, qty: -1 })
```

Sorting follows MongoDB's type comparison order (null/missing < numbers <
strings < booleans < dates), verified against real MongoDB.

### Query arrays

```javascript
// Implicit element matching, like MongoDB: matches documents where tags IS
// 'red' or where tags is an array CONTAINING 'red'
db.collection('items').find({ tags: 'red' })
db.collection('items').find({ dim_cm: { $gt: 25 } })       // any element > 25
db.collection('items').find({ tags: { $in: ['red', 'blue'] } })

await db.collection('survey').insertMany([
  { results: [{ product: 'abc', score: 10 }, { product: 'xyz', score: 5 }] },
  { results: [{ product: 'abc', score: 7 }, { product: 'xyz', score: 8 }] }
])

// Match array elements against multiple criteria
db.collection('survey').find({ results: { $elemMatch: { product: 'xyz', score: { $gte: 8 } } } })

// Match on array length, or on an array containing all of a set of values
db.collection('survey').find({ results: { $size: 2 } })
db.collection('items').find({ tags: { $all: ['blank', 'red'] } })
```

### Update documents

```javascript
await db.collection('items').updateOne({ item: 'paper' }, { $set: { status: 'P' } })
await db.collection('items').updateMany({ qty: { $lt: 50 } }, { $set: { status: 'P' }, $inc: { qty: 5 } })
await db.collection('items').updateOne({ item: 'paper' }, { $unset: { status: '' } })
```

## Development

```
npm install
npm test        # runs every assertion against BOTH this library and a real MongoDB
npm run lint
npm run build
```

The test suite is the interesting part: each assertion runs twice, once against
`sqlite-document-db` and once against a real MongoDB booted in-memory, so
MongoDB itself acts as the oracle for correct behaviour. Running the tests
therefore downloads a `mongod` binary the first time.

## Missing Features

Many MongoDB features are missing - either because I have not gotten time to implement them (feel free to help out!) or SQLite can't support them.

### What is supported

Operators: `$eq` `$gt` `$gte` `$lt` `$lte` `$ne` `$in` `$nin` `$and` `$or`
`$not` `$nor` `$exists` `$all` `$elemMatch` `$size`.

Methods: `find()` `findOne()` `countDocuments()` `insertOne()` `insertMany()`
`updateOne()` `updateMany()` `deleteOne()` `deleteMany()` `replaceOne()`
`createIndex()` `dropIndex()` `indexes()` `listIndexes()`.

Update operators: `$set` `$unset` `$inc`. Result objects match the official
driver's shapes (`acknowledged`, `matchedCount`, `modifiedCount`, ...).

### Supported value types

Supported: object, array, string, number, boolean, null — and **`Date`**, which is
stored in MongoDB's [Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/)
format (`{"$date": "..."}`), round-trips as a real `Date`, and works in equality and
range queries:

```javascript
await db.collection('events').insertOne({ name: 'launch', at: new Date('2020-06-15') })
await db.collection('events').find({ at: { $gte: new Date('2020-01-01') } }).toArray()
```

Anything else JSON cannot represent (`RegExp`, `Uint8Array`/`Buffer`, `Map`, `Set`,
`bigint`, functions, `NaN`/`Infinity`) is **rejected at write time** with an error
naming the offending path, rather than silently corrupted the way `JSON.stringify`
would. Design notes in [DR-1 in the backlog](BACKLOG.md#dr-1-document-storage-format).

### Still missing

The planned work is tracked in [BACKLOG.md](BACKLOG.md), prioritised and with notes on
how each piece would be implemented. The headlines:

#### Querying documents

- [Query an Array for an Element](https://www.mongodb.com/docs/manual/tutorial/query-arrays/#query-an-array-for-an-element) — `{ tags: 'B' }` does not yet match a document whose `tags` array *contains* `'B'`
- Projection `$`-operators: `$slice`, `$elemMatch`, `$` positional
- [Type check using `$type`](https://www.mongodb.com/docs/manual/tutorial/query-for-null-fields/#type-check)
- [Evaluation Query Operators](https://www.mongodb.com/docs/manual/reference/operator/query-evaluation/) — `$regex`, `$expr`, `$mod`, …

#### Updating documents

- [`updateOne()` and `updateMany()`](https://www.mongodb.com/docs/manual/tutorial/update-documents/), and the update operators (`$set`, `$inc`, …)

## Thanks

Thanks to <https://github.com/thomas4019/mongo-query-to-postgres-jsonb> for being a huge inspiration for this project.
