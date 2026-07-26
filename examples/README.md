# Examples

Every file here is runnable and is executed by CI on {ubuntu, windows} ×
Node {22.13, 24, 26} **and** under Deno — so if one of them is wrong, the build
goes red rather than the documentation quietly rotting.

```bash
npm run examples          # builds, then runs all of them in order
node examples/02-crud.mjs # or run one (needs `npm run build` first)
```

They import `../dist/index.js`, the local build — `npm run examples` builds
first, so a fresh clone works even though `dist/` is gitignored. In your own
code the import is just `import Db from 'sqlite-document-db'`.

| | What it covers |
| --- | --- |
| [01-quickstart.mjs](01-quickstart.mjs) | The smallest thing that does something |
| [02-crud.mjs](02-crud.mjs) | Insert, read, update, delete — and what each call reports |
| [03-query-operators.mjs](03-query-operators.mjs) | Comparison, logical, element and evaluation operators |
| [04-arrays-and-embedded.mjs](04-arrays-and-embedded.mjs) | Implicit element matching, `$all`, `$size`, `$elemMatch` |
| [05-indexes.mjs](05-indexes.mjs) | `createIndex` and friends with a before/after timing on 20k docs, `sparse`/partial indexes, `hint`, and `find().explain()` |
| [06-cursors-sort-projection.mjs](06-cursors-sort-projection.mjs) | Streaming, sorting, paging, choosing fields, and `hasNext`/`map`/`rewind`/`count` |
| [07-dates.mjs](07-dates.mjs) | Storing and querying `Date`, and what gets rejected |
| [08-upsert-and-find-modify.mjs](08-upsert-and-find-modify.mjs) | `upsert`, `$setOnInsert`, `findOneAndUpdate`/`Replace`/`Delete` |
| [09-errors.mjs](09-errors.mjs) | Duplicate keys (`11000`), and the mistakes that are refused |
| [10-persistence.mjs](10-persistence.mjs) | File-backed databases, `debug`, and the one concurrency caveat |
| [11-typed.ts](11-typed.ts) | TypeScript schemas — including what deliberately does *not* compile |
| [12-array-updates.mjs](12-array-updates.mjs) | `$push`/`$pull`/`$addToSet`/`$pop`, and the `$each`+`$sort`+`$slice` capped-list idiom |
| [13-aggregate.mjs](13-aggregate.mjs) | `$group`, `$unwind`, `$project`, and `explain()` on which stages reach SQLite |
| [14-transactions-and-joins.mjs](14-transactions-and-joins.mjs) | `withTransaction`, `bulkWrite`, `$lookup`, and the admin surface |
| [15-raw-sql.mjs](15-raw-sql.mjs) | `db.sql` — window functions and CTEs, bound values, raw rows |
| [16-mongo-client.mjs](16-mongo-client.mjs) | The `MongoClient` shim and `startSession()` — swapping one import for a test suite |
| [17-change-streams.mjs](17-change-streams.mjs) | `watch()`, event pipelines, and the `invalidate` that marks the edge of what a stream can see |
| [deno.ts](deno.ts) | The same quickstart, run by Deno |

## Deno

The library works under Deno because Deno implements `node:sqlite`, including
the custom-function support `$regex` needs. Run any example with:

```bash
deno run --allow-read --allow-write --allow-env examples/run-all.mjs
```

One caveat, specific to these examples rather than to the library: they import a
file path, and Deno does not map `./x.js` to its sibling `./x.d.ts`, so
`deno check` cannot type them. Depending on the package normally
(`import Db from 'npm:sqlite-document-db'`) resolves types through `package.json`
as usual.
