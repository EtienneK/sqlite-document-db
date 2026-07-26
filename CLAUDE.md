# sqlite-document-db

A MongoDB-style document database implemented on top of SQLite's JSON functions.
Zero runtime dependencies; ESM only; requires Node >= 22.13 for `node:sqlite`
plus `DatabaseSync.prototype.function` (which backs `$regex`).

Planned work is in [BACKLOG.md](BACKLOG.md) — check it before starting a feature, it
records prior investigation (query plans, feasibility, sequencing) for most items.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Full suite (vitest), ~2s. Boots two real MongoDBs for the run (see below). |
| `npm run test:watch` | Watch mode |
| `npm run lint` | oxlint |
| `npm run typecheck` | `tsc` over `src` **and** `test` |
| `npm run build` | Emits `dist/` from `src` only (`tsconfig.build.json`) |
| `npm run test:types` | Type-level assertions (`vitest --typecheck`), own config |
| `npm run examples` | Builds, then runs every example in `examples/` |
| `npm run bench` | Benchmarks over 20k docs, **file-backed**; no mongod, own vitest config |
| `npm run stress` | The stress suite (~25s): every feature over deliberately hostile documents. Asserts ceilings, prints a report |

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

- [src/index.ts](src/index.ts) — the public entry point. Re-exports ONLY, no
  implementation, which is what makes "nothing imports index.ts" true by
  construction rather than by care.
- [src/db.ts](src/db.ts) — `Db`: the connection, the collection cache,
  `withTransaction`, `db.sql`. Split out of index.ts when the MongoClient shim
  needed the class and importing it from the entry point would have made the
  graph circular.
- [src/mongo-client.ts](src/mongo-client.ts) — the `MongoClient`-shaped shim
  (see below).
- [src/client-session.ts](src/client-session.ts) — `ClientSession`:
  `startSession()`, `withTransaction`, and the rules for `{ session }`
  (see below).
- [src/change-stream.ts](src/change-stream.ts) — `watch()`: the per-connection
  `ChangeHub` and the `ChangeStream` it feeds (see below).
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
- [src/projection.ts](src/projection.ts) — MongoDB projection semantics, applied
  in JS. **The `$`-operators do not decide which element matched — SQLite does.**
  `$elemMatch` and `$` both need "the first element of this array satisfying a
  criterion", and the criterion is written in the filter language, so answering
  it here would be a second implementation of that language. Instead a compiled
  projection declares `probes`, `find()` compiles each into an extra column of
  the query it was already running (`firstMatchingElementSql` in query.ts), and
  `project()` is handed the indexes. `findOneAnd*` has no cursor to hang a
  column off, so it pays ONE extra statement — only when a probe exists.
  **Non-obvious detail: `$slice` decides nothing about inclusion or exclusion.**
  A spec of nothing but `$slice` returns whole documents with one array
  shortened, so it must not touch the include/exclude counts — but it DOES have
  to join the inclusion tree when the mode is inclusion, or the sliced field
  vanishes.
- [src/regex.ts](src/regex.ts) — MongoDB regex options → a JavaScript `RegExp`.
  It exists because BOTH the `$regex` query operator (query.ts) and the
  `$regexMatch`/`$regexFind`/`$regexFindAll` expression operators
  (expression.ts) need the identical flag policy, and query.ts already imports
  expression.ts for `$expr` — so one of them importing the other would close a
  cycle. The policy is the part with decisions in it: `x` is refused (no JS
  equivalent, and ignoring it would change which documents match), and `g`/`y`
  are stripped for the query operator (stateful `test()` skips rows) but
  REFUSED for the expression ones, because MongoDB refuses them there.
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

**Non-obvious detail — a UNIQUE index needs a THIRD SQLite index to mean what
MongoDB means.** A SQL unique index counts every NULL as distinct, so two
documents *missing* the indexed field were both accepted where a server refuses
the second. A non-sparse unique index therefore also gets `ixu_<table>_<name>`:
a PARTIAL unique index over `json_quote(json_extract(...))` restricted to the
rows where the extract IS NULL. `json_quote` renders both a missing field and a
stored JSON null as the text `'null'`, which is exactly the conflation MongoDB
makes. Verified dual-engine in [test/indexes.spec.ts](test/indexes.spec.ts).
`mongoIndexName()` maps the companion back, so a violation reports the index the
caller named.

