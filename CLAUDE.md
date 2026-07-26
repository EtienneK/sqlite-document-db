# sqlite-document-db

A MongoDB-style document database implemented on top of SQLite's JSON functions.
Zero runtime dependencies; ESM only; requires Node >= 22.13 for `node:sqlite`
plus `DatabaseSync.prototype.function` (which backs `$regex`).

Planned work is in [BACKLOG.md](BACKLOG.md) — check it before starting a feature, it
records prior investigation (query plans, feasibility, sequencing) for most items.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Full suite (vitest), ~4s. Boots one real MongoDB for the run. |
| `npm run test:watch` | Watch mode |
| `npm run lint` | oxlint |
| `npm run typecheck` | `tsc` over `src` **and** `test` |
| `npm run build` | Emits `dist/` from `src` only (`tsconfig.build.json`) |
| `npm run test:types` | Type-level assertions (`vitest --typecheck`), own config |
| `npm run examples` | Builds, then runs every example in `examples/` |
| `npm run bench` | Benchmarks over 20k docs; no mongod, own vitest config |

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint, typecheck,
test:types, build and test on {ubuntu, windows} × Node {22.13.0, 24, 26}.
A separate job runs [examples/](examples/) under **Deno**, which is the only
thing in the repo that exercises a non-Node runtime — the test suite is
vitest-bound. Deno implements `node:sqlite` including the custom-function
support `$regex` needs, so the library works there unchanged.
Releases go through [.github/workflows/publish.yml](.github/workflows/publish.yml),
which **reuses** that workflow via `workflow_call` rather than copying the
matrix, then packs the tarball and smoke-tests it from a clean project before
publishing. `npm version <x> && git push --follow-tags` is the whole release. The Node axis matters more than it
looks: `node:sqlite` bundles its own SQLite, so the query planner — and therefore
[test/query-plan.spec.ts](test/query-plan.spec.ts) — differs per Node version.

## Architecture

The tree is FLAT on purpose: one file per concern, no single-file directories.
(`src/query/query.ts` used to be the exception — a directory holding one
stuttering file — and it is now `src/query.ts`.)

**The dependency rule:** `types.ts` is the shared type surface and imports
nothing that has runtime behaviour; every other module may import it. Nothing
imports `index.ts`. That rule exists because `aggregate.ts`, `update.ts` and
`filter-types.ts` all used to import types back OUT of the entry point, which
made the entry point double as the shared-types module. It was type-only, so it
was erased at runtime and never broke anything — it just made the graph
circular and the layout hard to follow. **If you need a type in two modules, it
belongs in types.ts.**

- [src/index.ts](src/index.ts) — the public entry point: `Db`, and every export.
- [src/collection.ts](src/collection.ts) — `Collection`: CRUD, queries, indexes,
  `aggregate()`. Where compiled SQL gets run.
- [src/types.ts](src/types.ts) — the shared public types (`Document`, result
  shapes, cursor interfaces, `DbOptions`). No runtime code.
- [src/query.ts](src/query.ts) — **the heart of the project.** Compiles
  MongoDB filter objects into SQLite `WHERE` clauses.
- [src/update.ts](src/update.ts) — compiles update documents (`$set`, `$inc`,
  `$push`, `$pull`, …) into ONE SQL expression for the new `data` value.
- [src/aggregate.ts](src/aggregate.ts) — the aggregation pipeline, and the
  decision about which stages run in SQL and which in JS.
- [src/expression.ts](src/expression.ts) — the aggregation EXPRESSION language
  (`$add`, `$cond`, `$dateToString`, `$map`, …). Split out from aggregate.ts
  because it is a language with its own rules, and because `$expr` needs the
  same vocabulary from the query side.
- [src/bson-order.ts](src/bson-order.ts) — MongoDB's BSON comparison order in JS;
  the twin of `bsonRankSql`/`bsonValueSql` in query.ts, which it must agree with.
  **Strings compare by code POINT there, not with JavaScript's `<`.** SQLite's
  BINARY collation and MongoDB's default collation both compare UTF-8 bytes,
  which is code-point order; JS compares UTF-16 code units, and the two disagree
  for every astral character (a high surrogate sorts below U+E000..U+FFFF, the
  code point it begins sorts above). Reverting `compareStrings` to `x < y` makes
  a `$sort` after a `$group` order `🚀` and `�` differently from the same
  `$sort` at the head of a pipeline. Pinned by
  [test/unicode.spec.ts](test/unicode.spec.ts).
