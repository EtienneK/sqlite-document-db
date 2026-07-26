# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`$position` inside `$push`**, which inserts at an index instead of
  appending (negative counts from the end), applied before `$sort`/`$slice`.
- **The positional update operators** `$`, `$[]` and `$[<identifier>]`, with the
  `arrayFilters` option — the way to change one element of an array without
  rewriting the whole field. Supported in `$set`, `$unset`, `$inc`, `$mul`,
  `$min` and `$max`; rejected by name elsewhere. `$` takes its element from the
  query, and fails when the query constrains no array or matched no element,
  as the server does.
- **The projection `$`-operators**: `$slice` (a window over an array, in either
  the `n` or the `[skip, limit]` form), `$elemMatch` (the first element matching
  a criterion) and `$` positional (the element that matched the query). Which
  element matched is decided by the query engine, as an extra column of the
  query already being run, so `find()` pays no extra statement for it.
  `$slice` decides nothing about inclusion or exclusion, matching the server.
- **`$expr`**, which puts an aggregation expression in a filter — the way to
  compare two fields of the same document
  (`{ $expr: { $gt: ['$spent', '$budget'] } }`). It works anywhere a filter
  does and composes with `$and`/`$or` and ordinary criteria. It cannot use an
  index, and a document the expression cannot evaluate does not match (where a
  real server fails the query) — both documented in the README.
- **The bitwise query operators** `$bitsAllSet`, `$bitsAnySet`, `$bitsAllClear`
  and `$bitsAnyClear`, taking either a bitmask or an array of bit positions.
  Masks are exact to 64 bits, past what a JavaScript number holds.
- **A reason instead of "unknown operator" for `$text` and `$where`.** Both are
  decisions rather than gaps, and the error now says why and what to use
  instead — `$regex` or a caller-owned FTS5 table via `db.sql` for `$text`,
  `$expr` for `$where`.
- **The aggregation expression operators.** Arithmetic (`$add`, `$multiply`,
  `$round`, …), comparison, boolean, conditional (`$cond`, `$ifNull`,
  `$switch`), string (`$concat`, `$toUpper`, `$split`, `$trim`, `$replaceAll`,
  …), array (`$size`, `$slice`, `$map`, `$filter`, `$reduce`, …), date
  (`$year`, `$dateToString`, …) and type conversion (`$toString`, `$toInt`,
  `$toDate`, `$type`), plus `$let` and the variables `$$ROOT`, `$$CURRENT` and
  `$$REMOVE`. Previously an expression could only be a field path, a literal or
  `$literal`, which was the pipeline's ceiling. Two rules are copied from the
  server rather than invented: a **missing** value gives null while a **wrong
  type** throws, and `$round` breaks ties to the even neighbour. Dates are
  handled in UTC — a `timezone` option throws rather than being ignored.
- **A raw SQL escape hatch.** `db.sql.all`, `db.sql.get` and `db.sql.run` are
  tagged templates on the same connection, for the SQL this library does not
  compile — a recursive CTE, a window function, a join, a `PRAGMA`. Every `${}`
  is a bound parameter, so a value can never become SQL; `db.table(name)` gives
  the quoted physical table name, which cannot be bound and is not guessable.
  Rows come back raw, and the exported `parseDocument`/`stringifyDocument` are
  the codec for the `data` column. Refuses more than one statement per call,
  because `node:sqlite` compiles the first and silently ignores the rest.

- **The array update operators.** `$push` (with `$each`, `$slice` and `$sort`),
  `$addToSet` (with `$each`), `$pop`, `$pull` and `$pullAll`. Previously the
  only way to change one element of an array was to read the document, edit it
  in JavaScript and `replaceOne` it back — which is not atomic. `$push` with
  `$each`+`$sort`+`$slice` gives the capped top-N list in one statement.
- **The remaining field update operators:** `$mul`, `$min`, `$max` and
  `$rename`. `$min`/`$max` compare in MongoDB's BSON type order, so a Date
  compares chronologically and a number ranks below any string.
