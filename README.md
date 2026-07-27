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
  document with, how `$ne` behaves against an array field. That is **1267 tests
  across 46 spec files**, nearly all of them matched pairs, and it is what turns
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
is a subset — no sharding, no replica sets, change streams that see one process,
and an aggregation pipeline that covers the common shapes rather than all of
them. [Missing Features](#missing-features) is the exact list.

**Using it as a MongoDB test double** works, and is a deliberate use case — it
starts in milliseconds where `mongodb-memory-server` takes seconds, and
[a `MongoClient` shim](#a-mongoclient-shaped-entry-point) makes the swap a
one-line import change. Turn on [`strict: true`](#strict-mode) if you do: it
fails the constructs whose answer is known to differ, so a passing test means
more.

## Requirements

Node.js **24 or newer** — the first line where `node:sqlite` is stable. Node
22 had the module (from 22.13) but two of its bugs bit in practice: a live
cursor's statement could be garbage-collected out from under it, and an
exception thrown from a custom SQL function inside an UPDATE was silently
swallowed into NULL. Both are fixed in 24. Deno works too — the
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
handling, TypeScript schemas, full-text search, bytes through `db.sql`, and a
Deno one. They are executed by CI on Node and Deno, so they cannot rot:

```bash
npm run examples
```

## Features and examples

### Insert documents

```javascript
// Insert a single document
db.collection('inventory').insertOne({ item: 'canvas', qty: 100, tags: ['cotton'], size: { h: 28, w: 35.5, uom: 'cm' } })

// Insert multiple documents
db.collection('inventory').insertMany([
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
await db.collection('users').createIndex({ nickname: 1 }, { sparse: true }) // sparse
await db.collection('items').createIndexes([{ key: { a: 1 } }, { key: { b: -1 } }])
await db.collection('items').indexes()                                     // list
await db.collection('items').indexExists('qty_1')                          // check
await db.collection('items').dropIndex('qty_1')                            // drop
await db.collection('items').dropIndexes()                                 // drop all but _id_
```

Single-field indexes automatically cover `Date` values too (they are stored in a
wrapped format — see below — and get a companion index on the wrapped path).

**`sparse: true`** indexes only the documents that *have* the field, which is a
SQLite partial index. It also changes what `unique` means, exactly as it does on
MongoDB: a non-sparse unique index treats every document missing the field as
holding the same (null) key and permits only one of them, while a sparse one
ignores them entirely. (SQLite alone would allow *all* of them — a SQL unique
index counts every NULL as distinct — so a second index is created behind the
scenes to close that gap.)

**`partialFilterExpression`** exists but is **narrower here than on MongoDB**,
and the error message says why. SQLite forbids subqueries in a partial index's
`WHERE`, and every comparison this library compiles carries one, because
`{ status: 'A' }` also has to match `{ status: ['A'] }`. What is left is
`$exists`, `$and` and `$or`:

```javascript
await db.collection('users').createIndex(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $exists: true } } }
)
```

**`hint`** forces a particular index, by name or by key pattern. SQLite spells it
`INDEXED BY`, and like MongoDB's it *fails* rather than falling back when the
index cannot serve the query:

```javascript
await db.collection('items').find({ qty: { $gt: 10 } }, { hint: 'qty_1' }).toArray()
await db.collection('items').countDocuments({ qty: { $gt: 10 } }, { hint: { qty: 1 } })
```

`hidden` and `expireAfterSeconds` (TTL) are **rejected** rather than ignored:
SQLite has no way to keep an index from its own planner, and there is no
background reaper here.

### Iterate a cursor

Cursors are async-iterable, and fetch one document at a time rather than
materialising the whole result set:

```javascript
for await (const item of db.collection('items').find({ status: 'A' })) {
  console.log(item)
}
```

The rest of the cursor surface is there too — `hasNext()`, `tryNext()`,
`forEach()`, `map()`, `rewind()`, `count()`, `close()`:

```javascript
const cursor = db.collection('items').find({ status: 'A' })
while (await cursor.hasNext()) console.log(await cursor.next())

const names = await db.collection('items').find({}).map(item => item.name).toArray()
```

One divergence worth knowing: after `cursor.close()`, this library yields nothing
more, because the cursor streams straight off a SQLite statement and closing
finalises it. The MongoDB driver has already buffered a batch client-side and
keeps draining it, so `next()` there can still return a document. If you close
a cursor early, do not rely on either behaviour.

Prepared statements are **cached per connection**, keyed by their SQL — every
value is bound as a parameter, so the same operation is the same SQL text, and
repeating it skips the prepare (measured on a file-backed database: `findOne`
by id 3.4× faster, `updateOne` inside a transaction 4.3×). A statement a live
cursor is streaming from is never shared: a concurrent identical query gets its
own transient statement.

### See what a query does

`find().explain()` reports the SQL a cursor runs and the plan SQLite chose for
it — which answers the question MongoDB's much larger `explain` is usually
opened for. The shape is this library's own, because MongoDB's describes a query
planner that is not here:

```javascript
const { sql, params, plan, indexes } = await db.collection('items')
  .find({ qty: { $gt: 100 } })
  .explain()

console.log(indexes)   // [ 'ix_collection_items_qty_1' ] — or [] for a scan
```

`aggregate().explain()` answers a different question: where the SQL/JavaScript
boundary of a pipeline falls. See [Aggregate](#aggregate).

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

A callback rather than a token to thread through, because `node:sqlite` is
synchronous: nothing can interleave between two statements, so there is no
concurrency for a session object to coordinate. Nesting works via SAVEPOINT — an
inner rollback discards only its own work, an outer one discards everything.

**MongoDB's session API works too**, for code that is already written that way:

```javascript
const session = client.startSession()
await session.withTransaction(async () => {
  await accounts.updateOne({ _id: 'a' }, { $inc: { balance: -100 } }, { session })
  await accounts.updateOne({ _id: 'b' }, { $inc: { balance: 100 } }, { session })
})
await session.endSession()
```

`startTransaction()`/`commitTransaction()`/`abortTransaction()`,
`client.withSession(work)`, `inTransaction()` and `{ session }` on every
operation are all there, and all checked against a real MongoDB — see
[sessions](#sessions-and-the-one-thing-they-cannot-do) for the single thing a
session here cannot do.

Two more things to know: an ordered `insertMany` that fails part-way normally
*keeps* what it wrote, but inside a transaction that rolls back it does not
(which is what you asked for by opening one); and do not iterate a cursor across
a rollback — materialise with `toArray()` first.

### Distinct values, and dropping a collection

```javascript
await db.collection('items').distinct('status')                  // ['A', 'D', 'P']
await db.collection('items').distinct('status', { qty: { $gt: 50 } })
await db.collection('items').rename('archived_items')            // -> the renamed Collection
await db.collection('items').drop()
```

```javascript
await db.collection('items').estimatedDocumentCount()             // 5
await db.collection('items').countDocuments({ status: 'A' }, { skip: 1, limit: 2 })
await db.listCollections().toArray()   // [{ name: 'items', type: 'collection' }]
await db.renameCollection('items', 'archived_items')
await db.stats()                       // { collections, objects, dataSize, ... }
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

The three array operators are supported too:

```javascript
// $slice — a window over an array
db.collection('posts').find().project({ comments: { $slice: 5 } })      // the first five
db.collection('posts').find().project({ comments: { $slice: -5 } })     // the last five
db.collection('posts').find().project({ comments: { $slice: [10, 5] } }) // skip 10, take 5

// $elemMatch — the first element matching a criterion
db.collection('students').find().project({ grades: { $elemMatch: { score: { $gt: 80 } } } })

// $ positional — the element that matched the query
db.collection('students').find({ 'grades.score': { $gt: 80 } }).project({ 'grades.$': 1 })
```

Two rules are easy to get wrong, and both are copied from the server:

- **`$slice` decides nothing about inclusion or exclusion.** A projection of
  nothing but `$slice` returns whole documents with one array shortened;
  alongside `{ name: 1 }` it behaves as an inclusion, and alongside
  `{ name: 0 }` the sliced field is kept. `$elemMatch` and `$` are ordinary
  inclusions.
- **A field with no matching element is omitted**, not returned empty — for
  both `$elemMatch` and `$`.

`$` needs the query to constrain the array it projects (that is where the
matching element comes from), cannot be combined with exclusion, and may appear
once per projection; each of those is an error rather than a quiet answer.
Deciding *which* element matched is done by the query engine, as an extra
column of the query already being run — so `find()` pays no extra statement for
it, and there is only ever one implementation of the filter language.

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

> **Security note.** The pattern is compiled to a real `RegExp` and tested once
> per candidate row. Because `node:sqlite` is synchronous, a catastrophic-
> backtracking pattern (e.g. `(a+)+$`) over attacker-influenced data blocks the
> event loop until it finishes — a denial-of-service risk inherent to running
> regexes, which MongoDB shares. **Do not build `$regex` patterns from untrusted
> input** without validating them first; the compiled-pattern cache is bounded,
> so it will not grow without limit, but a single bad pattern is still enough.

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
  over a document whose `qty` is a string skips that document here. A
  deliberate divergence: one badly-shaped document should not veto a query over
  a schema-less store — and a future engine without custom SQL functions could
  not surface the error anyway.

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

### Full-text search

Search is this library's **own feature**, under its own name — deliberately not
`$text` (SQLite's FTS5 stemmer does not agree with MongoDB's, so the same query
would return different documents, which is the one thing this library will not
do quietly) and not `$search` (Atlas-only, so there is no server to check it
against even in principle). What it promises, it can keep: SQLite's FTS5, with
the tokenizer named by you.

```javascript
const articles = db.collection('articles')
await articles.createSearchIndex({ fields: ['title', 'body'], tokenizer: 'porter' })

const hits = await articles.searchText('running shoes', { limit: 10 })
// → [ { score: 1.94, document: { _id: …, title: 'Trail running shoes', … } }, … ]

await articles.searchText('"walking boots"') // FTS5 query syntax passes through:
await articles.searchText('walk* NOT city')  // phrases, prefixes, NOT/AND/OR,
await articles.searchText('title : cycling') // per-field filters

await articles.listSearchIndexes().toArray() // → [{ name, fields, tokenizer? }]
await articles.dropSearchIndex('default')
```

- **The index is kept in step by SQLite triggers**, not by this library's write
  path — so documents inserted, updated or deleted through [`db.sql`](#raw-sql)
  stay searchable too, which no library-side hook could promise.
- **The tokenizer is yours, verbatim** (`'porter'`, `'trigram'`,
  `'unicode61 remove_diacritics 2'`, …). Omitted, FTS5's default applies:
  `unicode61`, which does **not** stem — `run` will not match `running` unless
  you choose a stemmer.
- **A field contributes its value when it is a string**, and its string
  elements when it is an array — the rule MongoDB's own text indexes follow.
  Numbers, objects and `Date`s are never searchable text.
- **`score` is BM25** (negated, so higher is more relevant), and hits arrive
  best-first. The ordering is the contract; the magnitude is FTS5's.
- The index follows `rename()`, disappears with `drop()`, and rolls back with a
  transaction like everything else. Names accept letters, digits, `_` and `-`;
  the default name is `default`, and `searchText` only needs `{ index }` when a
  collection has more than one.

### Update documents

```javascript
await db.collection('items').updateOne({ item: 'paper' }, { $set: { status: 'P' } })
await db.collection('items').updateMany({ qty: { $lt: 50 } }, { $set: { status: 'P' }, $inc: { qty: 5 } })
await db.collection('items').updateOne({ item: 'paper' }, { $unset: { status: '' } })
await db.collection('items').updateOne({ item: 'paper' }, { $mul: { qty: 2 }, $max: { seen: new Date() } })
await db.collection('items').updateOne({ item: 'paper' }, { $rename: { status: 'state' } })
await db.collection('items').updateOne({ item: 'paper' }, { $currentDate: { seen: true } })
await db.collection('items').updateOne({ item: 'paper' }, { $bit: { flags: { or: 0b100 } } })
```

`$currentDate` writes a real `Date` (`{ $type: 'date' }` is the long spelling;
`{ $type: 'timestamp' }` is refused, because a BSON Timestamp is not one of the
types this library can store). `$bit` applies `and`/`or`/`xor` in the order they
are written, treats a missing field as 0, and refuses a target that is not a
whole number rather than coercing it.

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

`$position` inserts mid-array instead of appending, and is applied before
`$sort`/`$slice`:

```javascript
await tasks.updateOne({ _id: id }, { $push: { tags: { $each: ['first'], $position: 0 } } })
```

`$addToSet` compares by value, not identity, so pushing an equal document twice
adds it once. Pushing onto a field that exists and is not an array is an error,
as it is on the server; onto a missing field it creates the array.

### Update elements inside an array

The three positional operators write *through* an array rather than to a whole
field:

```javascript
// $ — the element the QUERY matched
await tasks.updateOne({ tags: 'urgent' }, { $set: { 'tags.$': 'critical' } })
await db.collection('students').updateOne(
  { 'grades.score': { $lt: 50 } },
  { $set: { 'grades.$.score': 50 } }
)

// $[] — every element
await db.collection('students').updateMany({}, { $inc: { 'grades.$[].score': 5 } })

// $[<identifier>] — the elements arrayFilters names
await db.collection('students').updateMany(
  {},
  { $set: { 'grades.$[low].flagged': true } },
  { arrayFilters: [{ 'low.score': { $lt: 50 } }] }
)
```

They work with `$set`, `$unset`, `$inc`, `$mul`, `$min` and `$max`. Things worth
knowing:

- **`$` needs the query to constrain that array** — that is where the matched
  element comes from. Without a condition it is an error, and so is a query that
  matched the document but no element.
- **`$unset` through `$` leaves a `null`** in the array rather than shortening
  it, matching the server.
- Each matched document uses its *own* first match, so `updateMany` with `$` is
  well defined.
- Every `arrayFilters` entry must be used by an identifier in the update, and
  every identifier must have one — a mismatch is an error rather than a silent
  no-op. `$or`/`$nor` inside an `arrayFilters` entry is not supported (`$and`
  is, and a criterion document already means a conjunction).
- The positional operators are **not** supported in `$push`, `$addToSet`,
  `$pop`, `$pull`, `$pullAll` or `$rename`, and say so.

### Update with an aggregation pipeline

An update can be a *pipeline of stages* instead of an operator document
(MongoDB 4.2+), which is how one field is computed **from another**:

```javascript
await db.collection('orders').updateMany({ status: 'A' }, [
  { $set: { total: { $multiply: ['$price', '$qty'] } } },
  { $unset: 'draft' }
])
```

The stages are `$set`/`$addFields`, `$unset` and `$project`, with the whole
[expression language](#aggregate) available on the right-hand side. A stage
that is *illegal* in an update (`$match`, `$group`, …) is refused with the
server's own message; `$replaceRoot`/`$replaceWith` are legal there but not
implemented here, and say so. The pipeline evaluates per document through the
same code `aggregate()` runs — so the two cannot drift — and `updateMany`
still writes every result back in one statement.

Rules the oracle settled, each pinned against the server:

- An expression that evaluates to **missing** (`'$nosuchfield'`, `$$REMOVE`)
  *removes* the field, rather than leaving the old value alone.
- `_id` cannot be **altered** — but a pipeline that *removes* it (`$unset`, or
  a `$project` excluding it) gets it silently restored, with the row still
  counting as modified.
- An upsert seeds the new document from the filter's equality conditions and
  runs the pipeline over that seed.
- An **empty pipeline is refused**, exactly like an empty update document, and
  `arrayFilters` cannot be combined with a pipeline.

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
how many input documents there are.

The `let` + `pipeline` form — the correlated subquery — works too:

```javascript
await db.collection('orders').aggregate([
  { $lookup: {
    from: 'warehouses',
    let: { order_item: '$item', order_qty: '$ordered' },
    pipeline: [
      { $match: { $expr: { $and: [
        { $eq: ['$stock_item', '$$order_item'] },
        { $gte: ['$instock', '$$order_qty'] }
      ] } } },
      { $project: { stock_item: 0, _id: 0 } }
    ],
    as: 'stockdata'
  } }
]).toArray()
```

Per input document the `let` variables are evaluated and the sub-pipeline runs
as an ordinary aggregation on the foreign collection — so a `$match` head is
index-eligible there, and any supported stage (a `$group`, a nested `$lookup`)
is allowed. Identical executions are deduplicated: an *uncorrelated* pipeline
(no `let`) costs one query however many input documents, and repeated variable
values reuse their result. Combining `localField`/`foreignField` *with* a
pipeline (MongoDB 4.4+) is not implemented — spell the equality inside the
pipeline with `$match` + `$expr`.

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

Only a **duplicate key** (`11000`) surfaces as a typed `MongoServerError` with a
`.code`. Every other rejection — an unknown operator, a bad `$inc` target, a
malformed pipeline, an immutable-`_id` write — is a plain `Error` with a message
but no `.code`, where the official driver would throw a typed
`MongoServerError`/`MongoInvalidArgumentError`. So if you port code that branches
on an error class or `.code` for anything other than `11000`, adjust it to match
on the message (or `instanceof Error`) after swapping this library in.

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
| an operation inside a transaction with no `{ session }` | takes part in the transaction | MongoDB runs it *outside*, and does not roll it back — [sessions](#sessions-and-the-one-thing-they-cannot-do) |
| a positional update (`$`, `$[]`, `$[id]`) while a change stream is open | the event names the ARRAY | MongoDB names the element it hit (`'grades.1.score'`), which is unknowable before the statement runs |
| a pipeline update while a change stream is open | emits `update` with the full diff | MongoDB reports `replace` instead when the delta is not smaller than the document — an oplog size heuristic this library does not reproduce |

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

### A `MongoClient`-shaped entry point

For the test-double case, swapping one import is the whole change:

```javascript
import { MongoClient } from 'sqlite-document-db'   // was: from 'mongodb'

const client = await MongoClient.connect(process.env.MONGO_URL)
const users = client.db('app').collection('users')
await users.insertOne({ name: 'Ada' })
await client.close()
```

A `mongodb://` connection string is **accepted** and opens an in-memory
database — a suite's URL usually comes from configuration, and refusing it would
mean editing the very line the shim exists to leave alone. A file path or
`:memory:` works too. The database named in the URI path is the default for
`client.db()`, as it is for the driver, otherwise `test`.

- **In memory, each `db(name)` is its own database**, isolated as MongoDB's are.
  **A file is one database** — a SQLite file *is* a database, not a server — so
  asking a file-backed client for a second name is an error rather than a
  silent merge of two names into one set of collections.
- **Connection options are ignored** (`maxPoolSize`, `tls`, `retryWrites`, …).
  They describe a network client that is not here, and unlike an unimplemented
  operator they cannot make an answer wrong. `strict`, `busyTimeoutMs` and
  `debug` are read from the same object.
- **`startSession()` and `withSession()` work** — see below.
- **`watch()` works**, within a stated scope — see
  [Change streams](#change-streams).

The tests for this run the *same* code through both this shim and the real
driver, which is the only way a drop-in claim can be more than a claim.

### Sessions, and the one thing they cannot do

```javascript
const session = client.startSession()
await session.withTransaction(async () => {
  await accounts.updateOne({ _id: from }, { $inc: { balance: -100 } }, { session })
  await accounts.updateOne({ _id: to }, { $inc: { balance: 100 } }, { session })
})
await session.endSession()
```

That shape is why sessions exist here: it is how a great deal of MongoDB
transaction code is written, and rewriting it is the one thing the shim exists
to avoid. `startTransaction()` / `commitTransaction()` / `abortTransaction()`,
`client.withSession(work)`, `inTransaction()`, `hasEnded`, `equals()` and
`{ session }` on every operation all behave as the driver's do — including the
errors, down to *"Transaction already in progress"* and *"Use of expired
sessions is not permitted"*, each pinned against a real MongoDB.

**A session cannot route an operation, only carry one.** `{ session }` on
MongoDB means "put this in the transaction", and *omitting* it means "run this
outside, right now". A SQLite transaction belongs to the **connection**, so
there is no outside to run in — a second connection is a different database in
memory, and on a file it would block on the transaction's write lock and
deadlock a single-threaded process. One consequence, and it is the only one:

> An operation inside a transaction that is **not** given the session still
> takes part in it. MongoDB would run it outside and not roll it back.

Code that is correct against a real server is unaffected, because forgetting
`{ session }` inside a transaction is a well-known bug there and correct code
passes it to everything. `strict: true` turns the case into an error rather than
a difference. Two related refusals, both loud: a transaction covers **one**
database (it opens on the first operation naming the session, as it does on a
server), and an operation naming a *different* session while a transaction is
open is refused rather than quietly enrolled.

Session options (`causalConsistency`, `readConcern`, `writeConcern`, …) are
ignored, on the same grounds as the connection options: one connection to a
local file satisfies the first trivially, and there is no replica set for the
others to mean anything against.

### Change streams

`watch()` on a collection, a database or a client, returning an async iterable
of the same change events a server emits.

```javascript
const stream = orders.watch([{ $match: { operationType: 'insert' } }])

for await (const event of stream) {
  console.log(event.operationType, event.documentKey, event.fullDocument)
}
```

Events are emitted by the write methods themselves rather than recovered from
the engine, which is what makes the shapes exact: `insert`, `update`, `replace`,
`delete`, `drop`, `rename`, `dropDatabase` and `invalidate`, each with the `_id`
resume token, `ns`, `documentKey`, `wallTime` and — where MongoDB has one —
`updateDescription`. All of them are checked against a real replica set, so
`updateDescription` reports what a server reports, down to naming an appended
array element by index (`{ 'tags.1': 'z' }`) where a rebuilt array comes back
whole.

- **Inside a transaction, events are buffered and published on COMMIT.** A
  rollback discards them, exactly as a server does not publish uncommitted
  transaction data.
- **A [pipeline update](#update-with-an-aggregation-pipeline)'s
  `updateDescription` is a granular DIFF** of the two images — `{ 'ship.code': 2 }`
  where the operator form names `ship` whole — with shortened arrays reported in
  `truncatedArrays`, all matching the server. The one divergence: MongoDB flips
  such an event's *type* to `replace` when its delta would not be smaller than
  the document; this library always answers `update` with the full diff, and
  `strict` refuses the combination.
- **The pipeline is MongoDB's allow-list**, intersected with what this library
  implements: `$match`, `$project`, `$addFields`, `$set` and `$unset`. A
  blocking stage could never complete over a stream that does not end, which is
  why the server refuses those too.
- **`fullDocument`** defaults to MongoDB's default — an `update` event carries
  a diff and no document until you ask with `fullDocument: 'updateLookup'`.
  `fullDocumentBeforeChange` also works, and unlike on a server it needs no
  collection option, because the pre-image is already in hand.
- **An unwatched database pays nothing.** Every write path checks whether
  anything is watching before doing any of this, and the post-images the
  multi-document writes need come from `UPDATE`/`DELETE … RETURNING` — so a
  watched `updateMany` is still one statement.

**What a stream here can see, and what it says when it cannot.** Only writes
made through this library, on this connection, can be described. That is a real
limit, and the design is built so it is never a silent one:

> Anything else **ends the stream with an `invalidate`** — the event MongoDB
> already has for a stream that cannot continue, and that callers already
> handle.

Two things trigger it. Another connection committing to the same file is
detected with `PRAGMA data_version`, which SQLite bumps for everyone else's
writes and not for your own; and a `db.sql` statement that changed rows is
detected by counting them, because describing raw SQL would mean parsing it.
Both arrive as `{ operationType: 'invalidate', invalidateReason: 'foreignWrite' }`
(or `'rawSqlWrite'`), the reason being this library's own addition to the shape.

`resumeAfter` and `startAfter` are **refused**, with that reason: a resume token
points into an oplog, and the events here exist only while a stream is open.
Open the stream before the writes it must not miss. `clusterTime` is absent for
the same kind of reason — it is a BSON Timestamp describing a replication clock
that does not exist.

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
  `<field>.$date`), `Uint8Array` (as a BLOB) and objects/arrays (as their
  storage JSON, ready for `json(?)`) are all bindable; anything else throws.
  Documents hold bytes too (inline, as base64 — see
  [Supported value types](#supported-value-types)), but a real BLOB is smaller
  and faster: binding a `Uint8Array` here — into a `BLOB` table of your own, on
  this same connection and inside `withTransaction` — is how large files sit
  next to the documents that reference them.
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
npm run stress   # every feature over deliberately hostile documents
npm run lint
npm run build
```

Both `bench` and `stress` run against a real **file**, not `:memory:` — fsync is
where the performance problems have been, and a file is what people run. The
stress suite is the one that goes looking for *limits* rather than for slowness:
documents 180 levels deep, 500 fields wide, three array levels, 5,000-element
arrays, unicode traps, through every operator. It asserts ceilings ("this
completed", "the compiled SQL stayed under N bytes") rather than timings, and it
paid for itself on its first run by finding a quadratic `$slice`.

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
`$bitsAnyClear` `$comment` `$sampleRate`.

Update operators: `$set` `$unset` `$inc` `$mul` `$min` `$max` `$rename`
`$setOnInsert` `$currentDate` `$bit` `$push` (with `$each`, `$slice`, `$sort`,
`$position`) `$addToSet` (with `$each`) `$pop` `$pull` `$pullAll`, the positional
operators `$` / `$[]` / `$[<identifier>]` (with `arrayFilters`), plus the
`upsert` option on `updateOne`/`updateMany`/`replaceOne`. An update can also be
an [aggregation pipeline](#update-with-an-aggregation-pipeline) of `$set` /
`$addFields` / `$unset` / `$project` stages.

Accumulators: `$sum` `$avg` `$min` `$max` `$first` `$last` `$push` `$addToSet`
`$count` `$stdDevPop` `$stdDevSamp` `$mergeObjects` `$firstN` `$lastN` `$maxN`
`$minN` `$top` `$topN` `$bottom` `$bottomN`.

Aggregation stages: `$match` `$sort` `$limit` `$skip` `$count` `$group`
`$project` `$addFields`/`$set` `$unset` `$sortByCount` `$unwind` `$lookup`
(both the `localField`/`foreignField` form and `let` + `pipeline`, though not
the two combined).

Expression operators, for `$project`, `$addFields`, `$group._id` and
accumulator arguments:

| Family | Operators |
| --- | --- |
| Arithmetic | `$add` `$subtract` `$multiply` `$divide` `$mod` `$abs` `$ceil` `$floor` `$round` `$trunc` `$pow` `$sqrt` `$exp` `$ln` `$log` `$log10` |
| Trigonometry | `$sin` `$cos` `$tan` `$asin` `$acos` `$atan` `$atan2` `$sinh` `$cosh` `$tanh` `$asinh` `$acosh` `$atanh` `$degreesToRadians` `$radiansToDegrees` |
| Comparison | `$cmp` `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` |
| Boolean | `$and` `$or` `$not` |
| Conditional | `$cond` `$ifNull` `$switch` |
| String | `$concat` `$toLower` `$toUpper` `$split` `$strLenCP` `$strLenBytes` `$substrCP` `$substrBytes` `$substr` `$indexOfCP` `$indexOfBytes` `$trim` `$ltrim` `$rtrim` `$replaceOne` `$replaceAll` `$strcasecmp` |
| Regex | `$regexMatch` `$regexFind` `$regexFindAll` |
| Array | `$size` `$isArray` `$arrayElemAt` `$first` `$last` `$slice` `$concatArrays` `$in` `$reverseArray` `$range` `$map` `$filter` `$reduce` `$indexOfArray` `$sortArray` `$zip` `$firstN` `$lastN` `$maxN` `$minN` `$sum` `$avg` `$min` `$max` |
| Set | `$setUnion` `$setIntersection` `$setDifference` `$setEquals` `$setIsSubset` `$allElementsTrue` `$anyElementTrue` |
| Object | `$mergeObjects` `$objectToArray` `$arrayToObject` `$getField` `$setField` `$unsetField` |
| Date | `$year` `$month` `$dayOfMonth` `$hour` `$minute` `$second` `$millisecond` `$dayOfWeek` `$dayOfYear` `$dateToString` |
| Type | `$type` `$isNumber` `$toString` `$toBool` `$toInt` `$toDouble` `$toDate` `$convert` `$binarySize` |
| Vector | `$similarityCosine` `$similarityDotProduct` `$similarityEuclidean` |
| Other | `$literal` `$let` `$rand`, and the variables `$$ROOT` `$$CURRENT` `$$REMOVE` |

Dates are handled in **UTC**: a `timezone` option throws rather than being
ignored, because answering a timezone question in UTC is a wrong answer that
looks right.

The three `$similarity*` operators make brute-force k-nearest-neighbour search
expressible with no extension and no dependency — `$addFields` the score,
`$sort`, `$limit`. Every document is scored, so it is for modest collections;
`$vectorSearch` is Atlas-only and is not implemented.

`$convert` produces only the types this library can store (`double`, `int`,
`long`, `bool`, `string`, `date`); `decimal` and `objectId` are valid MongoDB
type names that raise here — or answer with `onError` — rather than quietly
producing something else.

Methods: `find()` `findOne()` `countDocuments()` `estimatedDocumentCount()`
`distinct()` `aggregate()` `insertOne()` `insertMany()` `updateOne()`
`updateMany()` `deleteOne()` `deleteMany()` `replaceOne()` `bulkWrite()`
`findOneAndUpdate()` `findOneAndReplace()` `findOneAndDelete()` `createIndex()`
`createIndexes()` `dropIndex()` `dropIndexes()` `indexes()` `listIndexes()`
`indexExists()` `rename()` `drop()` [`watch()`](#change-streams), each taking
`{ session }`; on cursors,
`next()` `tryNext()` `hasNext()` `toArray()` `forEach()` `map()` `rewind()`
`count()` `close()` `explain()` and the chainable `sort()` `limit()` `skip()`
`project()`; on `Db`, `withTransaction()` `listCollections()`
`createCollection()` `renameCollection()` `dropDatabase()` `stats()` `watch()`
`databaseName`, and [`sql`](#raw-sql) / `table()` for SQL this library does not
compile; plus a [`MongoClient` shim](#a-mongoclient-shaped-entry-point) with
[`startSession()`](#sessions-and-the-one-thing-they-cannot-do), `withSession()`
and `watch()`.

`db.stats()`'s COUNTS (`collections`, `objects`, `dataSize`) mean what they do
on MongoDB; the byte figures under them describe a SQLite file —
`storageSize` is `page_count * page_size`, free list and indexes included — and
are not comparable with a server's. `db.command()` is not implemented and will
not be: it is the whole wire protocol behind one method.

Result objects match the official driver's shapes (`acknowledged`,
`matchedCount`, `modifiedCount`, `upsertedId`, ...), and errors match its codes
(`11000` for a duplicate key).

### Supported value types

Supported: object, array, string, number, boolean, null — and two more, each
stored in MongoDB's [Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/)
format:

- **`Date`**, stored as `{"$date": "..."}`. Round-trips as a real `Date`, and
  works in equality and range queries:

  ```javascript
  await db.collection('events').insertOne({ name: 'launch', at: new Date('2020-06-15') })
  await db.collection('events').find({ at: { $gte: new Date('2020-01-01') } }).toArray()
  ```

- **`Uint8Array`** (and `Buffer`, its subclass), stored as
  `{"$binary": {"base64": "...", "subType": "00"}}` and revived as a plain
  `Uint8Array`. Equality, `$in`/`$nin`, implicit array-element matching,
  `$type: 'binData'`, `$binarySize` and update operators all work:

  ```javascript
  await db.collection('files').insertOne({ name: 'logo.png', bytes: new Uint8Array([137, 80, 78, 71]) })
  await db.collection('files').findOne({ bytes: new Uint8Array([137, 80, 78, 71]) })
  ```

  Two deliberate edges: **range operators (`$gt`/`$lt`/…) refuse binary
  values** — MongoDB orders binary by length, then bytes, which SQL over the
  stored base64 cannot reproduce — and **sorting by a field that holds binary
  orders by the stored text**, a documented divergence that
  [strict mode](#strict-mode) rejects, exactly like sorting arrays. Bytes are
  stored inline as base64 (+33% on disk); for files of any size, use
  [GridFS-style chunking or a raw BLOB table](#raw-sql) — see BACKLOG item 35.

Anything else JSON cannot represent (`RegExp`, other typed arrays/`DataView`,
`Map`, `Set`, `bigint`, functions, `NaN`/`Infinity`) is **rejected at write
time** with an error naming the offending path, rather than silently corrupted
the way `JSON.stringify` would. (`RegExp` still works fine as a *query* value
via `$regex` — it just cannot be stored in documents.) Design notes in
[DR-1 in the backlog](BACKLOG.md#dr-1-document-storage-format).

Two field shapes are reserved by that format: an object that is exactly
`{ "$date": "<string>" }` (or exactly the `$binary` wrapper) is
indistinguishable from a stored `Date` (or byte array), so it is rejected on
write too. Objects that merely *contain* a `$date` or `$binary` key
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

- The geospatial family (`$geoWithin`, `$near`, `$geoIntersects`, …) — the
  largest single block of the query language not implemented here. SQLite's
  R-Tree and geopoly modules make it feasible; MongoDB's operators are
  *spherical* and those are planar, which is what makes it real work.
- `$text` and `$search`. `$text` needs a stemming full-text index, and SQLite's
  FTS5 stemmer does not agree with MongoDB's — the same query would return
  different documents on the two, which is the one thing this library will not
  do quietly. `$search` is Atlas-only, so it cannot be checked against a real
  server even in principle. Both stay refused, and the error names the
  alternative: [full-text search under this library's own
  name](#full-text-search) (`createSearchIndex`/`searchText`), where the
  tokenizer is your choice — or `$regex` for substring matching.
- `$where` will **not** be supported (it executes arbitrary JavaScript). `$expr`
  covers the same comparisons without running code.

**Updating**

- Updates expressed as an aggregation pipeline
  (`updateOne(filter, [{ $set: … }])`).

**Collection / Db API**

- Document validation (`$jsonSchema`), views, capped collections
- TTL indexes (`expireAfterSeconds`) and `hidden` — both rejected rather than
  ignored; there is no background reaper here, and SQLite has no way to keep an
  index from its own planner. `partialFilterExpression` exists but is narrower
  than MongoDB's (see [Indexes](#indexes))

**Aggregation** — the pipeline is a common-shapes subset, not the whole thing:

- Stages: `$facet`, `$bucket`, `$replaceRoot`/`$replaceWith`, `$out`, `$merge`,
  `$sample`, `$graphLookup`, `$unionWith`, `$documents`, `$setWindowFields`; and
  `$lookup` combining `localField`/`foreignField` *with* a pipeline (the plain
  `let`+`pipeline` form works — see [Aggregate](#aggregate))
- Expression operators outside the table above: `$dateFromString` and the rest
  of the date arithmetic (`$dateAdd`, `$dateDiff`, `$dateTrunc`,
  `$dateFromParts`, …), timezone support on the date operators, and `$meta`
  (which needs `$text`). `$function` and `$accumulator` will **not** be
  supported, for the same reason as `$where`
- `$group` accumulators beyond those listed above — `$median` and `$percentile`,
  whose interpolation rule has to be taken from the server rather than guessed

**Change streams see one process.** [`watch()`](#change-streams) is implemented
and its event shapes are verified against a real replica set, but the events
come from this library's own write path, so a write from another connection —
or through `db.sql` — cannot be described. Neither is passed over: both end the
stream with an `invalidate`. `resumeAfter` is refused rather than approximated,
because there is no oplog for a token to point into. BACKLOG.md items 26 and 27
have the measurements behind both halves.

**Not planned**

- Replication, sharding, `$where`, server-side JavaScript, the wire
  protocol, `db.command()`. A process that needs those needs a server.
  (Multi-document atomicity within one connection *is* supported — see
  [Transactions](#transactions) and
  [Sessions](#sessions-and-the-one-thing-they-cannot-do).)

**GridFS** — not implemented yet, but no longer blocked: document fields hold
bytes now (see [Supported value types](#supported-value-types)), and
[`db.sql`](#raw-sql) reaches SQLite's real BLOB type for files that should not
live inline. GridFS itself needs nothing from a server — it is a convention
over two ordinary collections — and the problem it solves is not one this
library has: there is **no 16MB document cap** here (see
[Document limits](#document-limits) above), so its value would be compatibility
for code already written against `GridFSBucket`. BACKLOG.md item 35 has the
measurements and the build order.

## Thanks

Thanks to <https://github.com/thomas4019/mongo-query-to-postgres-jsonb> for being a huge inspiration for this project.