- [src/ejson.ts](src/ejson.ts) — storage serialization (see the EJSON gotcha below).
- [src/projection.ts](src/projection.ts) — MongoDB projection semantics, applied in JS.
- [src/errors.ts](src/errors.ts) — `MongoServerError` / `DUPLICATE_KEY_ERROR` (11000).
- [src/filter-types.ts](src/filter-types.ts) — `Filter<TSchema>` / `UpdateFilter<TSchema>`
  and the dot-notation path algebra behind them. Types only; no runtime code.
- [src/object-id.ts](src/object-id.ts) — generates MongoDB-compatible ObjectId hex strings.
- [src/raw-sql.ts](src/raw-sql.ts) — the `db.sql` escape hatch (see below).

### Storage model

Each collection is a table with a single `data JSON` column — one document per
row. A unique index on `json_extract(data, '$._id')` enforces `_id` uniqueness.

Collection names are **case-sensitive** and validated only against MongoDB's own
rules. Every identifier is quoted via the exported `quoteIdentifier()`. The
physical table name comes from `tableNameFor()`: a `/^[a-z0-9_]+$/` name maps to
the readable `collection_<name>`, everything else to
`collectionx_<slug>_<sha256-16>`. **That digest is load-bearing** — SQLite
compares identifiers case-insensitively, so `"collection_Users"` and
`"collection_users"` are one table, and quoting alone would have kept the
data-merging bug it was meant to fix.

User indexes (`createIndex`) are SQLite expression indexes named
`ix_<table>_<mongoName>`; single-field indexes get a `ixd_` companion on
`<field>.$date` so date-range queries (which target that sub-path) are served too.
`indexes()` reconstructs the key spec by parsing the CREATE INDEX SQL out of
`sqlite_master` — there is no metadata table for INDEXES (there is one for
collection NAMES; see below). The plan-regression tests in
[test/query-plan.spec.ts](test/query-plan.spec.ts) replay captured SQL and fail if
`find()`'s statements ever stop using these indexes.

### How query compilation works

`toSql('data', filter)` recurses through the filter object and emits a SQL
predicate. The two functions to understand:

- `convert(columnName, query)` — dispatches on the *shape* of the object. It
  distinguishes `{ field: value }`, `{ field: { $op: value } }`,
  `{ field: { $op1: v, $op2: v } }`, and `{ $logicalOp: [...] }`.
- `convertOp(columnName, field, op, value)` — emits SQL for one operator.

Field paths use dot notation and are translated to JSON1 paths, with a regex
turning `.0` into `[0]` so array indexing (`{ 'dim_cm.1': { $gt: 25 } }`) works.

**Non-obvious detail — `$elemMatch`.** Array elements are re-wrapped as
`json_object('f', json(value))` so the ordinary field-path machinery can address
them. This means an operator key (`$gte`) targets `f` itself, whereas any other
key is a path *inside* the element and must target `f.<key>`. Getting this
distinction wrong was the long-standing bug fixed in the 2026 modernization —
it made `$elemMatch` compare each element against the whole criterion object.

**Non-obvious detail — `IS NOT NULL` padding.** The comparison operators append
`AND <field> IS NOT NULL` (see `convertOp`). This exists so `$not` behaves like
MongoDB for missing/null fields; removing it breaks the `$not` tests.