- **An aggregation pipeline** — `aggregate()`, with `$match`, `$sort`, `$limit`,
  `$skip`, `$count`, `$group`, `$project`, `$addFields`/`$set` and `$unwind`,
  and the accumulators `$sum`, `$avg`, `$min`, `$max`, `$first`, `$last`,
  `$push`, `$addToSet` and `$count`. A LEADING run of
  `$match`/`$sort`/`$skip`/`$limit` compiles to the same SQL `find()` emits and
  uses the same indexes; the rest runs in JavaScript, and `cursor.explain()`
  reports where the boundary fell. Expressions are field paths, literals and
  `$literal` only — the arithmetic and conditional families are not implemented,
  and an unrecognised one is an error.
- **`strict: true`** on `Db.fromUrl`, which rejects the constructs whose answer
  is known to differ from MongoDB's instead of quietly returning the different
  answer: over-deep dotted array paths, `$type` naming an unstorable BSON type,
  sorting a field that holds an array, and an aggregation path that runs
  through an array. Intended for suites that test against this library rather
  than a real `mongod`.
- **`distinct()`**, which follows the implicit-array rule (an array field
  contributes its elements) and returns values in BSON type order.
- **`drop()`**, which removes the collection with its indexes and evicts the
  cached `Collection` so the name is usable again immediately.
- **A clear error when a document nests too deeply.** Documents may nest 200
  levels; past that the storage encoder throws an error naming the offending
  path, rather than letting SQLite report a bare "malformed JSON". The cap sits
  above MongoDB's own (~180) and below the JavaScript call stack the encoder
  needs, which is what makes it reachable on every supported platform.
- **`db.withTransaction(work)`** — commits when the callback returns, rolls back
  when it throws, nests via SAVEPOINT. A callback rather than MongoDB's session
  object, because `node:sqlite` is synchronous and there is no concurrency for a
  session to coordinate.
- **`$lookup`** (the `localField`/`foreignField` form) — a left outer join that
  is array-aware on both sides and fetches the foreign side in ONE query
  regardless of input size.
- **`bulkWrite()`**, ordered and unordered, over `insertOne`/`updateOne`/
  `updateMany`/`replaceOne`/`deleteOne`/`deleteMany`, with the driver's result
  shape. **`insertMany({ ordered: false })`** too.
- **`estimatedDocumentCount()`**, `countDocuments()` with `limit`/`skip`,
  **`db.listCollections()`** and **`db.dropDatabase()`**.
- Types for all of the above: the array operators are restricted to array paths
  and their element type, `$mul` to numeric paths, and `aggregate<TResult>()`
  threads the result shape through.

### Fixed