**Non-obvious detail — `partialFilterExpression` is much narrower than it looks,
and that is measured.** SQLite answers "subqueries prohibited in partial index
WHERE clauses", and every comparison this compiler emits carries an
array-element arm (`EXISTS (SELECT ... FROM json_each(...))`) because
`{ status: 'A' }` also has to match `{ status: ['A'] }`. Dropping that arm would
index FEWER documents than MongoDB does, which is silently wrong for a unique
partial index — so `INDEX_FILTER_OPS` in query.ts allows `$exists`, `$and` and
`$or` and refuses the rest with the reason. `sparse: true` is the single-field
shorthand and is the case that works. **Do not "widen" this without solving the
subquery problem.**

**Non-obvious detail — a partial index's predicate is compiled with INLINE
literals.** `CREATE INDEX ... WHERE` has nothing to bind a parameter to, so
`SqlBindings.inline` makes `bindValue`/`bindJson`/`bindRaw` emit quoted literals
through the same `quoteLiteral` paths use. It is the ONE place a value is
interpolated, and nothing else may set the flag.

**Non-obvious detail — `sparse` and `partialFilterExpression` are carried in a
SQL COMMENT.** They cannot be recovered from the compiled predicate, and adding
a second metadata table for them was not worth it, so `createIndex` appends
`/* sdb-index {...} */` and `indexes()` parses it back. SQLite stores a CREATE
statement's text verbatim and rewrites the table name inside it on
`ALTER TABLE ... RENAME`, so the comment survives a `rename()`. Every `*` in
`JSON.stringify` output is inside a string literal, which is why escaping it as
`*` keeps a field name from ending the comment early.

**Non-obvious detail — `hint` goes on the table reference the index would
actually serve.** `INDEXED BY` on the OUTER `FROM` of a rowid-union query forces
a full index scan plus a temp B-tree for `ORDER BY rowid` (measured), because
the outer table is reached by rowid. So the hint is threaded through
`CompileOptions.table` — which is what `withElementMatch` names in its UNION
arms — and applied to the outer `FROM` only when the compiled filter did NOT use
that form. `toSql` reports which, via `usesRowidUnion`. Like MongoDB's hint it
FAILS ("no query solution") rather than falling back.

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

**Non-obvious detail — a negative `$slice` must not name its array twice.**
`$slice: -n` keeps the LAST n elements, and the obvious spelling —
`WHERE json_each.key >= json_array_length(<the array>) - n` — makes SQLite
recompute the whole array expression, including any `$sort` rebuild above it,
ONCE PER ELEMENT. That made the documented capped-list idiom
(`$push` + `$each` + `$sort` + `$slice`) quadratic: 9.4s for 6,000 elements,
34s with `$sort`, against 8ms and 14ms after the fix. It is
`ORDER BY key DESC LIMIT n` inside a derived table, re-sorted ascending, so the
array is evaluated once. Found by `npm run stress`, which now pins the SHAPE of
that SQL (it must not contain `json_array_length`) rather than a timing.

**Non-obvious detail — `$bit` spells XOR out of AND and OR.** SQLite has `&`,
`|`, `~`, `<<` and `>>` and no `^`, so `xor` compiles to
`(a | b) & ~(a & b)` — the identity holds in two's complement and cannot
overflow, because every bit of `a & b` is already a bit of `a | b`. The masks
bind as decimal STRINGS and are `CAST` to INTEGER, the same trick the `$bits*`
QUERY operators use and for the same reason (bit 62 is past
`Number.MAX_SAFE_INTEGER`).

**Non-obvious detail — `$currentDate` reads the clock ONCE per statement**, not
once per row, so every document an `updateMany` touches gets the same instant.
`{ $type: 'timestamp' }` is refused rather than answered with a Date: a BSON
Timestamp is one of the types [src/ejson.ts](src/ejson.ts) cannot store, and
substituting a different type is the failure mode this library exists to avoid.