**Non-obvious detail — implicit array matching.** `{ tags: 'B' }` also matches
arrays containing `'B'` (MongoDB semantics). Top-level comparisons compile to
`rowid IN (scalar-arm UNION ALL element-arm)` — NOT a flat OR, which SQLite can
never index (OR-optimization skips expression indexes entirely). The element arm's
leading `extract >= '[' AND < '\'` range selects array rows through the same
expression index (JSON arrays extract as text starting with `[`). Range operators
carry `json_type` bracketing so number queries don't match text/arrays. `find()`
and `findOne()` have `ORDER BY rowid` for natural order — safe ONLY because
predicates are rowid-subquery-shaped; a bare scalar predicate plus ORDER BY rowid
would make SQLite drop the field index (measured — don't "simplify" this).

**Non-obvious detail — `$all` delegates.** `$all` is defined as an `$and` of its
values, so it compiles to exactly that rather than to its own `json_each` form.
That is not a stylistic choice: feeding `json_each` an *extracted* value fails
with "malformed JSON" the moment any row holds a bare string at that path, and
delegating also inherits implicit array matching, Dates and index eligibility.

**Non-obvious detail — operators are validated, not guessed.** An unrecognised
`$`-key is an error, in both filter-document position (`{ $not: ... }` — which
used to recurse forever) and criterion position (`{ qty: { $gtt: 5 } }` — which
used to become an equality match against that object and return nothing). If you
add an operator, add it to `OPS`, and add it to `TOP_LEVEL_OPS_KEYS` only if
MongoDB accepts it as a filter-document key. `REFUSED_TOP_LEVEL_OPS` is for the
ones that are DECISIONS rather than gaps (`$text`, `$where`): they answer with
the reason and the alternative instead of "unknown top level operator".

**Non-obvious detail — `$expr` runs in JavaScript, through a SQL function.**
It compiles to `mdb_expr(<expression json>, data)`, registered in index.ts
exactly like `$regex`'s `mdb_regexp`. The alternative — compiling
[src/expression.ts](src/expression.ts) to SQL — would be a SECOND
implementation of every rule in that file (missing vs null, type errors,
half-to-even rounding) and would drift from the first. Consequences: `$expr`
cannot use an index, and it needs a driver with `supportsFunctions`.

**Non-obvious detail — an evaluation error inside `$expr` is caught and means
"no match".** MongoDB fails the whole query instead. This is not a preference:
an exception thrown from a `db.function()` callback is SWALLOWED on the Node
22.13 floor and propagates on Node 26 (the same trap the update guards hit), so
letting it out would make one query behave two ways on two supported runtimes.
What CAN be checked everywhere is the STRUCTURE, so
`assertKnownExpressionOperators` validates operator names at compile time —
that is what makes the common typo an error. Do not "improve" this by throwing
from the callback.

**Non-obvious detail — a `$bits*` mask is bound as a decimal STRING** and
`CAST(… AS INTEGER)` on the way in. Bit 62 is already past
`Number.MAX_SAFE_INTEGER`, so a JS number would silently lose precision; SQLite
parses the text into an exact 64-bit integer. `BigInt.asIntN(64, …)` is what
makes bit 63 the sign bit rather than a value SQLite would clamp.

**Non-obvious detail — dotted paths cross arrays.** MongoDB descends into an
array at EVERY level of a path, so `{ 'instock.qty': 5 }` must match an element
of `instock`. Each split of the path contributes an `$elemMatch` arm on the
prefix (`arrayPathArms`), joined through `withElementMatch` so the plain arm
keeps its index. `MAX_ARRAY_PATH_DEPTH` is load-bearing: the expansion is
self-similar — `$elemMatch` re-wraps its element as `{ f: ... }`, so the inner
path is `f.b.c` and splitting at `f` regenerates the same shape forever.
The negative operators are absent from `ARRAY_PATH_OPS` on purpose: they
delegate to their positive twin, so expanding them would OR arms into a
negation and invert the meaning.

**Non-obvious detail — `$elemMatch` aliases are numbered.** Each nesting level
names its computed column `valueJson<depth>`. A single shared `valueJson` meant
an inner `$elemMatch` shadowed its parent and the query silently matched
nothing; the alias number is the only thing preventing that.

**Non-obvious detail — what an upsert inserts.** When nothing matched, the new
document is built in JS by `buildUpsertDocument()`, not in SQL: MongoDB seeds it
from the filter's **equality** conditions only, and "equality" is narrower than
it looks — `$gt`/`$in`/`$ne`/a regex contribute nothing, `$and` is traversed but
`$or` is not, and a dotted path becomes a nested document. `collectEqualities()`
encodes those rules and
[test/upsert-and-find-one-and.spec.ts](test/upsert-and-find-one-and.spec.ts)
pins every one of them against the server. `$setOnInsert` exists only for this
path — it never reaches the SQL expression.

**Non-obvious detail — validation before writing, not during.** `$inc` rejects
non-numeric targets (and `$push` non-array ones) with a SELECT that runs *before*
the UPDATE (`Collection.assertUpdateApplies`, over the `UpdateGuard` list
src/update.ts builds), not with a guard inside the UPDATE itself.
The obvious alternative — a `CASE` calling a registered SQL function that
throws — is **not portable**: on Node 22.13 (the `engines` floor) an exception
thrown inside a `db.function()` callback is swallowed and the call yields NULL,
so `json_set` wrote null over the value, causing the exact data loss the guard
existed to prevent. Node 26 propagates it. Don't reintroduce that pattern, and
don't assume a JS callback can fail a statement.

### Update operators (src/update.ts)

Everything compiles to ONE expression dropped into a single UPDATE, rather than
reading documents into JS and writing them back — that is what keeps
`updateMany` one statement over an indexed scan. Two rules hold throughout:
every operator reads **`data`**, the original column, never the partially-built
expression (safe only because `assertNoConflictingPaths` rejects overlapping
paths); and anything that can fail is checked **before** the UPDATE, as a guard.

**Non-obvious detail — a rebuilt array loses type information twice.** Any
operator that rebuilds an array (`$pull`, `$addToSet`, `$push` with
`$sort`/`$slice`) streams elements through a nested SELECT, and
`json_each.value` loses its JSON subtype crossing that boundary, so objects came
back as strings (`["{\"x\":1}"]`). Separately, a boolean element decodes to the
INTEGER 1, so `[true]` rebuilt as `[1]`. `restoreJson()` repairs both from the
carried `type` column. **Route every rebuild through `groupArray()`**, which
applies it.

**Non-obvious detail — `arrayAt()` cannot be a COALESCE.** `json_quote(NULL)` is
the JSON value `null`, not SQL NULL, so
`COALESCE(json_quote(json_extract(...)), json_array())` never fires its fallback
and every array operator saw `null` instead of `[]`. It has to be a CASE on
`json_type(...) IS NULL`.

**Non-obvious detail — `$each` is bound as ONE json array, not appended value
by value.** The obvious `json_insert` chain nests one SQL call per element and
SQLite's parser gives up at a few hundred ("Recursion limit"), so
`$push: { a: { $each: [...900 items] } }` failed. Both `$push` and `$addToSet`
bind the list and append it with a `UNION ALL`, which is flat however long it
is. Don't "simplify" either back to a chain.

**Non-obvious detail — `$addToSet` dedupes its `$each` list in JS.** With the
list deduped by `equalsBson` first, each candidate only has to be compared
against the ORIGINAL array. Comparing against the array as it grows would nest
the whole expression once per value — exponential in the size of `$each`. The
SQL presence check compares `e.value IS c.value AND e.type = c.type`; without
the type test a boolean `true` (which decodes to 1) is found by `$addToSet: 1`.

**Non-obvious detail — `$pull` uses `json_replace`, not `json_set`.** A `$pull`
against a missing field is a no-op in MongoDB, and `json_replace` only writes
where the path already exists — which avoids a `CASE` duplicating the whole
expression. `$pop` relies on the same idea: `json_remove` on `'$.a[0]'` or
`'$.a[#-1]'` is a no-op for a missing field AND an empty array.

`$position` inside `$push` is deliberately **rejected**, not implemented: it
needs a rebuild that renumbers around the insert point, and a clear error beats
a half-implementation.

### How aggregation is split (src/aggregate.ts)

A LEADING run of `$match`/`$sort`/`$skip`/`$limit` is pushed into SQLite via the
ordinary query compiler — so a pipeline starting with `$match` is
index-eligible, which is pinned by a plan-regression test in
[test/query-plan.spec.ts](test/query-plan.spec.ts). Everything after runs in JS.
`splitPipeline` stops the pushdown wherever reordering would change the answer
(a `$match` after a `$sort`, a `$skip` after a `$limit`). `cursor.explain()`
reports the boundary; **that method is the contract**, so keep it accurate.

**Non-obvious detail — a mid-pipeline `$match` goes back through SQLite** via a
TEMP table (`Collection.matchBatch`), not through a JS re-implementation of the
filter language. A second matcher would be a second set of semantics to keep in
step, and every quirk the specs pin down would eventually drift apart. If you
are tempted to write `matchesFilter(doc, filter)` in JavaScript, don't.

**Non-obvious detail — `setPathImmutable`, not a shallow copy.** `$unwind`
emits several documents from one source; `{ ...doc }` shares its nested objects,
so writing each element into the same nested object left every emitted document
holding the last one.

**Non-obvious detail — the strict `$sort` check runs before sorting.**
`Array.prototype.sort` never calls the comparator for a one-element list, so a
check inside the comparator missed a `$group` that produced a single row.

### The expression language (src/expression.ts)

`$add`, `$cond`, `$dateToString`, `$map` and the rest. Four rules, each settled
by the oracle rather than by reasoning — see
[test/operators/expression-operators.spec.ts](test/operators/expression-operators.spec.ts):

**A wrong TYPE throws; a missing VALUE does not.** `{ $add: ['$a', 1] }` over a
document without `a` is `null`; over `{ a: 'x' }` it throws. A schema-less store
is full of absent fields and they must not blow up a pipeline.

**Missing and null are different values.** A missing field evaluates to
`undefined`, and a computed field that evaluates to `undefined` is OMITTED from
the output rather than set to null — which is what makes `$$REMOVE` and
`$arrayElemAt` past the end behave like the server.

**Non-obvious detail — the comparison operators do NOT use `compareBson`.**
`compareValues` ranks a missing value BELOW null, so `{ $eq: ['$absent', null] }`
is **false**. `$sort` and `$group._id` DO treat missing as null, which is why the
two orderings cannot be merged. Verified against the server; it surprises
everyone.

**Non-obvious detail — `$round` breaks ties to EVEN.** `$round: 2.5` is 2 and
`$round: 3.5` is 4. `Math.round` would answer 3 and 4, and the difference only
shows on exact halves — so it is the kind of thing that ships.

**`$sum`/`$avg`/`$min`/`$max` exist twice**: as accumulators in `$group`
(src/aggregate.ts) and as array operators everywhere else (here). That is
MongoDB's design, not a duplication to clean up — `$group` never reaches the
expression versions, because `accumulatorFor` intercepts first.

Dates are UTC-only and a `timezone` option is REJECTED rather than ignored.
`$function`/`$accumulator` are never implemented, for the same reason as
`$where`.

### strict mode

`Db.fromUrl(url, { strict: true })` rejects constructs whose answer is KNOWN to
differ from MongoDB's (over-deep dotted array paths, `$type` on an unstorable
type, sorting an array-valued field, an aggregation path through an array).
[test/strict.spec.ts](test/strict.spec.ts) is single-engine on purpose — every
case is one where a real server disagrees, so there is nothing to check against.
Each test asserts BOTH halves: the lenient default still behaves as documented,
AND strict rejects. **When you find a new divergence, add a check here too** —
the mode's value is that the known list is enforced, not just written down.

