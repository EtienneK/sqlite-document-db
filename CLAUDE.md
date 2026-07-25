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

Source files, and the second one is where all the interesting logic lives:

- [src/index.ts](src/index.ts) — the public API: `Db`, `Collection`, `FindCursor`.
- [src/query/query.ts](src/query/query.ts) — **the heart of the project.** Compiles
  MongoDB filter objects into SQLite `WHERE` clauses.
- [src/ejson.ts](src/ejson.ts) — storage serialization (see the EJSON gotcha below).
- [src/projection.ts](src/projection.ts) — MongoDB projection semantics, applied in JS.
- [src/errors.ts](src/errors.ts) — `MongoServerError` / `DUPLICATE_KEY_ERROR` (11000).
- [src/filter-types.ts](src/filter-types.ts) — `Filter<TSchema>` / `UpdateFilter<TSchema>`
  and the dot-notation path algebra behind them. Types only; no runtime code.
- [src/object-id.ts](src/object-id.ts) — generates MongoDB-compatible ObjectId hex strings.

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
`sqlite_master` — there is no separate metadata table. The plan-regression tests in
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
MongoDB accepts it as a filter-document key.

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
non-numeric targets with a SELECT that runs *before* the UPDATE
(`Collection.assertIncApplies`), not with a guard inside the UPDATE itself.
The obvious alternative — a `CASE` calling a registered SQL function that
throws — is **not portable**: on Node 22.13 (the `engines` floor) an exception
thrown inside a `db.function()` callback is swallowed and the call yields NULL,
so `json_set` wrote null over the value, causing the exact data loss the guard
existed to prevent. Node 26 propagates it. Don't reintroduce that pattern, and
don't assume a JS callback can fail a statement.

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
Adversarial-value coverage: [test/injection.spec.ts](test/injection.spec.ts).

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
- `insertMany` is not transactional, matching MongoDB's *ordered* insert: on a
  duplicate `_id` the documents already written stay written.
- **Storage is EJSON-for-Dates, not plain JSON** ([src/ejson.ts](src/ejson.ts), per
  DR-1). Dates are stored as `{"$date": "<ISO>"}` and revived on read; every other
  non-JSON type is rejected at write time with the offending path — **including a
  plain object of exactly that wrapper shape**, which would otherwise be revived as
  a Date (an *Invalid* Date, serialising to `null`, when the string is not one).
  Consequences:
  documents must go through `stringifyDocument`/`parseDocument`, never raw
  `JSON.stringify`/`parse`; date comparisons in [src/query/query.ts](src/query/query.ts)
  target the `field.$date` sub-path (ISO strings order lexicographically, which is what
  makes `$gt`/`$lt` work); `$in`/`$nin` with a Date rewrite to `$or`/`$nor` of
  equalities; and any future index over a date field must target the same `.$date`
  sub-path or it won't match.