- **The same `$sort` could order strings two different ways.** Sorting that ran
  in SQLite (`find().sort()`, a `$sort` at the head of a pipeline) compared
  strings by UTF-8 byte, matching MongoDB. Sorting that ran in JavaScript (a
  `$sort` after a `$group`, `distinct()`'s ordering, `$min`/`$max`) compared
  UTF-16 code units, which disagrees for every character outside the Basic
  Multilingual Plane — so `🚀` sorted before `�` in one place and after it
  in the other. JavaScript-side comparison is by code point now.
- **`insertMany` was one implicit transaction per document.** With
  `journal_mode=WAL` and SQLite's default `synchronous=FULL` that is an fsync
  per document, which made inserting a large batch into a file-backed database
  take minutes: 4000 documents took **25.9 seconds** (155/s). The batch now runs
  in a single transaction, and the same insert takes **122ms** (32,800/s) — a
  212× improvement. **The observable contract is unchanged**: MongoDB's
  *ordered* insert is not atomic, so a failure part-way through commits the
  documents that succeeded rather than rolling them back — everything before the
  failure stays written, nothing after it is attempted.
- **A failed `insertMany` now reports how far it got**, as `insertedCount` and
  `insertedIds` on the thrown error (and as `error.result`, which is where the
  driver puts them). Previously a caller who caught the error could not tell
  whether none or nearly all of the batch had landed without re-querying.
- `distinct` and `drop` were listed as missing in the README; they now exist.
- Two backlog entries claimed work that was already done (the "Project Fields to
  Return" tutorial spec, and benchmarks in CI).

### Changed

- The update-document compiler moved out of `src/index.ts` into `src/update.ts`,
  and BSON comparison order is now shared between SQL and JavaScript through
  `src/bson-order.ts`.
- The README leads with what this is — an embedded document database with a
  familiar query language — rather than with how close it gets to MongoDB.

## [2.0.1] — 2026-07-25

### Fixed

- **A dotted path into an array of embedded documents matched nothing.**
  `{ 'instock.qty': 5 }` returned no documents where `instock` is an array,
  though MongoDB descends into arrays at every level of a path. `$elemMatch`
  and an explicit index (`'instock.0.qty'`) were the only forms that worked.
  Paths may now cross up to two array levels.
- **Nested `$elemMatch` matched nothing.** Every level named its computed
  column the same thing, so an inner `$elemMatch` shadowed its parent — 
  `{ a: { $elemMatch: { b: { $elemMatch: { c: 9 } } } } }` was always empty.

Both were silent: they returned an empty result rather than an error. A dotted
query over an indexed field still uses its index for documents where the path
holds no array, but the array case necessarily scans — see
[the backlog](BACKLOG.md#review-2026-07-25) for the companion-index follow-up.

## [2.0.0] — 2026-07-25

A rewrite of the storage and query layers on top of Node's built-in
`node:sqlite`. **Every dependency is gone**, including the native ones — there is
nothing to compile and no binaries to install.

### Breaking changes

- **ESM only.** The package no longer ships a CommonJS build; `require()` will
  not work. Entry points are resolved through an `exports` map, so deep imports
  such as `sqlite-document-db/dist/src/index.js` no longer resolve either.
- **Node.js 22.13 or newer is required.** `node:sqlite` provides the database,
  `DatabaseSync.prototype.function` backs `$regex`, and
  `StatementSync.prototype.iterate` backs the cursor.
- **The `sqlite`, `sqlite3` and `bson-objectid` dependencies were dropped.** If
  you installed this package for its `sqlite3` transitive dependency, you now
  need to depend on it directly.
- **Collection names are case-sensitive**, as MongoDB's are. They used to be
  lowercased, which silently merged `Users` and `users` into one collection.
  Names are now validated only against MongoDB's own rules (non-empty, no `$`,
  no NUL byte, not `system.`/`sqlite_`-prefixed), so previously rejected names
  like `my-data` are accepted.
- **Write results match the official driver's shapes.** They previously carried
  only a count — `{ deletedCount }`, `{ modifiedCount }`. They now include
  `acknowledged`, and update results additionally carry `matchedCount`,
  `upsertedCount` and `upsertedId`.
- **A duplicate `_id` throws a `MongoServerError` with `code: 11000`** instead
  of a raw SQLite `SQLITE_CONSTRAINT_UNIQUE` error.
- **Values JSON cannot represent are rejected at write time** rather than
  silently corrupted. `RegExp` used to be stored as `{}`, a `Uint8Array` as
  `{"0":1,"1":2}`, and `NaN` as `null`. Storing one now throws an error naming
  the offending path.

### Storage format

`Date` values are stored in MongoDB's Extended JSON form, `{"$date": "<ISO>"}`,
and revived as real `Date` objects on read. In 1.x they degraded to strings and
could not be queried as dates.

This changes the on-disk representation. A database file written by 1.x still
opens, but any date it holds is a plain string and will not match a `Date` query
value. There is no automatic migration; re-writing the affected documents is the
upgrade path.

One field shape is reserved as a consequence: an object that is exactly
`{ "$date": "<string>" }` is indistinguishable from a stored `Date` and is
rejected on write. Objects that merely *contain* a `$date` key are unaffected.

### Added

- **Indexes** — `createIndex()`, `dropIndex()`, `indexes()`, `listIndexes()`,
  backed by real SQLite expression indexes, with MongoDB-style index names.
  Single-field indexes get a companion index covering wrapped `Date` values.
  Measured on 20k documents: equality lookups ~68× faster than a full scan,
  date ranges ~51×, `countDocuments` ~16×.
- **Update operators** — `updateOne()`, `updateMany()` with `$set`, `$unset`,
  `$inc` and `$setOnInsert`, composed into a single statement.
- **Upsert** — the `upsert` option on `updateOne()`, `updateMany()` and
  `replaceOne()`, seeding the new document from the filter's equality
  conditions the way MongoDB does.
- **Find and modify** — `findOneAndUpdate()`, `findOneAndReplace()`,
  `findOneAndDelete()`, with `returnDocument`, `sort`, `projection` and `upsert`.
- **Cursor `sort()`, `limit()` and `skip()`**, chainable or as `find()` options.
  Sorting follows MongoDB's BSON type comparison order rather than SQLite's.
- **Projection** — `find(filter, { projection })` and the chainable
  `cursor.project()`, including exclusions, dotted paths and projecting into
  arrays of embedded documents.
- **Query operators** — `$regex` (with `$options`), `$type`, `$mod`, and
  implicit array-element matching, so `{ tags: 'B' }` matches a document whose
  `tags` array contains `'B'`, as MongoDB does.
- **Typed filters** — `db.collection<T>()` types filters, update documents and
  results against a schema, including dot-notation paths. Misspelled fields and
  wrong operator value types no longer compile. Collections opened without a
  schema stay fully permissive.
- **Cursors stream.** `find()` prepares one statement and iterates it, rather
  than re-preparing a `LIMIT 1` query per document. `cursor.close()` was added.
- **`busyTimeoutMs`** option on `Db.fromUrl()`, for file-backed databases under
  concurrent access.

### Fixed

- `$elemMatch` compared each array element against the whole criterion object
  rather than field by field.
- `$exists` counted `json_each` rows, so an empty array or empty object reported
  as *not existing*.
- `$size: 0` matched every non-array and every missing field.
- `$all` failed the entire query with SQLite's "malformed JSON" as soon as any
  document held a scalar at the queried path.
- A misspelled operator (`{ qty: { $gtt: 5 } }`) was treated as an equality
  match against the criterion object and silently returned nothing. Unknown
  operators are now rejected.
- A top-level `{ $not: ... }` recursed until the stack overflowed.
- `{ $or: [] }` and `{ $elemMatch: {} }` produced SQL syntax errors.
- `{ $set: { '': 1 } }` replaced the entire document — the empty path resolved
  to the JSON document root.
- `$unset` and `$inc` were not checked against `_id`, so an update could leave a
  document with no identifier.
- `$inc` on a non-numeric field overwrote it with a number, because SQLite
  evaluates `'hello' + 1` as `1`.
- `deleteOne()` could delete two documents when `_id` was an array. Array `_id`
  values are now rejected on insert, as MongoDB rejects them.
- A projection path of `__proto__` polluted `Object.prototype`, and a document
  field named after an `Object.prototype` member was mis-projected.
- A document field named `__proto__` was silently dropped on write.
- Query values are bound as SQL parameters throughout rather than interpolated.

### Security

- Prototype pollution via a projection specification (`{ '__proto__.x': 1 }`),
  which in a web application can arrive directly from a query string.
- The `$regex` pattern cache was unbounded, which could grow without limit when
  patterns are built from user input.

[2.0.1]: https://github.com/EtienneK/sqlite-document-db/releases/tag/v2.0.1
[2.0.0]: https://github.com/EtienneK/sqlite-document-db/releases/tag/v2.0.0