### distinct() and drop()

**Non-obvious detail — `distinct()` is not a `SELECT DISTINCT`.** An array field
contributes its ELEMENTS (the same implicit-array rule queries follow), so it
compiles to two statements: one over non-array values, and one over
`json_each` of the array-valued rows. The filter is applied inside a DERIVED
TABLE in the element arm, so `data` and `rowid` never have to resolve across
the `json_each` join.

**Non-obvious detail — values are deduped as TEXT, then decoded.** Every value
comes back through `asJsonText()` as a JSON fragment; deduplication happens on
that string and only the survivors go through `parseDocument`. Deduping decoded
values would treat two equal `Date` objects as distinct. The same `CASE` is
needed for booleans: `json_quote` renders JSON `true` as the integer 1.

**`drop()` must evict the `Db` cache.** `Collection`'s constructor runs
`CREATE TABLE IF NOT EXISTS`, so a cached instance whose table was dropped would
keep being handed out and every call on it would fail with "no such table". The
`onDrop` callback passed in by `Db.collection()` is what removes it. Related
divergence: collections are created EAGERLY here (on `db.collection(name)`) and
lazily on MongoDB (on first write), which is why the drop parity test recreates
by inserting rather than by asking for indexes.

### Transactions

`db.withTransaction(work)` is a CALLBACK, not a session object: `node:sqlite` is
synchronous, so nothing interleaves between statements and there is no
concurrency for a session to coordinate. Nesting uses SAVEPOINT, because SQLite
has no nested `BEGIN`.