**Non-obvious detail — `$position` orders its runs explicitly.** Inserting
mid-array stitches together three runs (before the insert point, the new values,
after it) and `ORDER BY`s them by a group tag. `UNION ALL` does not promise an
order, and here the order IS the feature — the plain `$push` append gets away
with it, this cannot.

### The positional update operators (`$`, `$[]`, `$[<identifier>]`)

All three write THROUGH an array, which no single `json_set` can do: one
addresses a computed index, one every element, one the elements matching a
criterion. They share one mechanism — rebuild the array, applying the operator
to the selected elements.

**`FieldWriter` is why there is one mechanism and not six.** Each field operator
(`$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`) is a
`(target, source, path) => sql` function. Normally `target` is the expression
built so far, `source` is `data` (rule 1) and `path` is the field's literal
path; inside a positional rebuild both are ONE WRAPPED ELEMENT and the path is
the suffix under `$.f`. The wrapper is `json_object('f', json_quote(value))` —
the same one `$elemMatch` and `$pull` use, which is what lets an ordinary field
path address either the element itself (`$.f`) or a field inside it.

**Non-obvious detail — the element stream is a DERIVED table.** SQLite resolves
a result alias in `WHERE` but not in a sibling result column, and the rebuild
needs the wrapped element in its `SELECT` list. `elementSource` therefore
computes it one level down.

**Non-obvious detail — guards have their OWN parameter registry** (`g`, beside
the expression's `u`). A positional guard carries the criterion it selects
elements with, so guards stopped being parameterless SQL — and `node:sqlite`
rejects a statement handed a parameter it does not use, in *either* direction.
One registry per statement is the only shape that binds exactly. An unbound
named parameter is silently NULL rather than an error, which is how this first
showed up: every `$` update failed its own "did not find the match" guard.

**Non-obvious detail — `$unset` through `$` leaves a null**, it does not shorten
the array. Decided from the parsed target's empty suffix, NOT by looking at the
path string: a field genuinely named `f` spells the same path.

`$` reads its element from the FILTER, via the same `firstMatchingElementSql`
probe the `$` projection operator uses — one implementation of "which element
matched" for both sides. The positional operators are rejected by name in the
array operators and `$rename`.

### How aggregation is split (src/aggregate.ts)

A LEADING run of `$match`/`$sort`/`$skip`/`$limit` is pushed into SQLite via the
ordinary query compiler — so a pipeline starting with `$match` is
index-eligible, which is pinned by a plan-regression test in
[test/query-plan.spec.ts](test/query-plan.spec.ts). Everything after runs in JS.
`splitPipeline` stops the pushdown wherever reordering would change the answer
(a `$match` after a `$sort`, a `$skip` after a `$limit`). `cursor.explain()`
reports the boundary; **that method is the contract**, so keep it accurate.

**Non-obvious detail — a mid-pipeline `$match` goes back through SQLite** via a
TEMP table (`matchDocuments`, which `Collection.matchBatch` delegates to), not
through a JS re-implementation of the filter language. A second matcher would be
a second set of semantics to keep in step, and every quirk the specs pin down
would eventually drift apart. If you are tempted to write
`matchesFilter(doc, filter)` in JavaScript, don't. A `$match` in a `watch()`
pipeline runs through the same function, on a one-document batch.

**Non-obvious detail — `setPathImmutable`, not a shallow copy.** `$unwind`
emits several documents from one source; `{ ...doc }` shares its nested objects,
so writing each element into the same nested object left every emitted document
holding the last one.

**Non-obvious detail — the strict `$sort` check runs before sorting.**
`Array.prototype.sort` never calls the comparator for a one-element list, so a
check inside the comparator missed a `$group` that produced a single row.

**Non-obvious detail — `$unset` and `$sortByCount` are COMPOSED, not written.**
`$unset` compiles to a `$project` exclusion and `$sortByCount` to `$group` +
sort-by-count, because that is how the manual defines them. A second
implementation of either would be a second set of semantics to keep in step.

**Non-obvious detail — an N-family accumulator's `n` is a CONSTANT here.**
`accumulatorFor` builds the accumulator before any group exists, so `n` is
evaluated once against an empty document. MongoDB additionally allows an
expression over the group key; here that raises rather than answering, which is
the acceptable form of the divergence.

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
expression versions, because `accumulatorFor` intercepts first. The same is now
true of `$mergeObjects` and the N-family (`$firstN`/`$lastN`/`$maxN`/`$minN`),
and the two halves DIFFER on purpose: as accumulators `$firstN`/`$lastN` count a
missing field as null while `$maxN`/`$minN` skip it, which the oracle settled.

**Non-obvious detail — `$regexFindAll` does not report a zero-width match at the
END of the string.** MongoDB attempts a match at every index up to the last
CHARACTER, not past it, so `x*` over `'ab'` is two matches on the server and
three in JavaScript — while the empty string still gets its one attempt at 0.
Both halves are verified; the two regex engines genuinely differ here.

**Non-obvious detail — `$toDate` and `$convert` refuse an INT where they accept
a double.** MongoDB's conversion table has no int → date entry, so
`{ $toDate: 0 }` raises and `{ $toDate: 1600000000000 }` does not. This library
tells the two apart exactly as `$type` does — an integral number in int32 range
is an `int`, anything else a `double` — which is what makes the same values
raise here and there.

**Non-obvious detail — the set operators' ORDER is copied, not chosen.**
`$setUnion` and `$setIntersection` come back in BSON order and `$setDifference`
in the first array's; MongoDB documents the order as unspecified and this is
what the server actually does. `$setUnion`/`$setIntersection`/`$setDifference`
propagate null, while `$setEquals`/`$setIsSubset`/`$allElementsTrue`/
`$anyElementTrue` raise on one — also the server's rule, and not guessable.

Dates are UTC-only and a `timezone` option is REJECTED rather than ignored.
`$function`/`$accumulator` are never implemented, for the same reason as
`$where`.

### strict mode

`Db.fromUrl(url, { strict: true })` rejects constructs whose answer is KNOWN to
differ from MongoDB's (over-deep dotted array paths, `$type` on an unstorable
type, sorting an array-valued field, an aggregation path through an array, an
operation inside a session transaction that was not given `{ session }`).
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

