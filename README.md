# SQLite Document DB

**An embedded document database for Node, with a query language you already
know.** Documents in, documents out; no schema, no migrations, no server — and
no native module to compile. It is the local-first, CLI, desktop and edge
counterpart to a document store, backed by a single SQLite file.

The query and update language is MongoDB's, because it is the one people
already write for document-shaped data. That makes this **familiar**, not
**interchangeable**: it implements a well-defined subset, verified operator by
operator against a real MongoDB, and it says so wherever the subset ends.
If your goal is to move an application off MongoDB unchanged, this is the
wrong tool — read [Is this the right tool?](#is-this-the-right-tool) first.

```javascript
import Db from 'sqlite-document-db'

const db = await Db.fromUrl('./app.db')            // or ':memory:'
const users = db.collection('users')

await users.insertOne({ name: 'Ada', tags: ['admin'], logins: 0 })
await users.updateOne({ name: 'Ada' }, { $push: { tags: 'owner' }, $inc: { logins: 1 } })
await users.find({ tags: 'admin' }).toArray()
```

## Why it exists

- **Every behaviour is checked against a real MongoDB, not read off the docs.**
  This is the reason to believe a compatibility claim from a subset
  implementation, so it comes first. Each spec runs its assertions **twice** —
  once against this library and once against a MongoDB booted in-process — with
  the same expectation on both. **MongoDB is the oracle**: when an expectation
  is wrong, the MongoDB half fails too, which says the *test* is wrong rather
  than the code. The rules nobody would guess right get copied from the server
  instead of invented — what `$pull` does with a document criterion, whether
  `$addToSet` counts `1` and `true` as equal, what an upsert seeds a new
  document with, how `$ne` behaves against an array field. That is **925 tests
  across 41 spec files**, nearly all of them matched pairs, and it is what turns
  "MongoDB-like" from a description into something that fails a build. Where the
  two are known to differ, [`strict: true`](#strict-mode) turns the difference
  into an error instead of a surprise.
- **Queries run in the database, not in JavaScript.** Filter objects are
  compiled into SQLite [JSON functions](https://www.sqlite.org/json1.html), so
  `find({ qty: { $gt: 25 } })` becomes a `WHERE` clause that a real index can
  serve — measured at 40× faster than a scan on 20k documents. The
  document-store libraries that filter in JS cannot do that at any size.
- **Zero runtime dependencies.** It uses Node's built-in
  [`node:sqlite`](https://nodejs.org/api/sqlite.html): nothing to compile, no
  prebuilt binaries, no `node-gyp`. It runs unchanged on Deno.

## Is this the right tool?

**A good fit for** an app that wants a real document store on a single file:
CLI tools, desktop and Electron apps, local-first sync targets, edge functions,
test fixtures, small services. Anywhere "just use SQLite" is right but modelling
documents as columns is not.

**A poor fit for** lifting an existing MongoDB application over unchanged. This
is a subset — no change streams, no sharding, no replica sets, and an
aggregation pipeline that covers the common shapes rather than all of them.
[Missing Features](#missing-features) is the exact list.

**Using it as a MongoDB test double** works, and is a deliberate use case — it
starts in milliseconds where `mongodb-memory-server` takes seconds. Turn on
[`strict: true`](#strict-mode) if you do: it fails the constructs whose answer
is known to differ, so a passing test means more.

## Requirements

Node.js **22.13 or newer** (`node:sqlite` appeared in 22.5 and only became
stable in Node 24; the custom SQL function behind `$regex` needs
`DatabaseSync.prototype.function`, added in 22.13). Deno works too — the
[examples](examples/) run under both in CI.

> Upgrading from 1.x is a breaking change: see [CHANGELOG.md](CHANGELOG.md).

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

## Examples

Runnable examples live in [examples/](examples/) — CRUD, every query operator,
arrays, indexes with a before/after timing, cursors, dates, upsert, error
handling, TypeScript schemas, and a Deno one. They are executed by CI on Node
and Deno, so they cannot rot:

```bash
npm run examples
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

One divergence worth knowing: after `cursor.close()`, this library yields nothing
more, because the cursor streams straight off a SQLite statement and closing
finalises it. The MongoDB driver has already buffered a batch client-side and
keeps draining it, so `next()` there can still return a document. If you close
a cursor early, do not rely on either behaviour.

### Transactions

```javascript
await db.withTransaction(async () => {
  await accounts.updateOne({ _id: 'a' }, { $inc: { balance: -100 } })
  await accounts.updateOne({ _id: 'b' }, { $inc: { balance: 100 } })
})
```

Commits when the callback returns, rolls back if it throws, and returns
whatever the callback returns. It is the read-modify-write a single statement
cannot express — check a balance, then spend it, with nothing able to slip in
between.

**Not MongoDB's session API, deliberately.** `node:sqlite` is synchronous, so
nothing can interleave between two statements and there is no concurrency for a
session object to coordinate; a callback is the honest shape. Nesting works via
SAVEPOINT — an inner rollback discards only its own work, an outer one discards
everything.

Two things to know: an ordered `insertMany` that fails part-way normally *keeps*
what it wrote, but inside a transaction that rolls back it does not (which is
what you asked for by opening one); and do not iterate a cursor across a
rollback — materialise with `toArray()` first.

### Distinct values, and dropping a collection

```javascript
await db.collection('items').distinct('status')                  // ['A', 'D', 'P']
await db.collection('items').distinct('status', { qty: { $gt: 50 } })
await db.collection('items').drop()
```

```javascript
await db.collection('items').estimatedDocumentCount()             // 5
await db.collection('items').countDocuments({ status: 'A' }, { skip: 1, limit: 2 })
await db.listCollections().toArray()   // [{ name: 'items', type: 'collection' }]
await db.dropDatabase()
```

`distinct` follows the same implicit-array rule queries do: an **array field
contributes its elements**, so `distinct('tags')` over `{ tags: ['a','b'] }`
yields `'a'` and `'b'`, not the array. Values come back in MongoDB's BSON type
order (`null` < numbers < strings < objects < arrays < booleans < dates); the
server does not promise an order at all, so this one is stricter than MongoDB
rather than different from it.

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

### Match with regular expressions, types and modulo

```javascript
db.collection('items').find({ item: /^p/ })                          // implicit regex match
db.collection('items').find({ item: { $regex: '^p', $options: 'i' } })
db.collection('items').find({ item: { $in: [/^p/, 'notebook'] } })   // regexes inside $in/$nin
db.collection('items').find({ qty: { $mod: [4, 0] } })               // qty % 4 === 0
db.collection('items').find({ qty: { $type: 'number' } })            // BSON type aliases and codes
db.collection('items').find({ qty: { $type: ['int', 'string'] } })
```

`$regex` runs JavaScript `RegExp` inside SQLite (via a registered SQL function),
so JS regex syntax applies. MongoDB's `x` (extended) option is not supported.

### Compare two fields with `$expr`

`$expr` puts an [aggregation expression](#aggregate) in a filter, which is the
way to compare two fields of the same document:

```javascript
await db.collection('accounts').find({ $expr: { $gt: ['$spent', '$budget'] } }).toArray()
await db.collection('orders').find({
  $expr: { $gte: [{ $multiply: ['$qty', '$price'] }, 100] }
}).toArray()
```

It works anywhere a filter does — `find`, `countDocuments`, `deleteMany`, a
pipeline `$match` — and composes with `$and`/`$or` and ordinary field criteria.
Three things to know:

- **It cannot use an index.** The expression is evaluated per candidate row, so
  `$expr` is a scan. Narrow it with an indexed criterion in the same filter
  (`{ status: 'open', $expr: … }`) and the index still does its half.
- **An unknown operator is an error**, checked before the query runs — a typo
  fails rather than matching nothing.
- **A document the expression cannot evaluate does not match**, where a real
  server fails the whole query. `{ $expr: { $gt: [{ $multiply: ['$qty', 2] }, 5] } }`
  over a document whose `qty` is a string skips that document here. The
  difference is not a choice: `$expr` runs as a registered SQL function, and an
  exception thrown inside one is swallowed on Node 22.13 and propagates on Node
  26, so raising would make one query behave two ways on two supported runtimes.

### Match on bits

```javascript
db.collection('perms').find({ flags: { $bitsAllSet: 0b1010 } })  // a bitmask...
db.collection('perms').find({ flags: { $bitsAnySet: [1, 3] } })  // ...or bit positions
db.collection('perms').find({ flags: { $bitsAllClear: 0b0100 } })
db.collection('perms').find({ flags: { $bitsAnyClear: 0b1111 } })
```

Only whole numbers are tested — a value with a fractional part, a string or a
missing field never matches — and the implicit-array rule applies, so a field
holding `[1, 8]` matches when one of its elements does.

### Update documents

```javascript
await db.collection('items').updateOne({ item: 'paper' }, { $set: { status: 'P' } })
await db.collection('items').updateMany({ qty: { $lt: 50 } }, { $set: { status: 'P' }, $inc: { qty: 5 } })
await db.collection('items').updateOne({ item: 'paper' }, { $unset: { status: '' } })
await db.collection('items').updateOne({ item: 'paper' }, { $mul: { qty: 2 }, $max: { seen: new Date() } })
await db.collection('items').updateOne({ item: 'paper' }, { $rename: { status: 'state' } })
```

Updates are validated the way MongoDB validates them, rather than being applied
loosely: `_id` is immutable, a field cannot be targeted by two operators in one
update, and `$inc` on a non-numeric field is an error. Each check runs *before*
anything is written, so a rejected update leaves the collection untouched.

### Update arrays

```javascript
const tasks = db.collection('tasks')

await tasks.updateOne({ _id: id }, { $push: { tags: 'urgent' } })
await tasks.updateOne({ _id: id }, { $push: { tags: { $each: ['a', 'b'] } } })
await tasks.updateOne({ _id: id }, { $addToSet: { tags: 'urgent' } })   // only if absent
await tasks.updateOne({ _id: id }, { $pop: { tags: 1 } })               // -1 for the first
await tasks.updateOne({ _id: id }, { $pull: { tags: 'urgent' } })
await tasks.updateOne({ _id: id }, { $pullAll: { tags: ['a', 'b'] } })
```

`$push` takes `$each` with `$sort` and `$slice`, which together are the capped
leaderboard idiom — keep the top three scores and nothing else:

```javascript
await db.collection('players').updateOne(
  { _id: id },
  { $push: { scores: { $each: [{ points: 88 }], $sort: { points: -1 }, $slice: 3 } } }
)
```

`$pull` takes a value or a criterion, and a criterion document is matched
against each element the way `$elemMatch` matches one:

```javascript
await db.collection('orders').updateOne({ _id: id }, { $pull: { items: { qty: { $lt: 1 } } } })
```

`$addToSet` compares by value, not identity, so pushing an equal document twice
adds it once. Pushing onto a field that exists and is not an array is an error,
as it is on the server; onto a missing field it creates the array.

### Bulk writes

```javascript
const result = await db.collection('items').bulkWrite([
  { insertOne: { document: { item: 'new' } } },
  { updateOne: { filter: { item: 'old' }, update: { $set: { status: 'D' } }, upsert: true } },
  { updateMany: { filter: { status: 'A' }, update: { $inc: { qty: 1 } } } },
  { replaceOne: { filter: { item: 'stale' }, replacement: { item: 'fresh' } } },
  { deleteOne: { filter: { qty: 0 } } },
  { deleteMany: { filter: { status: 'X' } } }
])
// { insertedCount, matchedCount, modifiedCount, deletedCount, upsertedCount,
//   insertedIds, upsertedIds }
```

Ordered by default (stops at the first failure); `{ ordered: false }` attempts
them all. Neither is atomic — that matches MongoDB, and
`db.withTransaction()` is how you get all-or-nothing. `insertMany` takes
`{ ordered: false }` too.

### Aggregate

A pipeline covering the common shapes: `$match`, `$sort`, `$limit`, `$skip`,
`$count`, `$group`, `$project`, `$addFields`/`$set`, `$unwind` and `$lookup`,
with the expression operators listed under
[What is supported](#what-is-supported).

```javascript
const revenue = await db.collection('orders').aggregate([
  { $match: { status: 'complete' } },
  { $unwind: '$items' },
  { $group: { _id: '$items.sku', sold: { $sum: '$items.qty' }, customers: { $addToSet: '$cust' } } },
  { $sort: { sold: -1 } },
  { $limit: 10 }
]).toArray()
```

`$lookup` joins another collection:

```javascript
await db.collection('orders').aggregate([
  { $lookup: { from: 'inventory', localField: 'item', foreignField: 'sku', as: 'stock' } }
]).toArray()
```

It is a left outer join — `stock` is always an array, empty when nothing
matches — and it is array-aware on both sides, so a local `['a','b']` joins to
documents keyed `a` and `b` alike. One query fetches all of them, regardless of
how many input documents there are. Only the `localField`/`foreignField` form
is implemented; the `let`+`pipeline` form is rejected by name.

Accumulators: `$sum`, `$avg`, `$min`, `$max`, `$first`, `$last`, `$push`,
`$addToSet`, `$count`.

Expressions are field paths (`'$item'`), literals, `$$ROOT`/`$$REMOVE`, and the
[operator families listed below](#what-is-supported) — arithmetic, comparison,
boolean, conditional, string, array, date and type conversion:

```javascript
await db.collection('orders').aggregate([
  {
    $addFields: {
      total: { $multiply: ['$qty', '$price'] },
      size: { $cond: [{ $gte: ['$qty', 100] }, 'bulk', 'retail'] },
      month: { $dateToString: { date: '$placedAt', format: '%Y-%m' } },
      cheapest: { $min: '$quotes' }
    }
  },
  { $match: { size: 'bulk' } }
]).toArray()
```

An unrecognised operator is an error rather than a silent null. Two rules are
worth knowing, and both are copied from the server rather than invented: a
**missing** value gives null (`{ $add: ['$qty', '$absent'] }` is null) while a
**wrong type** throws (`{ $add: ['$name', 1] }`), and a computed field that
evaluates to missing is omitted from the output rather than set to null.

**Where the work happens.** A leading run of `$match`/`$sort`/`$skip`/`$limit`
is compiled into a single SELECT — the same SQL `find()` emits, so it uses the
same indexes. Everything after that point runs in JavaScript over the results.
`explain()` reports exactly where the boundary fell, which is the difference
between an indexed pipeline and a full scan you did not notice:

```javascript
const cursor = db.collection('orders').aggregate([{ $match: { status: 'x' } }, { $group: { _id: '$sku' } }])
cursor.explain()   // { sql: 'SELECT data FROM ...', pushedDown: 1, inJavaScript: ['$group'] }
```

Put `$match` first. A `$match` after a `$sort` or `$limit` cannot be reordered
without changing the answer, so it stays in JavaScript — still correct, just not
index-assisted. (It is still compiled by the same filter engine, via a temporary
table, so a mid-pipeline `$match` matches exactly like `find()` does.)

### Upsert, and find-and-modify

`upsert` inserts when nothing matched, seeding the new document from the
filter's **equality** conditions (a range or `$in` names no single value, so it
contributes nothing) and then applying the update over them:

```javascript
await db.collection('items').updateOne(
  { item: 'planner', 'size.uom': 'cm' },   // -> { item: 'planner', size: { uom: 'cm' } }
  { $inc: { qty: 1 }, $setOnInsert: { createdAt: new Date() } },
  { upsert: true }
)                                          // -> { ..., qty: 1, createdAt: <Date> }
```

`$setOnInsert` applies only when the upsert actually inserts. `replaceOne` and
`updateMany` take `upsert` too — an upsert that matches nothing always inserts
exactly one document.

The find-and-modify trio returns the document itself, defaulting to the version
from *before* the write, like the driver:

```javascript
await db.collection('items').findOneAndUpdate({ item: 'paper' }, { $inc: { qty: -1 } })
await db.collection('items').findOneAndUpdate(
  {}, { $set: { picked: true } },
  { sort: { qty: -1 }, returnDocument: 'after', projection: { item: 1 } }
)
await db.collection('items').findOneAndReplace({ item: 'paper' }, { item: 'card' }, { upsert: true })
await db.collection('items').findOneAndDelete({ status: 'D' }, { sort: { qty: 1 } })
```

### Handle errors

Write failures carry MongoDB's error codes, so the usual `catch` works unchanged:

```javascript
import { DUPLICATE_KEY_ERROR } from 'sqlite-document-db' // === 11000

try {
  await db.collection('users').insertOne({ _id: 'taken' })
} catch (error) {
  if (error.code === DUPLICATE_KEY_ERROR) { /* already exists */ }
}
```

`MongoServerError` is also exported, but branch on `code` — `instanceof` cannot
match the official driver's class without depending on `mongodb`.

`insertMany` is **ordered**, like MongoDB's: it inserts serially, stops at the
first failure, keeps everything written before it, and never attempts anything
after it. The thrown error carries how far it got, so you do not have to
re-query to find out:

```javascript
try {
  await db.collection('users').insertMany(batch)
} catch (error) {
  error.insertedCount        // how many of `batch` were written
  error.insertedIds          // { <index in batch>: <_id> } for those
}
```

### Typed collections

Pass a schema to `db.collection<T>()` and filters, update documents and results
are all checked against it — including dot-notation paths:

```typescript
interface Item { _id: string, item: string, qty: number, size: { uom: string }, tags: string[] }
const items = db.collection<Item>('items')

await items.find({ qty: { $lt: 30 } })            // ok
await items.find({ 'size.uom': 'cm' })            // ok - nested paths are typed
await items.find({ tags: 'red' })                 // ok - matches an array element
await items.updateOne({ item: 'x' }, { $inc: { qty: 1 } })

await items.find({ qtyy: { $lt: 30 } })           // error: no such field
await items.find({ qty: { $lt: 'thirty' } })      // error: qty is a number
await items.find({ qty: { $gtt: 1 } })            // error: no such operator
await items.updateOne({ item: 'x' }, { $inc: { item: 1 } })  // error: $inc needs a number
```

Only operators this library actually implements appear in the types, so
anything that compiles will run. Collections opened without a schema stay
completely permissive, so untyped code is unaffected.

### Strict mode

Everything outside the supported subset is already an error. `strict: true`
handles the harder case: the constructs that *are* accepted, *do* return
something, and return something a real server would not.

```javascript
const db = await Db.fromUrl(':memory:', { strict: true })
```

It rejects, rather than silently answering differently:

| Construct | Lenient behaviour | Why it differs |
| --- | --- | --- |
| `{ 'a.b.c.d': 1 }` | matches fewer documents | only two array levels of a dotted path are expanded — use `$elemMatch` |
| `{ x: { $type: 'objectId' } }` | matches nothing | the type cannot be stored here, so "nothing" is an artefact, not a fact about your data |
| `.sort({ v: 1 })` where some `v` is an array | orders arrays as a group | MongoDB orders them by their smallest (asc) or largest (desc) element |
| `'$instock.qty'` in a pipeline | reads as missing | MongoDB maps the path over the array — `$unwind` first |

This is a boundary check, not a proof of equivalence: it catches the divergences
that are known and detectable. It is off by default, and the intended use is a
test suite that runs against this library instead of a real `mongod` — a passing
suite under `strict` is a much stronger signal than one without it.

### Collection names

Names are **case-sensitive**, as MongoDB's are, and accept anything MongoDB
accepts (`my-data`, `audit.log`, `Items`). Rejected: an empty name, a `$`, a NUL
byte, and the `system.` / `sqlite_` prefixes.

```javascript
db.collection('Users')  // a different collection from...
db.collection('users')  // ...this one
```

### Raw SQL

Your documents are in SQLite, so you should be able to use SQLite. `db.sql` is
three tagged templates — named after the methods a SQLite user already knows —
for the query this library cannot compile: a recursive CTE, a window function, a
join, a `PRAGMA`.

```javascript
const busiest = await db.sql.all`
  SELECT json_extract(data, '$.city') AS city, COUNT(*) AS n
  FROM ${db.table('places')}
  GROUP BY city
  HAVING n > ${threshold}
  ORDER BY n DESC`
// → [ { city: 'Cape Town', n: 2 }, ... ]

const row = await db.sql.get`SELECT COUNT(*) AS n FROM ${db.table('places')}`
const { changes } = await db.sql.run`DELETE FROM ${db.table('places')} WHERE rowid = ${id}`
```

It runs on the **same connection** as everything else, so it sees uncommitted
writes and joins in on [`withTransaction`](#transactions) with nothing to thread
through — which is the thing a second connection to the same file cannot do.

Four things to know:

- **Interpolations are bound, not spliced.** Every `${}` becomes a `?`
  parameter, so a value can never become SQL. Strings, numbers, booleans
  (as 1/0), `null`, `Date` (as its ISO string, which is what is stored at
  `<field>.$date`) and objects/arrays (as their storage JSON, ready for
  `json(?)`) are all bindable; anything else throws.
- **`db.table(name)` is the exception**, and the only one. A table name cannot
  be a parameter, and the physical name is not guessable — `Users` and `users`
  are two collections on an engine that compares identifiers
  case-insensitively, so awkward names carry a digest. It returns the quoted
  name, produced by this library rather than by you.
- **Rows come back raw.** A document is the `data` column's JSON *text*.
  `parseDocument` decodes it (and revives Dates); `stringifyDocument` is the
  encoder to use if you write a document row by hand.

  ```javascript
  import { parseDocument } from 'sqlite-document-db'

  const rows = await db.sql.all`SELECT data FROM ${db.table('places')} LIMIT 10`
  const docs = rows.map(row => parseDocument(row.data))
  ```
- **One statement per call.** `node:sqlite` compiles the first statement and
  silently ignores the rest, so a two-statement string would half-execute and
  report success. That is refused rather than allowed; send them one at a time,
  inside `withTransaction()` if they must be atomic.

Errors are not translated: a constraint violation here surfaces the way SQLite
reports it, because you are writing SQL rather than calling `insertOne`.

## Development

```
npm install
npm test         # runs every assertion against BOTH this library and a real MongoDB
npm run test:types  # type-level assertions, including cases that must NOT compile
npm run examples # builds, then runs every example in examples/
npm run bench    # benchmarks (indexed vs full-scan queries, writes) over 20k docs
npm run lint
npm run build
```

The test suite is the interesting part, and the reason the compatibility claim
at the top of this file is worth anything: each assertion runs twice, once
against `sqlite-document-db` and once against a real MongoDB booted in-memory,
so MongoDB itself is the oracle for correct behaviour. A spec looks like this:

```javascript
for (const dbName of ['Sqlite', 'Mongodb']) {
  const db = () => dbName === 'Sqlite' ? dbs.sqlite() : dbs.mongo()

  it('matches an array element', async () => {
    expect((await db().collection('t').findOne({ tags: 'B' }))?._id).toStrictEqual(1)
  })
}
```

Because the expectation is shared, a **wrong** expectation fails the `Mongodb`
half — which immediately says the test is wrong rather than the implementation.
One mongod is booted for the whole run and each spec file gets its own database
on it, so the suite finishes in about four seconds; the first run downloads a
`mongod` binary.

Two things this catches that a hand-written expectation would not: the exact
semantics of operators nobody remembers correctly (`$pull` with a criterion
document, `$mul` on a missing field, what an upsert inserts), and divergences in
places nobody thinks to look — string sort order outside the Basic Multilingual
Plane was wrong until [test/unicode.spec.ts](test/unicode.spec.ts) asked the
server. Divergences that cannot be fixed are enforced instead, by
[`strict: true`](#strict-mode).

## Missing Features

This library implements a subset of MongoDB's API. The subset is listed exactly
below, and everything outside it **throws** rather than being quietly ignored —
an unknown operator, stage or accumulator is an error, so you find the edge at
the call site instead of in a wrong result.

### What is supported

Query operators: `$eq` `$gt` `$gte` `$lt` `$lte` `$ne` `$in` `$nin` `$and` `$or`
`$not` `$nor` `$exists` `$type` `$regex` (with `$options`) `$mod` `$all`
`$elemMatch` `$size` `$expr` `$bitsAllSet` `$bitsAnySet` `$bitsAllClear`
`$bitsAnyClear`.

Update operators: `$set` `$unset` `$inc` `$mul` `$min` `$max` `$rename`
`$setOnInsert` `$push` (with `$each`, `$slice`, `$sort`) `$addToSet` (with
`$each`) `$pop` `$pull` `$pullAll`, plus the `upsert` option on
`updateOne`/`updateMany`/`replaceOne`.

Accumulators: `$sum` `$avg` `$min` `$max` `$first` `$last` `$push` `$addToSet`
`$count`.

Aggregation stages: `$match` `$sort` `$limit` `$skip` `$count` `$group`
`$project` `$addFields`/`$set` `$unwind` `$lookup`.

Expression operators, for `$project`, `$addFields`, `$group._id` and
accumulator arguments:

| Family | Operators |
| --- | --- |
| Arithmetic | `$add` `$subtract` `$multiply` `$divide` `$mod` `$abs` `$ceil` `$floor` `$round` `$trunc` `$pow` `$sqrt` |
| Comparison | `$cmp` `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` |
| Boolean | `$and` `$or` `$not` |
| Conditional | `$cond` `$ifNull` `$switch` |
| String | `$concat` `$toLower` `$toUpper` `$split` `$strLenCP` `$substrCP` `$indexOfCP` `$trim` `$ltrim` `$rtrim` `$replaceOne` `$replaceAll` `$strcasecmp` |
| Array | `$size` `$isArray` `$arrayElemAt` `$first` `$last` `$slice` `$concatArrays` `$in` `$reverseArray` `$range` `$map` `$filter` `$reduce` `$sum` `$avg` `$min` `$max` |
| Date | `$year` `$month` `$dayOfMonth` `$hour` `$minute` `$second` `$millisecond` `$dayOfWeek` `$dayOfYear` `$dateToString` |
| Type | `$type` `$isNumber` `$toString` `$toBool` `$toInt` `$toDouble` `$toDate` |
| Other | `$literal` `$let`, and the variables `$$ROOT` `$$CURRENT` `$$REMOVE` |

Dates are handled in **UTC**: a `timezone` option throws rather than being
ignored, because answering a timezone question in UTC is a wrong answer that
looks right.

Methods: `find()` `findOne()` `countDocuments()` `estimatedDocumentCount()`
`distinct()` `aggregate()` `insertOne()` `insertMany()` `updateOne()`
`updateMany()` `deleteOne()` `deleteMany()` `replaceOne()` `bulkWrite()`
`findOneAndUpdate()` `findOneAndReplace()` `findOneAndDelete()` `createIndex()`
`dropIndex()` `indexes()` `listIndexes()` `drop()`; on `Db`,
`withTransaction()` `listCollections()` `dropDatabase()`, and
[`sql`](#raw-sql) / `table()` for SQL this library does not compile.

Result objects match the official driver's shapes (`acknowledged`,
`matchedCount`, `modifiedCount`, `upsertedId`, ...), and errors match its codes
(`11000` for a duplicate key).

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
would. (`RegExp` still works fine as a *query* value via `$regex` — it just cannot
be stored in documents.) Design notes in
[DR-1 in the backlog](BACKLOG.md#dr-1-document-storage-format).

One field shape is reserved by that format: an object that is exactly
`{ "$date": "<string>" }` is indistinguishable from a stored `Date`, so it is
rejected on write too. Objects that merely *contain* a `$date` key
(`{ $date: '…', tz: 'UTC' }`) store normally.

### `_id` values

Any storable value works as an `_id`: **string, number, boolean, `Date`, or a
document**. Omit it (or pass `undefined`/`null`) and a MongoDB-compatible
ObjectId hex string is generated. Ids are compared by value *and* type, so `42`
and `'42'` are two different documents, and `_id` is immutable once written.

An **array `_id` is rejected**. MongoDB forbids it too, but here it is worse
than invalid: the implicit array-element rule would let `{ _id: [...] }` match a
*different* document that merely contains the value, so `deleteOne` could remove
the wrong row. Pinned in [test/id-types.spec.ts](test/id-types.spec.ts).

### Document limits

Measured against the SQLite `node:sqlite` bundles, and pinned by tests rather
than quoted from documentation:

| | Limit |
| --- | --- |
| Nesting depth | **200 levels**, counting the document itself as one. A `Date` costs a level (it is stored as `{"$date": …}`). Exceeding it is a clear error naming the path, not SQLite's bare "malformed JSON". MongoDB is stricter here — it refuses at ~180 — so a document this library accepts at the limit is one a real server would reject. |
| Document size | No practical limit — SQLite's is ~1GB, and 40MB documents store and read back fine. **There is no 16MB cap**, so a document that a real MongoDB would reject may be stored here. |
| Array length | No practical limit; 100k elements is fine. |

The size difference is the one to watch if you use this as a MongoDB test
double: an oversized document passes here and fails on the server.

### Concurrency

`node:sqlite` is synchronous, so the `async` API never actually yields mid-operation
— there is no interleaving within a single call. Two things follow:

- **Do not write to a collection while iterating a cursor over it.** SQLite leaves
  the result of modifying a table mid-`SELECT` unspecified; rows may be visited
  twice or skipped. Materialise with `toArray()` first.
- **File-backed databases across processes** work under WAL, but writers still
  serialise. `busyTimeoutMs` (default 5000) controls how long a write waits for a
  competing writer before failing:

  ```javascript
  const db = await Db.fromUrl('./data.db', { busyTimeoutMs: 10_000 })
  ```

### Still missing

The planned work is tracked in [BACKLOG.md](BACKLOG.md), prioritised and with notes on
how each piece would be implemented. The headlines:

**Querying**

- Projection `$`-operators: `$slice`, `$elemMatch`, `$` positional
- `$text`. It needs a stemming full-text index, and SQLite's FTS5 stemmer does
  not agree with MongoDB's — the same query would return different documents on
  the two, which is the one thing this library will not do quietly. Use
  `$regex`, or build an FTS5 table of your own through [`db.sql`](#raw-sql),
  where the tokenizer is your choice. The error says so.
- `$where` will **not** be supported (it executes arbitrary JavaScript). `$expr`
  covers the same comparisons without running code.

**Updating**

- `$position` inside `$push`, and the positional operators `$` / `$[]` / `$[<id>]`

**Collection / Db API**

- `renameCollection()`, index options beyond `unique`/`name`, `watch()`

**Aggregation** — the pipeline is a common-shapes subset, not the whole thing:

- Stages: `$facet`, `$bucket`, `$replaceRoot`, `$out`, `$merge`, `$sample`,
  `$graphLookup`; and `$lookup`'s `let`+`pipeline` form
- Expression operators outside the table above: the set family
  (`$setUnion`, …), trigonometry, `$dateFromString` and the rest of the date
  arithmetic (`$dateAdd`, `$dateDiff`, `$dateTrunc`), and timezone support on
  the date operators. `$function` and `$accumulator` will **not** be supported,
  for the same reason as `$where`
- `$group` accumulators beyond the nine listed above

**Not planned**

- Change streams, replication, sharding, `$where`, server-side JavaScript,
  GridFS, the wire protocol. A process that needs those needs a server.
  (Multi-document atomicity within one connection *is* supported — see
  [Transactions](#transactions).)

## Thanks

Thanks to <https://github.com/thomas4019/mongo-query-to-postgres-jsonb> for being a huge inspiration for this project.