**Non-obvious detail — `ROLLBACK TO` does not pop the savepoint.** It rewinds
but leaves the savepoint on the stack, so it must be `RELEASE`d too or the next
release unwinds the wrong one.

**Non-obvious detail — DDL is transactional, so a rollback can delete a table.**
Opening a collection for the FIRST time inside a transaction runs its
`CREATE TABLE`; if that transaction rolls back, the table goes with it and the
cached `Collection` points at nothing ("no such table" on the next call).
`withTransaction` therefore CLEARS the collection cache on rollback. The same
hazard is why `drop()` and `dropDatabase()` evict the cache.

### The raw SQL escape hatch

`db.sql.all` / `.get` / `.run` are tagged templates over the same connection
(src/raw-sql.ts). Four decisions are load-bearing:

**Values are bound; `db.table()` is the only splice.** Every `${}` becomes a `?`
parameter. A table name cannot be a parameter and `tableNameFor()` is not
guessable, so `db.table(name)` returns the quoted physical name wrapped in a
`SqlFragment` — the one interpolation spliced rather than bound, and the library
produces it, not the caller. **Do not add a general "raw fragment" escape**; it
would turn the escape hatch into an injection hatch.

**Rows come back RAW, and normalised.** A document is the `data` column's JSON
text — `parseDocument`/`stringifyDocument` are exported for it. But the row
OBJECT is copied onto an ordinary prototype: `node:sqlite` returns
null-prototype rows, and letting that through would mean a different `Driver`
handing callers a different shape for the same query. The copy is a spread, so
a column aliased `__proto__` stays an own property.

**Non-obvious detail — one statement per call, enforced.**
`DatabaseSync.prepare()` compiles the FIRST statement and **silently discards
the rest** (measured), so `run\`INSERT …; INSERT …\`` would insert one row and
report success. `assertSingleStatement` scans past string literals, quoted
identifiers and comments and rejects a second statement. A trailing `;` is fine.