**`rename()` has the same hazard twice over, plus the indexes.**
`ALTER TABLE ... RENAME TO` moves the data and repoints every index at the new
table, but the index NAMES embed the OLD table's and `indexes()` finds them by
that prefix — so each one is recreated under the new name and the old dropped.
SQLite has already rewritten the table name inside the stored CREATE statement,
which is what makes that a substitution rather than a re-derivation. The
`onRename` hook (the twin of `onDrop`) is what lets `Collection` hand back an
instance for the new name: it evicts BOTH cache entries, because the source
instance is bound to a table that is gone and any instance already opened under
the target name was bound to the table the rename replaced.

### Transactions

`db.withTransaction(work)` is a CALLBACK, not a session object: `node:sqlite` is
synchronous, so nothing interleaves between statements and there is no
concurrency for a session to coordinate. Nesting uses SAVEPOINT, because SQLite
has no nested `BEGIN`. (A session object exists too, for ported MongoDB code —
see Sessions below. It runs on these same primitives, and does NOT nest, because
a server's does not.)

**Non-obvious detail — `ROLLBACK TO` does not pop the savepoint.** It rewinds
but leaves the savepoint on the stack, so it must be `RELEASE`d too or the next
release unwinds the wrong one.

**Non-obvious detail — DDL is transactional, so a rollback can delete a table.**
Opening a collection for the FIRST time inside a transaction runs its
`CREATE TABLE`; if that transaction rolls back, the table goes with it and the
cached `Collection` points at nothing ("no such table" on the next call).
`withTransaction` therefore CLEARS the collection cache on rollback. The same
hazard is why `drop()` and `dropDatabase()` evict the cache.

**Non-obvious detail — a failed COMMIT must leave the frame open.**
`withTransaction` is `enterTransaction` + `commitFrame`/`rollbackFrame`, split
so `ClientSession` can use the halves separately. `commitFrame` deliberately
does NOT close the frame in a `finally`: if the COMMIT throws, the catch arm's
`rollbackFrame` still has something to roll back, and `closed` is what keeps the
depth from being given up twice.

### Sessions (src/client-session.ts)

`client.startSession()` exists for ONE shape — `session.withTransaction(work)`
with `{ session }` on every operation — because that is how MongoDB transaction
code is written and rewriting it is what the shim exists to avoid.

**A session is a ROUTING token on MongoDB and only a CHECKED one here.** `BEGIN`
belongs to the connection, so an operation cannot be steered into or out of a
transaction; what a session can do is refuse the operations whose answer would
differ. `ClientSession.enlist(session, host)` is that check, called once by
every public `Collection`/`Db` method — including with NO session, which is the
case `strict` cares about.

**Non-obvious detail — the transaction opens LAZILY, on the first operation that
names the session.** That is not an optimisation: it is what makes the
divergence exactly the detectable set. A write BEFORE that point genuinely is
outside the transaction on both engines (a server also starts one with its first
operation), so nothing is wrong to report; a write after it takes part where
MongoDB would not, and `host.activeSession` being set is precisely the signal
`strict` raises on. Eager BEGIN would also have nowhere to run — a session
belongs to a client, and a client can have several databases, each its own
connection.

**Non-obvious detail — `SessionHost` is how the session reaches the database.**
`Db` builds one and hands it to every `Collection` (like `onDrop`); it carries
`begin`/`commit`/`rollback`, `strict`, `activeSession`, and the `Db` itself as
an identity token for "a session may only be used on a database its own client
opened". `Collection` has no `Db` reference and `Db`'s transaction primitives
are private, so this is the seam — and it keeps `withTransaction` the only
public transaction shape.

**Non-obvious detail — `enlist` is a STATIC method.** It reads another
instance's `#`-private state, which a free function in the same module cannot
do (TypeScript's `private`/`#` is class-scoped, not module-scoped). The
alternative — public binding methods — would put the mechanism on the session's
own surface where a caller could drive it.

**Non-obvious detail — every delegating method forwards the session.**
`insertOne` → `insertMany`, `bulkWrite` → the single-document methods,
`updateMany` → `countDocuments`, `aggregate` → `find` and `$lookup`'s
collection. A delegated call that dropped it would look exactly like an
operation the caller forgot to enrol, and `strict` would refuse the library's
own internals. `Collection.enlist(options)` returns the narrowed `{ session }`
for that purpose.

**Non-obvious detail — there is deliberately no `session.transaction`.** The
driver has one at runtime but EXCLUDES it from its published types, so code
written against it here would stop compiling on a swap back to `mongodb` — the
exact drift the shim exists to prevent. `test/client-session.spec.ts` holding
both at one interface is what caught it. `inTransaction()` is the public
spelling.

### Change streams (src/change-stream.ts)

`watch()` on `Collection`, `Db` and `MongoClient`. **Events come from the WRITE
PATH, not from the engine** — BACKLOG item 26 asked whether SQLite could report
what changed, measured its way to no, and asked the wrong question: every write
here already goes through a `Collection` method that knows what it did.
`ChangeHub` is the per-connection bus, built by `Db` and handed to every
`Collection` exactly as `SessionHost` is.

**Non-obvious detail — an unwatched database must pay NOTHING**, and that is a
shape test, not a hope. Every write path asks `changes.watching` first and takes
its original statements when the answer is no;
[test/change-stream-boundaries.spec.ts](test/change-stream-boundaries.spec.ts)
asserts the compiled SQL contains no `RETURNING` in that case, the same trick
[test/query-plan.spec.ts](test/query-plan.spec.ts) uses for index eligibility.

**Non-obvious detail — the post-images come from `RETURNING`, so a watched
multi-document write is still ONE statement.** `UPDATE … RETURNING rowid, data`
and `DELETE … RETURNING rowid, data` hand back every row the statement touched;
under driver-seam rule 3 (every statement is a possible round trip) reading them
back separately would have doubled the cost. `updateMany`'s pre-images REPLACE
its `countDocuments`, so watching adds no statement there either. `RETURNING` is
the one SQL feature only this path needs — every engine DR-3 names has it.

**Non-obvious detail — `updateDescription` is built from the update SPEC, not
from a diff.** `updatedPaths` (src/update.ts) lists the paths an update writes
and each is then looked up in the new document; present means updated, absent
means removed, which is what makes `$unset` and a `$rename`'s source fall out
without a case each. A document diff would be WRONG:
`$set: { a: { b: 1, c: 2 } }` over an existing `a` reports `a`, not `a.b`/`a.c`.
The oracle settled two more rules: `$push`/`$addToSet` name the appended INDEX
(`tags.1`) when the array is genuinely extended, while `$pop`/`$pull` — and a
`$push` with `$position`/`$sort`/`$slice` — report the whole rebuilt array, at
any length (measured at 40 elements, so it is not a size heuristic).
`truncatedArrays` is always empty because no operator this library implements
produced one.

**Non-obvious detail — events are buffered per transaction and flushed on
COMMIT**, which is why `ChangeHub.enter`/`leave` pair with `Db`'s transaction
frames and with `insertMany`'s own batch transaction. An invalidate travels the
same path (a `PendingEvent` carrying what it ends) rather than going straight to
the streams — otherwise a `drop` inside a transaction that rolled back would
still have killed the stream.

**Non-obvious detail — every limit is an `invalidate`, never a silence.** Only
writes made through this library on this connection can be described. The other
two cases are DETECTED: `PRAGMA data_version` moves when another connection
commits and not for this one's own writes (measured), and `db.sql` is bracketed
by `total_changes()` because describing raw SQL would mean parsing it. Both end
the stream with `invalidateReason` set. The `data_version` check runs when a
reader is blocked (an unref'd poll, `pollIntervalMS`) and on every `tryNext()`.

**Non-obvious detail — the pipeline runs at READ time.** A change-stream stage
is per-event, so `$match` goes through `matchDocuments` (the `matchBatch` engine,
now shared) on a one-document batch rather than through a second JavaScript
matcher. Running it when the event is read keeps the write path synchronous, and
the stage list is MongoDB's own allow-list intersected with what this library
implements — the blocking stages could never complete over a stream that never
ends, which is why the server refuses them too.

**`resumeAfter`/`startAfter` are REFUSED, not approximated.** A resume token
points into an oplog. Accepting one would mean starting from now and calling it
a resume, which is the silent gap the whole design avoids. `clusterTime` is
absent for a related reason: it is a BSON Timestamp
[src/ejson.ts](src/ejson.ts) cannot store, describing a clock that does not
exist.

The one divergence `strict` polices: a positional update (`$`, `$[]`,
`$[<id>]`) while a stream is open, because MongoDB names the concrete element it
hit (`grades.1.score`) and this library can only name the array. Checked before
the write, so the refusal leaves the document alone.

### The MongoClient shim

`MongoClient` (src/mongo-client.ts) exists for ONE use case: a test suite
swapping `from 'mongodb'` for `from 'sqlite-document-db'` and changing nothing
else. Three decisions carry it:

**`db()` is SYNCHRONOUS, like the driver's**, which is what `Db.openSync`
exists for. That is a deliberate synchronous assumption — the driver-seam rule
says not to add them, and this one is added knowingly, documented on the method,
and will be a compile-time change when an async engine lands. Do NOT try to fake
it by unwrapping a promise: `.then()` on a resolved promise runs in a microtask,
so the value is not there yet.

**A `mongodb://` URI opens an in-memory database**, and connection options
(`maxPoolSize`, `tls`, …) are IGNORED. Both are leniencies the rest of the
library would not grant, and both are justified the same way: they describe a
network client that is not here, they cannot make an answer wrong, and refusing
them would mean editing the very line the shim exists to leave alone. An
unimplemented OPERATOR is a different thing and still throws.

**A file-backed client has ONE database.** A second `db(name)` on a file is an
error, not a second view of the same collections — that silent merge is exactly
what `tableNameFor` prevents one level down. It is also why a session's
transaction covers one database: each `db(name)` owns a connection.

`startSession()`/`withSession()` are real (see Sessions above), and so is
`watch()` (see Change streams above) — **no method on the shim throws any
more.** A client-wide `watch()` subscribes to the hub of every database the
client has opened AND of any opened later, which is why `MongoClient` keeps its
open streams: a cluster-wide stream on a real deployment sees collections
created after it started, and here a new database is a new connection.

[test/mongo-client.spec.ts](test/mongo-client.spec.ts) and
[test/client-session.spec.ts](test/client-session.spec.ts) run the same test
bodies through the shim AND the real driver, holding both at one structural
interface with no cast — so a drift in shape fails to compile rather than to
run.

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

- [test/global-setup.ts](test/global-setup.ts) boots the servers for the whole
  run and hands their URIs to the specs via Vitest's `provide`/`inject`. There
  are **two**: `mongoUri`, a standalone mongod that nearly every spec uses, and
  `mongoReplicaSetUri`, a one-node replica set that only
  [test/client-session.spec.ts](test/client-session.spec.ts) uses. MongoDB
  refuses transactions on a standalone, so without the replica set the session
  work would have had no oracle — but every write to one is slower, and pointing
  the whole suite at it took the run from 1.6s to 8.3s (measured). Two servers
  booting in parallel costs ~110ms and keeps both properties.
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

- Three specs deliberately run against this library **alone**, and say so at the
  top: [test/cursor.spec.ts](test/cursor.spec.ts) (statement lifetime has no
  MongoDB analogue), the rejection half of
  [test/collections.spec.ts](test/collections.spec.ts) (the driver defers name
  validation to the server) and
  [test/change-stream-boundaries.spec.ts](test/change-stream-boundaries.spec.ts)
  (a server has an oplog and so has none of these limits). Everything else is
  dual-engine — including every change EVENT, in
  [test/change-streams.spec.ts](test/change-streams.spec.ts), which is the
  second spec to inject `mongoReplicaSetUri`.
- [test/operators/operator-edge-cases.spec.ts](test/operators/operator-edge-cases.spec.ts)
  collects the compiler's edge cases — empty arrays, scalars where arrays were
  expected, malformed operators. When a query "returns nothing" or dies with a
  raw SQLite error, that is the file to extend.

### The stress suite (stress/)

`npm run stress` is the third measurement axis, beside the specs (correctness,
dual-engine) and `bench/` (query shapes over 20k SIMPLE documents). It runs
every feature over deliberately hostile documents — 180 levels deep, 500 fields
wide, three array levels, 5,000-element arrays, unicode traps — because **every
performance-shaped failure this library has had was a LIMIT, not a slow query**:
SQLite's parser recursion limit, the JavaScript stack, statement size, memory.

- **It asserts CEILINGS, never timings** ("it completed", "the SQL stayed under
  N bytes", "peak RSS stayed under N MB"), so a busy runner cannot fail it, and
  it prints a report for a human to read. `disableConsoleIntercept` is on
  because vitest hides console output from a PASSING run, which is the run whose
  numbers someone wants.
- **It is file-backed**, like `bench/`, for the same two reasons: fsync is where
  the problems have been, and a file is what people run.
- **The regression guards are structural, not temporal** — the negative-`$slice`
  test asserts the compiled SQL does not contain `json_array_length`, which is
  the same trick [test/query-plan.spec.ts](test/query-plan.spec.ts) uses for
  index eligibility. That is the pattern to follow when this suite finds
  something: turn the cause into a shape assertion.

Two findings from its first run are recorded in BACKLOG item 34; one (`$slice`)
was fixed on the spot, the other (dotted-path SQL is O(depth²), 65MB at 180
segments) is pinned as a known curve.

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
- **`cursor.hasNext()` PEEKS, and the peeked document is held.** There is no
  count to consult — the answer has to be about this cursor's remaining
  documents — so it reads one and `next()` returns it from the buffer. `close()`
  and `rewind()` both clear it. `tryNext()` is exactly `next()`: `node:sqlite` is
  synchronous, so there is never a document that exists but has not arrived yet.
- **`find().explain()` is async and `aggregate().explain()` is not**, and the
  asymmetry is the point: the first runs `EXPLAIN QUERY PLAN` (a statement), the
  second reports a split decided at compile time. Neither returns MongoDB's
  shape, which describes a query planner that is not here.
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
