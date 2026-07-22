# sqlite-document-db

A MongoDB-style document database implemented on top of SQLite's JSON functions.
Zero runtime dependencies; ESM only; requires Node >= 22.5 for `node:sqlite`.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Full suite (vitest). Takes ~60s — it boots real MongoDB servers. |
| `npm run test:watch` | Watch mode |
| `npm run lint` | oxlint |
| `npm run typecheck` | `tsc` over `src` **and** `test` |
| `npm run build` | Emits `dist/` from `src` only (`tsconfig.build.json`) |

## Architecture

Three source files, and the middle one is where all the interesting logic lives:

- [src/index.ts](src/index.ts) — the public API: `Db`, `Collection`, `FindCursor`.
- [src/query/query.ts](src/query/query.ts) — **the heart of the project.** Compiles
  MongoDB filter objects into SQLite `WHERE` clauses.
- [src/object-id.ts](src/object-id.ts) — generates MongoDB-compatible ObjectId hex strings.

### Storage model

Each collection is a table `collection_<name>` with a single `data JSON` column —
one document per row. A unique index on `json_extract(data, '$._id')` enforces
`_id` uniqueness. Collection names are validated against `/^[a-z_]+[a-z0-9_]*$/`
and lowercased, because they are interpolated straight into SQL.

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

### SQL injection posture

`query.ts` builds SQL by string interpolation, not bound parameters. Values go
through `quote()`, which doubles `'`, and identifiers through `quote2()`, which
doubles `"`. Collection names are regex-validated. **If you add an operator,
route every user-supplied value through `quote()`** — do not interpolate raw.

## Testing approach

This is the project's best idea and is worth preserving: **every assertion runs
twice, once against this library and once against a real MongoDB** booted
in-memory by `mongodb-memory-server`. Each spec loops
`for (const dbName of ['Sqlite', 'Mongodb'])` and swaps the `db()` accessor.
MongoDB is the oracle — if an assertion is wrong, the Mongodb variant fails too,
which immediately tells you the *test* is wrong rather than the implementation.

Consequences to keep in mind:

- Tests are slow (~60s) and spawn `mongod` per spec via `beforeEach`. Don't
  mistake this for a hang.
- `fileParallelism: false` in [vitest.config.ts](vitest.config.ts) is deliberate;
  parallel specs contend for RAM and mongod ports.
- Vitest runs with `globals: true` so the Jest-era `describe`/`it`/`expect` in
  the specs work unchanged.
- `test/index.spec.ts` has a `byId()` helper. It exists because this library
  types `_id` as `string` while the MongoDB driver types it as `ObjectId`; the
  `Db | Mdb` union accepts neither, so id filters bypass it via `any`.

Some assertions are commented out with `// TODO` (see
[test/operators/query-operators.spec.ts](test/operators/query-operators.spec.ts)).
These are genuinely unimplemented features, not flaky tests — the largest is
implicit array-element matching (`{ tags: 'B' }` matching an array containing
`'B'`).

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
- `insertMany` **mutates the input documents**, assigning `_id` in place. This
  matches the MongoDB driver, and several tests assert on the mutated objects.
- `insertMany` is not transactional, matching MongoDB's *ordered* insert: on a
  duplicate `_id` the documents already written stay written.
- `backup/` holds an older abandoned implementation. It is excluded from the
  build, typecheck and lint. Don't treat it as live code.