**Errors are NOT translated here.** A unique-index violation surfaces as SQLite
reports it, not as `MongoServerError` 11000 — the caller wrote SQL, not
`insertOne`. That asymmetry is deliberate; don't "fix" it.

### The collection-name registry

`tableNameFor()` is deliberately not reversible for awkward names (the digest is
what keeps `Users` and `users` apart), so `listCollections()` could not recover
the caller's name from the table. `Collection`'s constructor records the mapping
in `_sdb_collections`; that is the ONLY metadata table, and nothing reads
document data through it. A database written before it existed still lists its
simple names — `collection_<name>` does round-trip — and an awkward one
reappears as soon as anything opens it.

### The driver seam — read this before adding any statement

`node:sqlite` is the only engine today, but **it will not be the only one**
(BACKLOG [DR-3](BACKLOG.md), item 24: libSQL, Turso and eventually PostgreSQL).
The seam already exists — [src/driver.ts](src/driver.ts) is the interface,
[src/drivers/node-sqlite.ts](src/drivers/node-sqlite.ts) the only
implementation, `Db.fromDriver()` the entry point an external backend uses —
and it is cheap to keep and expensive to rebuild. Four rules keep it usable:

1. **Only `src/drivers/*` may import `node:sqlite`.** Everything else takes a
   `Driver`. `grep "from 'node:sqlite'" src/` should return exactly one file.
2. **Assume the next driver is ASYNC.** libSQL's remote client and Turso's
   JavaScript binding are promise-based; `node:sqlite` and `better-sqlite3`
   (both synchronous) are the exception, not the rule. The public API is already
   `async`, which is what makes this survivable — so **do not add new
   synchronous assumptions to callers**, and prefer shapes that would still read
   correctly if every `this.prepare(...).get(...)` gained an `await`.
3. **Every statement is a possible network round trip.** This library does
   PRE-FLIGHT SELECTs — `findOneRow` before each single-document write (6 call
   sites), `assertUpdateApplies` before each update, plus `assertSortable` and
   `assertDistinctPath` under `strict`. They are free on a local synchronous
   engine and cost a round trip each on a remote one, so `updateOne` is two.
   They exist for real reasons and must not simply be deleted — but **prefer one
   statement to check-then-write when a new feature has the choice**, and do not
   add a pre-flight check casually.
4. **Do not rely on capabilities the interface marks optional.** `iterate()` may
   materialise (libSQL/Turso return whole result sets), so never depend on
   laziness for CORRECTNESS — only for memory. And `createFunction` may be
   absent (`supportsFunctions`), which is why `$regex` needs a JavaScript
   post-filter fallback before either engine can be supported.

**The dialect seam is NOT built.** SQL emission is still SQLite-specific: 169
JSON1 call sites, 148 of them in [src/query.ts](src/query.ts) and
[src/update.ts](src/update.ts). That is deliberate — it buys nothing until
PostgreSQL is actually attempted. The practical consequence for new work:
**keep SQL emission inside those two files.** A JSON function spelled inline in
`collection.ts` is one more site to find when the dialect seam does land.

**An interface with one implementation is a type, not a seam.**
[test/driver-seam.spec.ts](test/driver-seam.spec.ts) runs the whole library
through a second driver with streaming and user-defined functions removed, which
is what proves the abstraction is load-bearing. Give the dialect seam the same
treatment when it arrives.

### SQL injection posture

User-supplied **values** are bound as named parameters (`bindValue()` →
`:p0`..., update expressions use `:u0`... so the two merge in one UPDATE).
`limit`/`skip` are the exception — they are interpolated, so `find()` validates
them (`assertLimit`/`assertSkip`) rather than trusting the TypeScript signature.
Named, not positional, because fragments are reused — the same token appears in
both arms of the implicit-array union and twice in `SET x WHERE data != x`.
**If you add an operator, route every user-supplied value through
`bindValue()`** — never interpolate. Field **paths** stay string literals
through `quoteLiteral()`/`toJson1PathString()` on purpose: SQLite only matches an
expression index whose indexed expression is textually identical, so a bound
`json_extract(data, :path)` would never use an index. Identifiers go through
`quoteIdentifier()`; collection names are additionally validated. Booleans bind as 1/0
(SQLite cannot bind a bool); update values always go through `json(:u)` with
the storage encoder so `$set: { x: true }` stores `true`, not `1`.
Adversarial-value coverage: [test/injection.spec.ts](test/injection.spec.ts) for
ASCII, [test/unicode.spec.ts](test/unicode.spec.ts) for the rest of Unicode —
nine scripts, both normalisation forms of `café`, astral characters, an embedded
NUL, and the same values as FIELD names, which take the path-literal route
rather than the bound-value one.

**Prototype safety.** Anywhere a user-supplied key is used to index an object,
that object is built with `Object.create(null)` — the projection path tree
([src/projection.ts](src/projection.ts)) and the storage encoder's accumulator
([src/ejson.ts](src/ejson.ts)) — and `Db`'s collection cache is a `Map`. This is
not decoration: a projection of `{ '__proto__.x': 1 }` used to write to
`Object.prototype`, and a document field named `toString` used to find a function
where a subtree was expected.

## Testing approach

This is the project's best idea and is worth preserving: **every assertion runs
twice, once against this library and once against a real MongoDB** booted
in-memory by `mongodb-memory-server`. Each spec loops
`for (const dbName of ['Sqlite', 'Mongodb'])` and swaps the `db()` accessor.
MongoDB is the oracle — if an assertion is wrong, the Mongodb variant fails too,
which immediately tells you the *test* is wrong rather than the implementation.

### Test infrastructure

Originally every spec spawned its own `mongod` in `beforeEach`, which cost ~60s
a run. Now:

- [test/global-setup.ts](test/global-setup.ts) boots **one** mongod for the whole
  run and hands its URI to the specs via Vitest's `provide`/`inject`.
- [test/helpers/dual-dbs.ts](test/helpers/dual-dbs.ts) gives each spec file its
  own randomly-named database on that shared server, so files stay isolated and
  can run in parallel. Two entry points:
  - `freshDualDbs(seed?)` — empty databases recreated before **every test**.
    Use for specs that insert/update/delete.
  - `seededDualDbs(seed)` — seeded once, shared by the file. Use for read-only specs.

That took the suite from ~60s to ~4s. When adding a spec, reach for one of those
two helpers rather than hand-rolling setup.

Other things to know:

- Vitest runs with `globals: true` so the Jest-era `describe`/`it`/`expect` in
  the specs work unchanged.
- `test/index.spec.ts` has a `byId()` helper. It exists because this library
  types `_id` as `string` while the MongoDB driver types it as `ObjectId`; the
  `Db | Mdb` union accepts neither, so id filters bypass it via `any`. That file
  also imports `Db as Mdb` as a **value** (not `import type`) because its
  assertions use `instanceof Mdb`.

- Two specs deliberately run against this library **alone**, and say so at the
  top: [test/cursor.spec.ts](test/cursor.spec.ts) (statement lifetime has no
  MongoDB analogue) and the rejection half of
  [test/collections.spec.ts](test/collections.spec.ts) (the driver defers name
  validation to the server). Everything else is dual-engine.
- [test/operators/operator-edge-cases.spec.ts](test/operators/operator-edge-cases.spec.ts)
  collects the compiler's edge cases — empty arrays, scalars where arrays were
  expected, malformed operators. When a query "returns nothing" or dies with a
  raw SQLite error, that is the file to extend.

[test/types.test-d.ts](test/types.test-d.ts) is where the type layer is pinned.
**The `@ts-expect-error` cases are the feature** — each asserts that a mistake
FAILS to compile, and tsc reports an unused directive, so a type that goes slack
turns those into errors. Verified by mutation: slackening `Filter` back to
`Record<string, any>` fails 6 of them. Two invariants to preserve when editing
[src/filter-types.ts](src/filter-types.ts):

- **Never add an operator the compiler does not implement.** A type that says
  "this compiles" about a query that throws is worse than no type. This is why
  the driver's `Filter` is not adopted wholesale — it promises `$expr`,
  `$where`, `$text` and the geo operators.
- **`Collection<Document>` must stay permissive.** `Document` has an index
  signature; `IsAny` and `keyof T & string` widening are what make an untyped
  collection behave exactly as it did before the types existed.

Some assertions are commented out with `// TODO` (see
[test/operators/query-operators.spec.ts](test/operators/query-operators.spec.ts)).
These are genuinely unimplemented features, not flaky tests.

Two more specs are worth knowing about:
[test/operators/update-operators.spec.ts](test/operators/update-operators.spec.ts)
covers the array and field update operators, where the oracle earns its keep —
what `$pull` does with a document criterion, whether `$addToSet` counts `1` and
`true` as equal, what `$mul` does to a missing field are all rules nobody would
guess right. [test/aggregate.spec.ts](test/aggregate.spec.ts) covers the
pipeline; **every grouping test there ends with a `$sort`**, because `$group`'s
output order is unspecified on the server and an unsorted expectation makes the
Mongodb variant flaky for reasons that are nobody's bug.

## Toolchain notes

- **oxlint, not ESLint.** As of mid-2026 `typescript-eslint` declares
  `typescript: ">=4.8.4 <6.1.0"` and hard-crashes on TypeScript 7's native
  compiler (`TypeError: Cannot read properties of undefined (reading 'Intrinsic')`
  in `ts-api-utils`). oxlint has its own Rust parser and is unaffected. If you
  ever reintroduce an ESLint-based setup you must downgrade to TypeScript 6.
- **`noUncheckedIndexedAccess` is on.** Indexing an array yields `T | undefined`,
  hence the `!` assertions on known-safe literal indexes.
- **`verbatimModuleSyntax` + NodeNext**: relative imports need explicit `.js`
  extensions, even in `.ts` files.
- Two tsconfigs: `tsconfig.json` (typechecks src + test, `noEmit`) and
  `tsconfig.build.json` (emits `src` only, so tests never land in `dist/`).

## Gotchas

- `Db.fromUrl()` and the `Collection` methods are `async` for API compatibility,
  but `node:sqlite` is **synchronous** — there is no real concurrency underneath.
  Keep the async signatures; callers and the MongoDB parity tests depend on them.
  The one thing callers *can* interleave is a `for await` over a cursor: writing
  to the same collection inside that loop is unspecified in SQLite. Documented in
  the README rather than prevented.
- Single-document writes (`deleteOne`, `updateOne`, `replaceOne`) locate their
  target with `findOneRow()` and then address it **by rowid**. Do not "simplify"
  this back to a second filter on `_id`: the id's type changes how that filter
  compiles, and an array `_id` made `deleteOne` delete two documents.
- `insertMany` **mutates the input documents**, assigning `_id` in place. This
  matches the MongoDB driver, and several tests assert on the mutated objects.
- **`bulkWrite` delegates to the single-document methods** rather than
  reimplementing them, so it cannot drift from `updateOne` and friends. It is a
  batching and result-accounting layer.
- **`insertMany({ ordered: false })` cannot use one transaction**, and does not:
  a failure has to leave the successful documents while skipping the failed
  ones, and a single transaction has only one outcome for all of them. Ordered
  (the default) is the batched, fast path.
- **`insertMany` matches MongoDB's *ordered* insert: on a duplicate `_id` the
  documents already written stay written, and nothing after it is attempted.**
  That is a statement about the OUTCOME, not about transactions — and the
  distinction is load-bearing. The batch runs inside ONE transaction and a
  failure part-way through **COMMITs** the prefix rather than rolling it back,
  which leaves exactly the state MongoDB would. It used to be one implicit
  transaction per document, and with `journal_mode=WAL` plus SQLite's default
  `synchronous=FULL` that is one fsync per document — the reason inserting 100k
  documents took minutes on a file-backed database. Do not "fix" the commit-on-
  error into a rollback: that would make the batch atomic, which MongoDB's
  ordered insert is not.
  `BEGIN` is *attempted*, not guarded by a flag, so an enclosing transaction
  (a future `withTransaction`) simply keeps ownership.
- **Document nesting is capped at `MAX_DOCUMENT_DEPTH` (200)** in
  [src/ejson.ts](src/ejson.ts). Three limits bear on that number and the
  comment there explains all three; the one that bites is that **`encode`
  recurses once per level**, so the cap has to be reachable on every supported
  platform. It was 1000 (mirroring SQLite) for exactly one day, and CI caught it
  on **Windows / Node 22.13** with `RangeError: Maximum call stack size
  exceeded` — Linux/Node 26 has a bigger stack and passed. If you raise this,
  the Windows job is the one that decides. MongoDB is *stricter* (~180), and
  being slightly above it is deliberate: more permissive means data still
  round-trips, stricter would refuse documents a real server takes.
  [test/ejson.spec.ts](test/ejson.spec.ts) pins both edges. There is no document
  SIZE limit, which means a document a real MongoDB would refuse (>16MB) is
  accepted here.
- **Storage is EJSON-for-Dates, not plain JSON** ([src/ejson.ts](src/ejson.ts), per
  DR-1). Dates are stored as `{"$date": "<ISO>"}` and revived on read; every other
  non-JSON type is rejected at write time with the offending path — **including a
  plain object of exactly that wrapper shape**, which would otherwise be revived as
  a Date (an *Invalid* Date, serialising to `null`, when the string is not one).
  Consequences:
  documents must go through `stringifyDocument`/`parseDocument`, never raw
  `JSON.stringify`/`parse`; date comparisons in [src/query.ts](src/query.ts)
  target the `field.$date` sub-path (ISO strings order lexicographically, which is what
  makes `$gt`/`$lt` work); `$in`/`$nin` with a Date rewrite to `$or`/`$nor` of
  equalities; and any future index over a date field must target the same `.$date`
  sub-path or it won't match.
