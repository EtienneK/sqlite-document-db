/**
 * `Collection` - the CRUD, query, index and aggregation surface.
 *
 * Split out of index.ts, which had grown to hold the public types, this class
 * and `Db` all at once. Everything that decides HOW a statement is built lives
 * in the compiler modules (query.ts, update.ts, aggregate.ts); this file is
 * where those get turned into statements and run.
 */

import { createHash } from 'node:crypto'
import { compileStages, splitPipeline } from './aggregate.js'
import {
  ChangeHub, ChangeStream, changeEvent, updateDescriptionFor, type ChangeHubHost
} from './change-stream.js'
import { ClientSession } from './client-session.js'
import type { Driver, DriverRow, DriverStatement } from './driver.js'
import { compareBson } from './bson-order.js'
// Documents round-trip through the EJSON layer, not plain JSON: Dates are
// stored as {"$date": ...} and unstorable types are rejected (BACKLOG DR-1).
import { parse as parseDocument, stringify as stringifyDocument } from './ejson.js'
import { attach, toMongoError, withPartialResult } from './errors.js'
import type { AnyBulkWriteOperation, Filter, UpdateFilter } from './filter-types.js'
import { objectIdHexString } from './object-id.js'
import { compileProjection, type CompiledProjection, type ProjectionSpec } from './projection.js'
import {
  bindRaw, createBindings, firstMatchingElementSql, quoteIdentifier, toJson1PathString, toSortSql, toSql,
  type CompileOptions, type SqlParams
} from './query.js'
import type {
  AggregateOptions, AggregationCursor, AnyFilter, BulkWriteOptions,
  BulkWriteResult, ChangeStreamNamespace, ChangeStreamOptions, CountOptions, CreateIndexOptions,
  Cursor, DbOptions, DeleteOptions, DeleteResult,
  DistinctOptions, Document, DropCollectionOptions, DropIndexOptions,
  EstimatedDocumentCountOptions, InsertManyOptions, FindCursor, FindOneAndDeleteOptions,
  FindOneAndReplaceOptions, FindOneAndUpdateOptions, FindOptions, IndexDescription,
  IndexDescriptionInput, IndexDirection,
  IndexSpecification, InsertManyResult, InsertOneOptions, InsertOneResult, ListIndexesOptions,
  QueryExplanation, RenameOptions, ReplaceOptions, SessionHost, SessionLike, SessionOption,
  SortSpecification, UpdateOptions, UpdateResult, WithId, WithoutId
} from './types.js'
import {
  buildUpdateExpression, buildUpsertDocument, collectEqualities, updatedPaths, writesThroughPositional,
  type UpdateCompileOptions, type UpdateExpression
} from './update.js'

/** The driver's UpdateResult shape for a write that did not upsert. */
function updateResult (matchedCount: number, modifiedCount: number): UpdateResult {
  return { acknowledged: true, matchedCount, modifiedCount, upsertedCount: 0, upsertedId: null }
}

/** Column alias for a projection probe's answer. See firstMatchingElementSql. */
const PROBE_COLUMN = '_sdb_probe'

/**
 * What the update compiler needs from the call: the filter (which is where `$`
 * finds the element it writes to) and `arrayFilters` (which is what
 * `$[<identifier>]` selects with).
 */
function compileOptionsFor (filter: unknown, options: { arrayFilters?: Document[] }): UpdateCompileOptions {
  return {
    filter: (filter ?? {}) as Record<string, any>,
    ...(options.arrayFilters === undefined ? {} : { arrayFilters: options.arrayFilters })
  }
}

function assertLimit (count: number): void {
  if (typeof count !== 'number' || !Number.isFinite(count)) throw Error(`limit must be a finite number; but got: ${String(count)}`)
}

function assertSkip (count: number): void {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw Error(`skip must be a non-negative finite number; but got: ${String(count)}`)
  }
}

/**
 * One stored value as a JSON TEXT fragment, so a single decoder handles every
 * type distinct() can return. The CASE is what keeps booleans and nulls from
 * arriving as SQLite's 1/0/NULL - `json_quote` renders JSON `true` as the
 * integer 1, which would come back from distinct() as the number.
 */
function asJsonText (typeExpr: string, valueExpr: string): string {
  return `CASE ${typeExpr} WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' ` +
    `ELSE json_quote(${valueExpr}) END`
}

/**
 * The `SELECT data … ORDER BY … LIMIT/OFFSET` a leading find/aggregate stage
 * runs. Shared by `find()`'s statement builder and the SQL that
 * `AggregationCursor.explain()` reports, so the two cannot drift on the fiddly
 * bits - MongoDB's `limit(0)` means "no limit" (SQLite's -1) and a negative
 * limit its absolute value. `extraColumns` carries find()'s projection probes;
 * aggregation has none.
 */
function leadingSelectSql (
  from: string, extraColumns: string, whereSql: string, orderBy: string,
  limit: number | null | undefined, skip: number | null | undefined
): string {
  let sql = `SELECT data${extraColumns} FROM ${from} WHERE (${whereSql}) ORDER BY ${orderBy}`
  if (limit != null || skip != null) {
    const bounded = limit == null || limit === 0 ? -1 : Math.trunc(Math.abs(limit))
    sql += ` LIMIT ${bounded}`
    if (skip != null && skip !== 0) sql += ` OFFSET ${Math.trunc(skip)}`
  }
  return sql
}

/**
 * Makes each `$match`-after-`$group` temp table uniquely named, so a pipeline
 * iterated while another one is mid-flight cannot drop the other's table.
 */
let matchBatchSequence = 0

/**
 * `cursor.map(fn)` - a cursor over transformed documents.
 *
 * It is a plain `Cursor`, not a `FindCursor`, because the sort/limit/skip
 * setters no longer make sense once the documents have been reshaped. The
 * driver's `map()` returns its `AbstractCursor` for the same reason.
 */
function mapCursor <TSource, TResult>(source: Cursor<TSource>, transform: (doc: TSource) => TResult): Cursor<TResult> {
  const next = async (): Promise<TResult | null> => {
    const document = await source.next()
    return document === null ? null : transform(document)
  }
  const mapped: Cursor<TResult> = {
    next,
    tryNext: next,
    hasNext: async () => await source.hasNext(),
    close: async () => { await source.close() },
    async toArray () {
      const documents: TResult[] = []
      let document: TResult | null
      while ((document = await next()) !== null) documents.push(document)
      return documents
    },
    async forEach (fn) {
      for await (const document of mapped) await fn(document)
    },
    async * [Symbol.asyncIterator] () {
      try {
        let document: TResult | null
        while ((document = await next()) !== null) yield document
      } finally {
        await mapped.close()
      }
    }
  }
  return mapped
}

function noSessionsHere (): never {
  throw Error('this collection was not opened by a client, so it has no sessions')
}

/**
 * The session host for a `Collection` nobody handed one to - one built directly
 * rather than through `db.collection()`.
 *
 * `database` is a fresh object, so no client owns it and every session is
 * refused as foreign, which is the truth: a session belongs to the client that
 * created it, and this collection came from no client. Its transaction hooks
 * are unreachable for the same reason.
 */
function detachedSessionHost (dbOptions: DbOptions): SessionHost {
  return {
    database: {},
    strict: dbOptions.strict,
    activeSession: null,
    begin: noSessionsHere,
    commit: noSessionsHere,
    rollback: noSessionsHere
  }
}

/**
 * What a `ChangeHub` needs from a connection, for a `Collection` nobody handed
 * one to - the twin of `detachedSessionHost` above.
 *
 * `Db` builds the real one and shares it with every collection it opens, so
 * that `db.watch()` sees writes to all of them. One built here belongs to this
 * collection alone, which is the truth about a `Collection` built by hand.
 */
export function changeHubHost (db: Driver, options: DbOptions, scope: string): ChangeHubHost {
  return {
    databaseName: options.databaseName ?? '',
    dataVersion: () => {
      try {
        const row = db.prepare('PRAGMA data_version').get() as { data_version: number } | undefined
        return row === undefined ? null : Number(row.data_version)
      } catch {
        // An engine without this pragma simply cannot report another
        // connection's writes; a stream on it is scoped to this one.
        return null
      }
    },
    match: (filter, docs) => matchDocuments(db, options, scope, filter, docs)
  }
}

/**
 * Applies a filter to documents that are no longer rows in a collection - what
 * a `$match` after a `$group` needs, and what a `$match` in a `watch()`
 * pipeline needs.
 *
 * The batch goes into a TEMP table and back through the ordinary query
 * compiler, rather than through a JavaScript re-implementation of the filter
 * language. A second matcher would be a second set of semantics to keep in
 * step with the first, and every quirk pinned down in the specs (implicit
 * array matching, the dotted-array-path rule, Date comparison through
 * `.$date`) would have to be reproduced and would eventually drift.
 */
export function matchDocuments (
  db: Driver, options: DbOptions, scope: string, filter: AnyFilter, docs: Document[]
): Document[] {
  const name = `aggmatch_${scope}_${matchBatchSequence++}`
  const table = quoteIdentifier(name)
  const exec = (sql: string): void => {
    if (options.debug) console.log(sql)
    db.exec(sql)
  }
  const prepare = (sql: string): DriverStatement => {
    if (options.debug) console.log(sql)
    return db.prepare(sql)
  }

  // TEMP, so it never touches the user's schema and disappears with the
  // connection even if something below throws.
  exec(`CREATE TEMP TABLE ${table} (data JSON)`)
  try {
    const insert = prepare(`INSERT INTO ${table} VALUES(json(?))`)
    for (const doc of docs) insert.run([stringifyDocument(doc)])
    const compiled = toSql('data', filter, { table, strict: options.strict })
    const rows = prepare(`SELECT data FROM ${table} WHERE (${compiled.sql}) ORDER BY rowid`)
      .all(compiled.params) as Array<{ data: string }>
    return rows.map(row => parseDocument(row.data))
  } finally {
    exec(`DROP TABLE IF EXISTS ${table}`)
  }
}

/**
 * `sparse` and `partialFilterExpression`, carried in a trailing SQL comment on
 * the CREATE INDEX statement.
 *
 * They cannot be read back out of the compiled predicate - a filter document is
 * not recoverable from the SQL it became - and there is no metadata table for
 * indexes (see the registry note above; the one that exists is for collection
 * NAMES). SQLite stores the text of a CREATE statement verbatim in
 * `sqlite_master`, comments included, and rewrites the table name in it on
 * `ALTER TABLE ... RENAME`, so the comment survives everything the index does.
 *
 * Every `*` in `JSON.stringify` output is inside a string literal, so escaping
 * it as `*` keeps a field name containing the comment terminator from
 * ending the comment early.
 */
const INDEX_META = /\/\* sdb-index (.*) \*\/\s*$/

function indexMetaComment (options: { sparse?: boolean, partialFilterExpression?: Document }): string {
  const meta: Document = {}
  if (options.sparse === true) meta.sparse = true
  if (options.partialFilterExpression != null) meta.partialFilterExpression = options.partialFilterExpression
  if (Object.keys(meta).length === 0) return ''
  return ` /* sdb-index ${JSON.stringify(meta).replaceAll('*', '\\u002a')} */`
}

function readIndexMeta (sql: string): Document {
  const encoded = INDEX_META.exec(sql)?.[1]
  if (encoded === undefined) return {}
  try {
    return JSON.parse(encoded) as Document
  } catch {
    // An index created by hand, or by a version that wrote something else.
    return {}
  }
}

/** Names SQLite cannot fold or mangle, so they can be used as a table name verbatim. */
const UNAMBIGUOUS_NAME = /^[a-z0-9_]+$/

/**
 * The physical table name backing a collection.
 *
 * SQLite compares identifiers case-INSENSITIVELY, so quoting alone is not
 * enough: `"collection_Users"` and `"collection_users"` are the same table,
 * which would reintroduce the silent merge this is meant to remove. A name
 * that is already lowercase and alphanumeric maps to a readable
 * `collection_<name>`; every other name goes into a separate `collectionx_`
 * namespace carrying a digest of the EXACT name, which is what keeps casings
 * (and any other character SQLite folds) apart. The slug is decoration - the
 * digest is what makes the name unique.
 */
export function tableNameFor (name: string): string {
  if (UNAMBIGUOUS_NAME.test(name)) return `collection_${name}`
  const slug = name.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return `collectionx_${slug}_${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
}

/**
 * Rejects collection names MongoDB rejects, and nothing else.
 *
 * The old rule (`/^[a-z_]+[a-z0-9_]*$/`, applied after lowercasing the name)
 * existed because the name was interpolated raw into SQL. It rejected ordinary
 * names like `my-data`, and - worse - silently merged `Users` and `users` into
 * one collection. Identifiers are quoted now (and disambiguated by
 * tableNameFor), so only MongoDB's own restrictions remain, plus SQLite's
 * reserved table prefix.
 */
export function assertValidCollectionName (name: string): void {
  if (typeof name !== 'string' || name === '') throw Error('collection name must be a non-empty string')
  if (name.includes('\0')) throw Error('collection name must not contain a null character')
  if (name.includes('$')) throw Error(`collection name must not contain '$': ${name}`)
  if (name.startsWith('system.')) throw Error(`collection name must not start with 'system.': ${name}`)
  if (name.toLowerCase().startsWith('sqlite_')) throw Error(`collection name must not start with 'sqlite_': ${name}`)
  if (name.length > 200) throw Error('collection name must be at most 200 characters')
}

/**
 * Table holding the collection-name registry.
 *
 * `tableNameFor` is deliberately NOT reversible for awkward names: they map to
 * `collectionx_<slug>_<digest>`, and the digest is what keeps `Users` and
 * `users` apart on a SQLite that compares identifiers case-insensitively. That
 * is the right trade for storage and the wrong one for `listCollections()`,
 * which has to answer with the name the caller used - so the mapping is
 * recorded here when a collection is opened.
 *
 * A database written by an older version has no rows here. Simple names are
 * still listed, because `collection_<name>` IS reversible; an awkward one
 * reappears the moment anything opens it. Nothing reads data through this
 * table, so a missing row costs a listing entry and never a document.
 */
const REGISTRY_TABLE = '_sdb_collections'

/** Prefixes `tableNameFor` can produce, and nothing else in the schema uses. */
const COLLECTION_TABLE_PREFIXES = ['collection_', 'collectionx_']

function ensureRegistry (db: Driver): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(REGISTRY_TABLE)} (tbl TEXT PRIMARY KEY, name TEXT NOT NULL)`)
}

/** Records that `table` holds the collection called `name`. */
function registerCollection (db: Driver, table: string, name: string): void {
  ensureRegistry(db)
  db.prepare(`INSERT OR REPLACE INTO ${quoteIdentifier(REGISTRY_TABLE)} (tbl, name) VALUES (?, ?)`).run([table, name])
}

/** Forgets `table`, so a dropped collection stops being listed. */
export function unregisterCollection (db: Driver, table: string): void {
  ensureRegistry(db)
  db.prepare(`DELETE FROM ${quoteIdentifier(REGISTRY_TABLE)} WHERE tbl = ?`).run([table])
}

/** Every physical table backing a collection. */
export function collectionTables (db: Driver): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  return rows.map(row => row.name)
    .filter(name => COLLECTION_TABLE_PREFIXES.some(prefix => name.startsWith(prefix)))
}

/** The collection names in this database, in the order SQLite lists their tables. */
export function collectionNames (db: Driver): string[] {
  ensureRegistry(db)
  const registered = new Map<string, string>()
  for (const row of db.prepare(`SELECT tbl, name FROM ${quoteIdentifier(REGISTRY_TABLE)}`).all() as Array<{ tbl: string, name: string }>) {
    registered.set(row.tbl, row.name)
  }

  const names: string[] = []
  for (const table of collectionTables(db)) {
    const known = registered.get(table)
    if (known !== undefined) names.push(known)
    // `collection_<name>` round-trips; `collectionx_` without a row does not,
    // and is skipped rather than reported under its mangled physical name.
    else if (table.startsWith('collection_')) names.push(table.slice('collection_'.length))
  }
  return names.toSorted()
}

/** Removes the registry itself - for dropDatabase, which leaves nothing behind. */
export function dropRegistry (db: Driver): void {
  db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(REGISTRY_TABLE)}`)
}

export class Collection<TSchema extends Document = Document> {
  /** The name this collection was opened with, as the MongoDB driver exposes it. */
  readonly collectionName: string

  private readonly db: Driver
  private readonly dbOptions: DbOptions
  /** Physical table name, unquoted - for sqlite_master lookups and index names. */
  private readonly name: string
  /** Physical table name, quoted - for interpolation into SQL. */
  private readonly table: string
  /** What every filter compiled against this collection is compiled with. */
  private readonly compileOptions: CompileOptions
  /** Evicts this collection from its `Db`'s cache. See drop(). */
  private readonly onDrop: () => void
  /**
   * Opens the collection a `rename()` moved the data to, through the `Db` that
   * made this one - which is the only thing that can hand back a cached
   * instance under the new name. A `Collection` built by hand gets a detached
   * one, matching how it got here.
   */
  private readonly onRename: (target: string) => Collection<any>
  /**
   * Where `{ session }` is checked, and where a session's transaction is
   * opened. Supplied by the `Db` that made this collection; a `Collection`
   * built by hand gets a detached one, which accepts no session at all -
   * sessions come from a `MongoClient`, and that client owns no such database.
   */
  private readonly sessions: SessionHost
  /**
   * Where change events go, and the thing every write path asks before doing
   * any change-stream work at all. Shared with the `Db` that opened this
   * collection, so `db.watch()` sees every collection on the connection.
   */
  private readonly changes: ChangeHub

  constructor (
    name: string, db: Driver, dbOptions: DbOptions, onDrop: () => void = () => {},
    sessions: SessionHost = detachedSessionHost(dbOptions),
    onRename?: (target: string) => Collection<any>,
    changes?: ChangeHub
  ) {
    assertValidCollectionName(name)

    this.db = db
    this.dbOptions = dbOptions
    this.onDrop = onDrop
    this.onRename = onRename ?? (target => new Collection(target, db, dbOptions, () => {}, sessions, undefined, changes))
    this.sessions = sessions
    this.changes = changes ?? new ChangeHub(changeHubHost(db, dbOptions, tableNameFor(name)))
    this.collectionName = name
    this.name = tableNameFor(name)
    this.table = quoteIdentifier(this.name)
    this.compileOptions = { table: this.table, strict: dbOptions.strict }

    // node:sqlite is synchronous, so a collection is fully usable the moment
    // its constructor returns - no init promise to await on every call.
    this.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (data JSON)`)
    registerCollection(db, this.name, name)
    this.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`ux_${this.name}_doc_id`)} ON ${this.table}(json_extract(data, '$._id'))`)
  }

  private exec (sql: string): void {
    if (this.dbOptions.debug) console.log(sql)
    try {
      this.db.exec(sql)
    } catch (error) {
      throw this.mapError(error)
    }
  }

  private prepare (sql: string): DriverStatement {
    if (this.dbOptions.debug) console.log(sql)
    return this.db.prepare(sql)
  }

  /** Runs a prepared statement, reporting constraint failures the way MongoDB does. */
  private run (sql: string, params: SqlParams): { changes: number | bigint } {
    const statement = this.prepare(sql)
    try {
      return statement.run(params)
    } catch (error) {
      throw this.mapError(error)
    }
  }

  /**
   * Runs a write that reports the rows it touched, via `RETURNING`.
   *
   * That clause is what makes a watched `updateMany` or `deleteMany` still ONE
   * statement: the post-images come back from the statement that did the work
   * instead of from a second read. Only the change-stream paths use it, so an
   * engine without `RETURNING` supports everything else (see src/driver.ts).
   */
  private allRows (sql: string, params: SqlParams): DriverRow[] {
    const statement = this.prepare(sql)
    try {
      return statement.all(params)
    } catch (error) {
      throw this.mapError(error)
    }
  }

  /** Physical SQLite index name back to the name createIndex() handed out. */
  private mongoIndexName (physicalName: string): string {
    if (physicalName === `ux_${this.name}_doc_id`) return '_id_'
    // ixu_ is the companion that makes the documents MISSING a unique key
    // collide; a violation of it is a duplicate on the index the caller named.
    for (const prefix of [`ix_${this.name}_`, `ixd_${this.name}_`, `ixu_${this.name}_`]) {
      if (physicalName.startsWith(prefix)) return physicalName.slice(prefix.length)
    }
    return physicalName
  }

  private mapError (error: unknown): unknown {
    return toMongoError(error, this.collectionName, name => this.mongoIndexName(name))
  }

  /**
   * Checks the `{ session }` this call was given - or the absence of one, which
   * is the case `strict` cares about - and opens the session's transaction if
   * this is the first operation to name it. See src/client-session.ts.
   *
   * It returns the session back, narrowed to just that key, because every
   * method that delegates has to PASS IT ON: an internal `insertMany` called
   * without the session its `insertOne` was given would look exactly like an
   * operation the caller forgot to enrol, and `strict` would refuse it.
   */
  private enlist (options: SessionOption): { session?: SessionLike } {
    ClientSession.enlist(options.session, this.sessions)
    return options.session === undefined ? {} : { session: options.session }
  }

  /**
   * Rejects the update if any row it would touch violates one of its
   * preconditions - a non-numeric `$inc`/`$mul` target, a non-array `$push`
   * target - the way MongoDB rejects it, before writing anything.
   *
   * This is a separate SELECT rather than a guard inside the UPDATE on purpose.
   * The obvious alternative, a CASE that calls a registered SQL function to
   * raise, is not portable: on Node 22.13 (the `engines` floor) an exception
   * thrown inside a `db.function()` callback is SWALLOWED and the call yields
   * NULL, so `json_set` wrote null over the value - the exact data loss the
   * guard existed to prevent. Caught by CI's oldest-Node job.
   */
  /**
   * Under `strict`, rejects a sort whose key holds an ARRAY in any document.
   *
   * MongoDB sorts such a field by its smallest element ascending and its
   * largest descending; `toSortSql` ranks arrays as a group and compares them
   * as text, so the two disagree on the ORDER of a result set both consider
   * correct - the kind of difference a test suite discovers on the day it
   * moves to a real server. Statically undetectable, so this asks the data.
   */
  private assertSortable (sort: Record<string, number>): void {
    if (this.dbOptions.strict !== true) return
    for (const field of Object.keys(sort)) {
      const path = toJson1PathString([field])
      const found = this.prepare(
        `SELECT 1 AS found FROM ${this.table} WHERE json_type(data, ${path}) = 'array' LIMIT 1`
      ).get()
      if (found !== undefined) {
        throw Error(
          `strict: cannot sort by '${field}' - some documents hold an ARRAY there, and MongoDB would ` +
          'order those by their smallest (ascending) or largest (descending) element, which this library does not'
        )
      }
    }
  }

  private assertUpdateApplies (expr: UpdateExpression, scope: string, scopeParams: SqlParams): void {
    if (expr.guardSql === undefined) return
    const sql = `SELECT ${expr.guardSql} AS guard FROM ${this.table} WHERE (${scope}) AND ${expr.guardSql} IS NOT NULL LIMIT 1`
    // The guards' own parameters go in: a positional guard carries the
    // criterion it selects elements with, so guards are no longer parameterless
    // SQL. They are a SEPARATE registry from the update expression's, because
    // node:sqlite rejects a statement handed a parameter it does not use.
    const row = this.prepare(sql).get({ ...expr.guardParams, ...scopeParams }) as { guard: number } | undefined
    if (row === undefined) return
    throw Error(expr.guards[row.guard]!.message)
  }

  find (query: Filter<TSchema> = {}, options: FindOptions = {}): FindCursor<TSchema> {
    this.enlist(options)
    // The options form gets the same validation as the chainable setters -
    // limit and skip are interpolated into SQL, so a NaN arriving from
    // unvalidated caller input surfaced as "no such column: NaN".
    if (options.limit !== undefined) assertLimit(options.limit)
    if (options.skip !== undefined) assertSkip(options.skip)

    let sortSpec = options.sort
    let limitCount = options.limit
    let skipCount = options.skip
    let projectionSpec = options.projection
    let projector: CompiledProjection | undefined
    let rows: Iterator<unknown> | undefined
    let done = false
    /** The document `hasNext()` looked at. See `hasNext`. */
    let peeked: WithId<TSchema> | null = null

    // The SQL is built lazily on first iteration so the chainable
    // sort()/limit()/skip() modifiers can still contribute. One prepared
    // statement per cursor, streamed with iterate() so a cursor over a large
    // collection stays cheap.
    const buildStatement = (): { sql: string, params: SqlParams } => {
      // ORDER BY rowid (last) gives insertion order, matching MongoDB's
      // natural order in practice, and makes sorted ties deterministic. It is
      // safe for index use because comparison predicates compile to
      // `rowid IN (...)` subqueries, whose internal index searches the outer
      // ORDER BY cannot defeat (a bare scalar predicate + ORDER BY rowid, by
      // contrast, makes SQLite pick a rowid scan over a field index - measured).
      const normalizedSort = typeof sortSpec === 'string' ? { [sortSpec]: 1 } : sortSpec
      if (normalizedSort != null) this.assertSortable(normalizedSort)
      const orderBy = normalizedSort == null ? 'rowid' : `${toSortSql('data', normalizedSort)}, rowid`
      // One parameter registry for the filter AND the projection probes, so
      // the two sets of placeholders cannot collide in the same statement.
      const bindings = createBindings()
      // A hint is SQLite's `INDEXED BY`, and it has to sit on the table
      // reference the index would actually serve: inside the UNION arms when
      // the filter compiled to the rowid-union form of implicit array matching,
      // and on the outer FROM when it did not. Putting it on both would force a
      // full index scan of the outer table for every union query.
      const hinted = options.hint === undefined ? undefined : this.hintedTable(options.hint)
      const filter = toSql('data', query, { ...this.compileOptions, bindings, ...(hinted === undefined ? {} : { table: hinted }) })
      // $elemMatch / $ positional ask which element matched; the answer comes
      // back as extra columns of this same query rather than a second one.
      const probes = (projector?.probes ?? []).map((probe, index) =>
        `, ${firstMatchingElementSql('data', probe.path, probe.criterion, bindings)} AS ${PROBE_COLUMN}${index}`
      ).join('')
      const from = hinted !== undefined && !filter.usesRowidUnion ? hinted : this.table
      const sql = leadingSelectSql(from, probes, filter.sql, orderBy, limitCount, skipCount)
      return { sql, params: filter.params }
    }

    const assertNotStarted = (): void => {
      if (rows !== undefined || done) throw Error('Cursor is already initialized, cannot be modified')
    }

    const next = async (): Promise<WithId<TSchema> | null> => {
      if (peeked !== null) {
        const held = peeked
        peeked = null
        return held
      }
      return await read()
    }

    const read = async (): Promise<WithId<TSchema> | null> => {
      if (done) return null
      if (rows === undefined) {
        // Compiling here (not in find()) surfaces invalid projections as a
        // rejected promise, matching where the driver reports them. The filter
        // is passed too: the `$` positional operator reads the condition on the
        // projected array out of it.
        projector = projectionSpec == null ? undefined : compileProjection(projectionSpec, query)
        const { sql, params } = buildStatement()
        rows = this.prepare(sql).iterate(params)
      }
      const row = rows.next()
      if (row.done === true) {
        done = true
        return null
      }
      const columns = row.value as Record<string, unknown>
      const document = parseDocument(columns.data as string)
      if (projector === undefined) return document
      return projector.project(
        document,
        projector.probes.map((_, index) => columns[`${PROBE_COLUMN}${index}`] as number | null)
      )
    }

    const close = async (): Promise<void> => {
      done = true
      peeked = null
      rows?.return?.(undefined) // finalizes the underlying statement early
    }

    const cursor: FindCursor<TSchema> = {
      sort (spec: SortSpecification): FindCursor<TSchema> {
        assertNotStarted()
        sortSpec = spec
        return cursor
      },

      limit (count: number): FindCursor<TSchema> {
        assertNotStarted()
        assertLimit(count)
        limitCount = count
        return cursor
      },

      skip (count: number): FindCursor<TSchema> {
        assertNotStarted()
        assertSkip(count)
        skipCount = count
        return cursor
      },

      project (spec: ProjectionSpec): FindCursor<TSchema> {
        assertNotStarted()
        projectionSpec = spec
        return cursor
      },

      next,
      close,

      // node:sqlite is synchronous, so there is never a document that exists
      // but has not arrived yet - which is the whole of tryNext's job.
      tryNext: next,

      async hasNext (): Promise<boolean> {
        // Peeked rather than counted: the answer has to be about THIS cursor's
        // remaining documents, and reading one is the only way to know. It is
        // held back so the next `next()` still returns it.
        peeked ??= await read()
        return peeked !== null
      },

      async forEach (fn: (doc: WithId<TSchema>) => unknown): Promise<void> {
        for await (const document of cursor) await fn(document)
      },

      map <T>(transform: (doc: WithId<TSchema>) => T): Cursor<T> {
        return mapCursor(cursor, transform)
      },

      rewind (): void {
        // Finalize the statement and forget everything derived from it, so the
        // next read compiles again from the current sort/limit/skip - which the
        // chainable setters are free to change once more.
        rows?.return?.(undefined)
        rows = undefined
        projector = undefined
        peeked = null
        done = false
      },

      // An arrow, so `this` is still the collection: a method shorthand here
      // would bind it to the cursor object.
      count: async (): Promise<number> => await this.countDocuments(query, {
        // The cursor's own window, which is what the driver counts - its
        // `limit(2).count()` answers 2.
        ...options,
        ...(limitCount === undefined ? {} : { limit: limitCount }),
        ...(skipCount === undefined ? {} : { skip: skipCount })
      }),

      explain: async (): Promise<QueryExplanation> => {
        projector ??= projectionSpec == null ? undefined : compileProjection(projectionSpec, query)
        const { sql, params } = buildStatement()
        const steps = this.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>
        const plan = steps.map(step => step.detail)
        return {
          sql,
          params,
          plan,
          // Deduplicated: both arms of the implicit-array union name the same
          // index, and "which indexes serve this query" is the question.
          indexes: [...new Set(plan.flatMap(step => /\bUSING (?:COVERING )?INDEX (\S+)/.exec(step)?.[1] ?? []))]
        }
      },

      async toArray (): Promise<Array<WithId<TSchema>>> {
        const documents: Array<WithId<TSchema>> = []

        let document: WithId<TSchema> | null
        while ((document = await next()) !== null) {
          documents.push(document)
        }

        return documents
      },

      async * [Symbol.asyncIterator] (): AsyncIterableIterator<WithId<TSchema>> {
        try {
          let document: WithId<TSchema> | null
          while ((document = await next()) !== null) {
            yield document
          }
        } finally {
          // Breaking out of a for-await loop must not leak the statement.
          await close()
        }
      }
    }
    return cursor
  }

  /**
   * Runs an aggregation pipeline.
   *
   * The leading `$match`/`$sort`/`$skip`/`$limit` stages are compiled into one
   * SELECT - so a pipeline that starts with `$match` uses the same indexes
   * `find()` would - and everything after that runs in JavaScript over the
   * results. `cursor.explain()` reports where the boundary fell.
   *
   * This is a SUBSET of MongoDB's pipeline (see "Missing Features" in the
   * README); an unsupported stage, accumulator or expression operator is an
   * error rather than a silent no-op.
   */
  aggregate <TResult extends Document = Document>(
    pipeline: Document[] = [], options: AggregateOptions = {}
  ): AggregationCursor<TResult> {
    if (!Array.isArray(pipeline)) throw Error('aggregate expects an array of pipeline stages')
    const session = this.enlist(options)
    // Split (and therefore validate) eagerly, so a malformed pipeline throws
    // where it was written rather than on first iteration.
    const split = splitPipeline(pipeline)
    const stages = compileStages(
      split.jsStages,
      (filter, docs) => this.matchBatch(filter, docs),
      // $lookup's foreign collection, opened on THIS connection so the join
      // sees uncommitted work inside a withTransaction. It bypasses Db's cache
      // (a Collection has no reference to its Db) which costs one
      // CREATE TABLE IF NOT EXISTS per lookup - idempotent, and it keeps the
      // eager-creation behaviour `db.collection()` already has. It shares this
      // collection's session host, so the join is part of the same transaction.
      async (name, filter) => await new Collection(
        name, this.db, this.dbOptions, () => {}, this.sessions, undefined, this.changes
      ).find(filter, session).toArray(),
      this.dbOptions.strict
    )

    const source = this.find(split.filter as Filter<TSchema>, {
      ...session,
      ...(split.sort === undefined ? {} : { sort: split.sort }),
      ...(split.skip === undefined ? {} : { skip: split.skip }),
      ...(split.limit === undefined ? {} : { limit: split.limit })
    })

    let output: AsyncIterator<Document> | undefined
    let done = false

    const start = (): AsyncIterator<Document> => {
      let stream: AsyncIterable<Document> = source as AsyncIterable<Document>
      for (const stage of stages) stream = stage(stream)
      return stream[Symbol.asyncIterator]()
    }

    const next = async (): Promise<TResult | null> => {
      if (done) return null
      output ??= start()
      const step = await output.next()
      if (step.done === true) {
        done = true
        return null
      }
      return step.value as TResult
    }

    const close = async (): Promise<void> => {
      done = true
      await output?.return?.(undefined)
      await source.close()
    }

    let peeked: TResult | null = null

    const cursor: AggregationCursor<TResult> = {
      next: async () => {
        if (peeked === null) return await next()
        const held = peeked
        peeked = null
        return held
      },
      tryNext: async () => await cursor.next(),
      hasNext: async () => {
        peeked ??= await next()
        return peeked !== null
      },
      async forEach (fn) {
        for await (const document of cursor) await fn(document)
      },
      close,

      explain: () => ({
        sql: this.findSql(split.filter, split.sort, split.skip, split.limit),
        pushedDown: split.pushedDown,
        inJavaScript: split.jsStages.map(stage => Object.keys(stage)[0]!)
      }),

      async toArray (): Promise<TResult[]> {
        const documents: TResult[] = []
        let document: TResult | null
        while ((document = await cursor.next()) !== null) documents.push(document)
        return documents
      },

      async * [Symbol.asyncIterator] (): AsyncIterableIterator<TResult> {
        try {
          let document: TResult | null
          while ((document = await cursor.next()) !== null) yield document
        } finally {
          await close()
        }
      }
    }
    return cursor
  }

  /** See `matchDocuments`, which this and `watch()`'s `$match` share. */
  private matchBatch (filter: AnyFilter, docs: Document[]): Document[] {
    return matchDocuments(this.db, this.dbOptions, this.name, filter, docs)
  }

  /**
   * Watches this collection for changes (BACKLOG item 27).
   *
   * ```javascript
   * const stream = orders.watch([{ $match: { operationType: 'insert' } }])
   * for await (const event of stream) console.log(event.fullDocument)
   * ```
   *
   * Events are emitted by the write methods themselves, buffered inside a
   * transaction and published when it commits. What that can and cannot see is
   * set out on `ChangeStream` in src/change-stream.ts; the short version is
   * that writes made through this library on this connection are reported
   * exactly, and everything else ends the stream with an `invalidate` rather
   * than going unmentioned.
   */
  watch <TDocument extends Document = TSchema>(
    pipeline: Document[] = [], options: ChangeStreamOptions = {}
  ): ChangeStream<TDocument> {
    this.enlist(options)
    const stream = new ChangeStream<TDocument>(this.namespace, pipeline, options)
    stream.listenTo(this.changes)
    return stream
  }

  /** This collection, as a change event names it. */
  private get namespace (): Required<ChangeStreamNamespace> {
    return { db: this.dbOptions.databaseName ?? '', coll: this.collectionName }
  }

  /** Emits one change event for this collection. Callers check `changes.watching` first. */
  private emitChange (
    operationType: 'insert' | 'update' | 'replace' | 'delete' | 'drop' | 'rename',
    fields: Partial<Document> = {}
  ): void {
    this.changes.emit(changeEvent(operationType, { ns: this.namespace, ...fields }))
  }

  /**
   * Emits the `update` event for one row, from its two images and the update
   * that produced them.
   *
   * `updateDescription` is built from the update SPEC (`updatedPaths`) rather
   * than by diffing the documents, because that is what MongoDB reports - see
   * the comment on `updatedPaths` in src/update.ts.
   */
  private emitUpdate (before: Document, after: Document, update: AnyFilter): void {
    this.emitChange('update', {
      documentKey: { _id: after._id },
      updateDescription: updateDescriptionFor(updatedPaths(update), after, before),
      fullDocument: after,
      fullDocumentBeforeChange: before
    })
  }

  /**
   * Under `strict`, refuses an update whose `updateDescription` this library
   * cannot report the way a server would - which is only ever the positional
   * operators, and only while something is watching.
   *
   * MongoDB names the element the write actually hit (`'grades.1.score'`), and
   * that is knowable only after the statement has run. This library names the
   * array instead, which is a true statement about a different thing. Checked
   * BEFORE the write, so a refusal leaves the collection untouched.
   */
  private assertDescribableUpdate (update: AnyFilter): void {
    if (!this.changes.watching || this.dbOptions.strict !== true) return
    if (!writesThroughPositional(update)) return
    throw Error(
      'strict: this update writes through a positional operator ($, $[] or $[<identifier>]) while a change ' +
      "stream is open - MongoDB's updateDescription would name the element it hit (like 'grades.1.score') " +
      "and this library can only name the array ('grades')"
    )
  }

  /** The SELECT `find()` would build, for AggregationCursor.explain(). */
  private findSql (filter: AnyFilter, sort?: SortSpecification, skip?: number, limit?: number): string {
    const normalizedSort = typeof sort === 'string' ? { [sort]: 1 } : sort
    const orderBy = normalizedSort == null ? 'rowid' : `${toSortSql('data', normalizedSort)}, rowid`
    // The same builder find() runs through, so explain() cannot misreport the
    // statement shape - only the probes/hint find() adds are absent here.
    return leadingSelectSql(this.table, '', toSql('data', filter, this.compileOptions).sql, orderBy, limit, skip)
  }

  async findOne (filter: string | Filter<TSchema> = {}, options: FindOptions = {}): Promise<WithId<TSchema> | null> {
    // The string shorthand is an _id lookup; the cast is because a schema may
    // declare _id as something other than a string (see InferIdType).
    const query = typeof filter === 'string' ? { _id: filter } as Filter<TSchema> : filter
    // Delegates to find() with limit 1: same SQL shape (ORDER BY rowid LIMIT 1
    // returns the FIRST match in natural order, like MongoDB - updateOne/
    // deleteOne/replaceOne depend on this), plus sort/projection support.
    const cursor = this.find(query, { ...options, limit: 1 })
    const document = await cursor.next()
    await cursor.close()
    return document
  }

  /**
   * Creates a SQLite expression index over the given document fields and
   * returns its MongoDB-style name (e.g. `qty_1`, `size.uom_1_status_-1`).
   *
   * Index paths are built by the same code that builds query paths, so any
   * query on an indexed field is index-eligible. Up to three SQLite indexes
   * back one MongoDB index:
   *
   * - `ix_<table>_<name>` - the index itself.
   * - `ixd_<table>_<name>` - for a single-field index, a companion on
   *   `<field>.$date`, because Dates are stored as `{"$date": ...}` (see
   *   src/ejson.ts) and date comparisons query that sub-path.
   * - `ixu_<table>_<name>` - for a UNIQUE, non-sparse index, a companion that
   *   makes the documents MISSING the field collide with each other, which is
   *   what MongoDB does and what SQLite alone does not: a SQL unique index
   *   treats every NULL as distinct, so two documents without the field were
   *   both accepted. It is a partial index over `json_quote(...)`, which
   *   renders both a missing field and a stored JSON null as the text 'null' -
   *   the same conflation MongoDB makes.
   */
  async createIndex (spec: IndexSpecification, options: CreateIndexOptions = {}): Promise<string> {
    this.enlist(options)
    return this.buildIndex(spec, options)
  }

  /** `createIndex` for several indexes at once, returning the names in order. */
  async createIndexes (specs: IndexDescriptionInput[], options: CreateIndexOptions = {}): Promise<string[]> {
    this.enlist(options)
    if (!Array.isArray(specs) || specs.length === 0) {
      throw Error('createIndexes requires a non-empty array of index descriptions')
    }
    return specs.map(spec => {
      if (spec === null || typeof spec !== 'object' || spec.key == null) {
        throw Error("each createIndexes entry must be a document with a 'key'")
      }
      const { key, ...rest } = spec
      return this.buildIndex(key, rest)
    })
  }

  private buildIndex (spec: IndexSpecification, options: Omit<CreateIndexOptions, 'session'>): string {
    const key: Record<string, IndexDirection> = typeof spec === 'string' ? { [spec]: 1 } : spec
    const entries = Object.entries(key)
    if (entries.length === 0) throw Error('createIndex requires at least one field')
    for (const [field, direction] of entries) {
      if (field === '') throw Error('createIndex field names must be non-empty')
      if (direction !== 1 && direction !== -1) {
        throw Error(`unsupported index direction for field ${field}: ${String(direction)} (only 1 and -1 are supported)`)
      }
    }
    // Options are rejected rather than ignored, as they are on createCollection:
    // an index that silently is not what was asked for is worse than none.
    for (const option of Object.keys(options)) {
      if (['unique', 'name', 'sparse', 'partialFilterExpression', 'session'].includes(option)) continue
      throw Error(option === 'hidden'
        ? "createIndex does not support 'hidden': SQLite has no way to keep an index from its own planner, " +
          'so the option could only ever be ignored'
        : option === 'expireAfterSeconds'
          ? "createIndex does not support 'expireAfterSeconds': there is no background reaper here, and a TTL " +
            'that only expires on access is a different feature wearing the same name'
          : `createIndex does not support the '${option}' option`)
    }
    if (options.sparse === true && options.partialFilterExpression != null) {
      throw Error('createIndex takes sparse or partialFilterExpression, not both')
    }

    // MongoDB's generated name: `<field>_<direction>` pairs joined with '_'.
    const name = options.name ?? entries.map(([field, direction]) => `${field}_${direction}`).join('_')
    const unique = options.unique === true ? 'UNIQUE ' : ''
    const where = this.indexPredicate(entries, options)
    const suffix = `${where === undefined ? '' : ` WHERE ${where}`}${indexMetaComment(options)}`

    const columns = entries
      .map(([field, direction]) => `json_extract(data, ${toJson1PathString([field])}) ${direction === 1 ? 'ASC' : 'DESC'}`)
      .join(', ')
    this.exec(`CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(`ix_${this.name}_${name}`)} ON ${this.table} (${columns})${suffix}`)

    if (entries.length === 1) {
      const [field, direction] = entries[0]!
      const dateColumn = `json_extract(data, ${toJson1PathString([`${field}.$date`])}) ${direction === 1 ? 'ASC' : 'DESC'}`
      this.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`ixd_${this.name}_${name}`)} ON ${this.table} (${dateColumn})${suffix}`)
    }

    if (options.unique === true && options.sparse !== true) {
      // The documents whose key is entirely absent, made to collide. See the
      // method comment; `json_quote` of a missing path is the text 'null'.
      const quoted = entries.map(([field]) => `json_quote(json_extract(data, ${toJson1PathString([field])}))`).join(', ')
      const anyMissing = entries
        .map(([field]) => `json_extract(data, ${toJson1PathString([field])}) IS NULL`).join(' OR ')
      const scope = where === undefined ? `(${anyMissing})` : `(${anyMissing}) AND (${where})`
      this.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`ixu_${this.name}_${name}`)} ` +
        `ON ${this.table} (${quoted}) WHERE ${scope}`
      )
    }

    return name
  }

  /** The `WHERE` clause of a sparse or partial index, or undefined for neither. */
  private indexPredicate (entries: Array<[string, IndexDirection]>, options: Omit<CreateIndexOptions, 'session'>): string | undefined {
    if (options.sparse === true) {
      // A compound sparse index covers a document that has ANY of its fields,
      // which is MongoDB's rule.
      return entries.map(([field]) => `json_extract(data, ${toJson1PathString([field])}) IS NOT NULL`).join(' OR ')
    }
    if (options.partialFilterExpression == null) return undefined
    const filter = options.partialFilterExpression
    if (typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).length === 0) {
      throw Error('partialFilterExpression must be a non-empty filter document')
    }
    // No `table`, so implicit array matching cannot reach for its rowid-union
    // form (a subquery); `inline`, because CREATE INDEX has nothing to bind a
    // parameter to. Anything that would still need a subquery raises - see
    // INDEX_FILTER_OPS in src/query.ts.
    return toSql('data', filter, {
      bindings: createBindings('p', true), strict: this.dbOptions.strict, indexFilter: true
    }).sql
  }

  /** Drops an index by the name createIndex returned. Throws if it does not exist. */
  async dropIndex (name: string, options: DropIndexOptions = {}): Promise<void> {
    this.enlist(options)
    const physical = `ix_${this.name}_${name}`
    const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get([physical])
    if (found === undefined) throw Error(`index not found with name [${name}]`)
    this.exec(`DROP INDEX ${quoteIdentifier(physical)}`)
    for (const companion of [`ixd_${this.name}_${name}`, `ixu_${this.name}_${name}`]) {
      this.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(companion)}`)
    }
  }

  /** Drops every index except `_id_`, which MongoDB also refuses to remove. */
  async dropIndexes (options: DropIndexOptions = {}): Promise<void> {
    for (const description of await this.indexes(options)) {
      if (description.name === '_id_') continue
      await this.dropIndex(description.name, options)
    }
  }

  /** True when every named index exists, as the driver's `indexExists` answers. */
  async indexExists (names: string | string[], options: ListIndexesOptions = {}): Promise<boolean> {
    const existing = new Set((await this.indexes(options)).map(description => description.name))
    return (typeof names === 'string' ? [names] : names).every(name => existing.has(name))
  }

  /**
   * Lists indexes in (a subset of) MongoDB's shape:
   * `{ name, key, unique?, sparse?, partialFilterExpression? }`.
   *
   * The key spec is parsed back out of the CREATE INDEX statement in
   * `sqlite_master` - there is no metadata table for indexes. `sparse` and
   * `partialFilterExpression` cannot be recovered from the compiled predicate,
   * so `createIndex` writes them into a trailing SQL COMMENT, which SQLite
   * stores verbatim and rewrites along with the table name on a rename.
   */
  async indexes (options: ListIndexesOptions = {}): Promise<IndexDescription[]> {
    this.enlist(options)
    const rows = this.db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name"
    ).all([this.name]) as Array<{ name: string, sql: string | null }>

    const descriptions: IndexDescription[] = [
      { name: '_id_', key: { _id: 1 }, unique: true } // the index the constructor creates
    ]
    const prefix = `ix_${this.name}_`
    for (const row of rows) {
      if (!row.name.startsWith(prefix) || row.sql == null) continue
      const key: Record<string, IndexDirection> = {}
      // The path is a SQL string literal, so a quote inside a field name
      // arrives doubled - `(?:[^']|'')+` keeps the match from stopping there.
      for (const match of row.sql.matchAll(/json_extract\(data, '((?:[^']|'')+)'\) (ASC|DESC)/g)) {
        // '$.a.b[0]' back to the dotted field form 'a.b.0' used in queries.
        const field = match[1]!.replaceAll("''", "'").replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1')
        key[field] = match[2] === 'ASC' ? 1 : -1
      }
      descriptions.push({
        name: row.name.slice(prefix.length),
        key,
        ...(row.sql.startsWith('CREATE UNIQUE') ? { unique: true } : {}),
        ...readIndexMeta(row.sql)
      })
    }
    return descriptions
  }

  listIndexes (options: ListIndexesOptions = {}): { toArray: () => Promise<IndexDescription[]> } {
    return { toArray: async () => await this.indexes(options) }
  }

  /**
   * This collection's table, with `INDEXED BY` attached - SQLite's spelling of
   * a `hint`, and like MongoDB's it FAILS rather than falling back when the
   * index cannot serve the query ("no query solution").
   *
   * Both of MongoDB's spellings are accepted: the index NAME, or the key
   * pattern it was created from. An unknown one is an error rather than a
   * silently unhinted query, which is what a real server does too.
   */
  private hintedTable (hint: string | Record<string, IndexDirection>): string {
    if (hint === null || (typeof hint !== 'string' && typeof hint !== 'object')) {
      throw Error(`hint must be an index name or a key pattern; but got: ${typeof hint}`)
    }
    const name = typeof hint === 'string'
      ? hint
      : Object.entries(hint).map(([field, direction]) => `${field}_${direction}`).join('_')
    const physical = (name === '_id_' || name === '_id_1')
      ? `ux_${this.name}_doc_id`
      : `ix_${this.name}_${name}`
    const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get([physical])
    if (found === undefined) throw Error(`hint provided does not correspond to an existing index: ${name}`)
    return `${this.table} INDEXED BY ${quoteIdentifier(physical)}`
  }

  /**
   * The distinct values stored at `field` across the documents matching
   * `filter`, in MongoDB's BSON sort order.
   *
   * Two rules make this more than a `SELECT DISTINCT`:
   *
   * - **An array field contributes its ELEMENTS, not the array.** `distinct`
   *   follows the same implicit-array rule the query compiler does, so
   *   `distinct('tags')` over `{ tags: ['a','b'] }` yields `'a'` and `'b'`.
   *   That is why there are two arms below.
   * - **Values are compared as stored, then decoded.** Deduplication happens on
   *   the JSON text (where two equal Dates are one value, and `5` and `'5'` are
   *   two), and only the survivors are revived - comparing decoded `Date`
   *   objects would treat every one of them as distinct.
   *
   * Known divergence: a dotted path that crosses an array (`'instock.qty'`
   * where `instock` is an array) yields nothing here, where MongoDB descends
   * into it. `strict: true` rejects that rather than answering it.
   */
  async distinct (field: string, filter: Filter<TSchema> = {}, options: DistinctOptions = {}): Promise<any[]> {
    this.enlist(options)
    if (typeof field !== 'string' || field === '') throw Error('distinct requires a non-empty field name')
    this.assertDistinctPath(field)

    const path = toJson1PathString([field])
    const compiled = toSql('data', filter, this.compileOptions)

    const scalars = this.prepare(
      `SELECT DISTINCT ${asJsonText(`json_type(data, ${path})`, `json_extract(data, ${path})`)} AS v ` +
      `FROM ${this.table} WHERE (${compiled.sql}) ` +
      `AND json_type(data, ${path}) IS NOT NULL AND json_type(data, ${path}) != 'array'`
    ).all(compiled.params) as Array<{ v: string }>

    // The filter is applied in a derived table so the element arm never has to
    // resolve `data` or `rowid` across the json_each join.
    const elements = this.prepare(
      `SELECT DISTINCT ${asJsonText('json_each.type', 'json_each.value')} AS v ` +
      `FROM (SELECT data FROM ${this.table} WHERE (${compiled.sql}) AND json_type(data, ${path}) = 'array') AS src, ` +
      `json_each(src.data, ${path})`
    ).all(compiled.params) as Array<{ v: string }>

    const seen = new Set<string>()
    const values: unknown[] = []
    for (const row of [...scalars, ...elements]) {
      if (seen.has(row.v)) continue
      seen.add(row.v)
      values.push(parseDocument(row.v))
    }
    return values.toSorted(compareBson)
  }

  /**
   * Under `strict`, rejects a `distinct` whose path crosses an array.
   *
   * MongoDB descends into an array at every level of a dotted path, and
   * `json_extract` does not, so `distinct('instock.qty')` over an array of
   * embedded documents finds nothing here. Not statically knowable - like the
   * sort check, this asks the data.
   */
  private assertDistinctPath (field: string): void {
    if (this.dbOptions.strict !== true || !field.includes('.')) return
    const segments = field.split('.')
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join('.')
      const found = this.prepare(
        `SELECT 1 AS found FROM ${this.table} WHERE json_type(data, ${toJson1PathString([prefix])}) = 'array' LIMIT 1`
      ).get()
      if (found !== undefined) {
        throw Error(
          `strict: cannot take distinct '${field}' - some documents hold an ARRAY at '${prefix}', ` +
          'and MongoDB would descend into it where this library reads the path as missing'
        )
      }
    }
  }

  /**
   * Drops the collection, and its indexes with it.
   *
   * The cached `Collection` is evicted from the `Db` that made it (`onDrop`),
   * because this instance is bound to a table that no longer exists - without
   * that, `db.collection(name)` would hand back the same dead object and every
   * call on it would fail with "no such table" rather than recreating it.
   */
  async drop (options: DropCollectionOptions = {}): Promise<boolean> {
    this.enlist(options)
    this.exec(`DROP TABLE IF EXISTS ${this.table}`)
    unregisterCollection(this.db, this.name)
    this.onDrop()
    if (this.changes.watching) {
      // `drop` then `invalidate`, in that order, as the server emits them. Both
      // go through the hub, so a drop inside a transaction that rolls back
      // publishes neither.
      this.emitChange('drop')
      this.changes.emitInvalidate(this.namespace)
    }
    return true
  }

  /**
   * Renames the collection, returning a `Collection` bound to the new name.
   *
   * `ALTER TABLE ... RENAME TO` moves the data and repoints every index at the
   * new table - but the index NAMES embed the old table's, and `indexes()`
   * finds them by that prefix, so each one is recreated under the new name and
   * the old one dropped. SQLite keeps the text of a CREATE statement verbatim
   * and rewrites the table name inside it, which is what makes recreating them
   * a substitution rather than a re-derivation (and is why the `sdb-index`
   * comment survives too).
   *
   * This instance is bound to a table that no longer exists afterwards, so it
   * is evicted from its `Db`'s cache exactly as `drop()` does.
   */
  async rename (target: string, options: RenameOptions = {}): Promise<Collection<TSchema>> {
    this.enlist(options)
    assertValidCollectionName(target)
    if (target === this.collectionName) throw Error('renameCollection cannot rename a collection to itself')

    const targetTable = tableNameFor(target)
    const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get([targetTable])
    if (exists !== undefined) {
      if (options.dropTarget !== true) throw Error('target namespace exists')
      this.exec(`DROP TABLE ${quoteIdentifier(targetTable)}`)
      unregisterCollection(this.db, targetTable)
    }

    const indexes = this.db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
    ).all([this.name]) as Array<{ name: string, sql: string }>

    this.exec(`ALTER TABLE ${this.table} RENAME TO ${quoteIdentifier(targetTable)}`)
    unregisterCollection(this.db, this.name)
    registerCollection(this.db, targetTable, target)

    for (const index of indexes) {
      const renamed = index.name.replace(this.name, targetTable)
      if (renamed === index.name) continue
      // Re-read the SQL: ALTER TABLE has already rewritten the table name in
      // it, so only the index's own name is left to change.
      const current = this.db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get([index.name]) as { sql: string } | undefined
      if (current === undefined) continue
      this.exec(current.sql.replace(index.name, renamed))
      this.exec(`DROP INDEX ${quoteIdentifier(index.name)}`)
    }

    this.onDrop()
    if (this.changes.watching) {
      this.emitChange('rename', { to: { db: this.namespace.db, coll: target } })
      this.changes.emitInvalidate(this.namespace)
    }
    return this.onRename(target) as Collection<TSchema>
  }

  /**
   * Counts matching documents. `skip` and `limit` apply to the MATCHED set
   * before it is counted, as they do on the server - so `{ limit: 10 }` over
   * 500 matches answers 10, not 500.
   */
  async countDocuments (filter?: Filter<TSchema>, options: CountOptions = {}): Promise<number> {
    this.enlist(options)
    if (options.limit !== undefined) assertLimit(options.limit)
    if (options.skip !== undefined) assertSkip(options.skip)

    const hinted = options.hint === undefined ? undefined : this.hintedTable(options.hint)
    const compiled = toSql('data', filter ?? {}, {
      ...this.compileOptions, ...(hinted === undefined ? {} : { table: hinted })
    })
    const from = hinted !== undefined && !compiled.usesRowidUnion ? hinted : this.table
    let sql = `SELECT COUNT(*) AS count FROM ${from} WHERE (${compiled.sql})`
    if (options.limit !== undefined || options.skip !== undefined) {
      // LIMIT/OFFSET cannot sit next to an aggregate, so the window is taken
      // in a subquery and the rows THAT yields are what get counted.
      const limit = options.limit == null || options.limit === 0 ? -1 : Math.trunc(Math.abs(options.limit))
      const offset = options.skip == null ? '' : ` OFFSET ${Math.trunc(options.skip)}`
      sql = `SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${from} WHERE (${compiled.sql}) LIMIT ${limit}${offset})`
    }
    const result = this.prepare(sql).get(compiled.params) as { count: number }
    return Number(result.count)
  }

  /**
   * The number of documents in the collection, unfiltered.
   *
   * On a real server this reads collection metadata and can lag reality; here
   * it is an exact `COUNT(*)`, which is both cheaper and more accurate. The
   * method exists for API compatibility - `countDocuments()` says the same
   * thing and is the one to reach for.
   *
   * Divergence worth knowing: MongoDB REFUSES this one inside a transaction
   * ("Cannot run 'count' in a multi-document transaction"), because it reads
   * metadata rather than documents. Here it is an ordinary count and answers.
   */
  async estimatedDocumentCount (options: EstimatedDocumentCountOptions = {}): Promise<number> {
    this.enlist(options)
    const result = this.prepare(`SELECT COUNT(*) AS count FROM ${this.table}`).get() as { count: number }
    return Number(result.count)
  }

  /**
   * The first row matching `filter` in natural order (ORDER BY rowid, as
   * MongoDB's `updateOne`/`deleteOne` pick the first match).
   *
   * The single-document writes address their target by rowid rather than by
   * re-querying its `_id`. Re-querying meant compiling a second filter whose
   * behaviour depends on the id's TYPE - and with an array `_id` the implicit
   * array-element rule made `{ _id: [...] }` match sibling documents too, so
   * `deleteOne` could remove more than one row.
   */
  private findOneRow (filter: AnyFilter, sort?: SortSpecification): { rowid: number, data: string } | null {
    const compiled = toSql('data', filter, this.compileOptions)
    const normalizedSort = typeof sort === 'string' ? { [sort]: 1 } : sort
    const orderBy = normalizedSort == null ? 'rowid' : `${toSortSql('data', normalizedSort)}, rowid`
    const sql = `SELECT rowid, data FROM ${this.table} WHERE (${compiled.sql}) ORDER BY ${orderBy} LIMIT 1`
    const row = this.prepare(sql).get(compiled.params) as { rowid: number, data: string } | undefined
    return row ?? null
  }

  /**
   * Inserts the document an upsert implies and reports it as the driver does.
   *
   * Callers must already have established that nothing matched. Between that
   * check and this insert nothing else can run in-process (node:sqlite is
   * synchronous and there is no await in between); across processes the unique
   * `_id` index is what makes a lost race an error rather than a duplicate.
   */
  private async insertUpserted (
    doc: Document, session: SessionOption = {}
  ): Promise<{ result: UpdateResult, document: WithId<TSchema> }> {
    const insert = await this.insertMany([doc as TSchema], session)
    const upsertedId = insert.insertedIds[0]!
    return {
      result: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId },
      // Read back rather than reusing `doc`: the storage layer decides the
      // final shape (dropped `undefined`s, Date round-trip, key order).
      document: (await this.findOne({ _id: upsertedId } as AnyFilter, session))!
    }
  }

  /**
   * Applies a compiled update expression to exactly one row.
   *
   * `watched` is the pre-image and the update that produced it, supplied only
   * when something is watching: with it the statement gains a `RETURNING`
   * clause and emits the event, without it the SQL is exactly what it always
   * was.
   */
  private updateRow (
    expr: UpdateExpression, rowid: number, watched?: { before: Document, update: AnyFilter }
  ): number {
    this.assertUpdateApplies(expr, 'rowid = :rowid', { rowid })
    // `data != <expr>` makes a no-op update report modifiedCount 0, like
    // MongoDB. Each 'u' parameter binds once for both occurrences of expr.
    const sql = `UPDATE ${this.table} SET data = ${expr.sql} WHERE rowid = :rowid AND data != ${expr.sql}`
    const params = { ...expr.params, rowid }
    if (watched === undefined) return Number(this.run(sql, params).changes)

    const rows = this.allRows(`${sql} RETURNING data`, params)
    for (const row of rows) this.emitUpdate(watched.before, parseDocument(row.data as string), watched.update)
    return rows.length
  }

  /** Replaces exactly one row's document, keeping its `_id`. */
  private replaceRow (rowid: number, doc: WithoutId<TSchema>, id: unknown, before?: Document): number {
    // One named parameter serves both occurrences of the new document.
    const sql = `UPDATE ${this.table} SET data = json(:doc) WHERE rowid = :rowid AND data != json(:doc)`
    const params = { rowid, doc: stringifyDocument({ ...doc, _id: id }) }
    if (before === undefined) return Number(this.run(sql, params).changes)

    const rows = this.allRows(`${sql} RETURNING data`, params)
    for (const row of rows) {
      const after = parseDocument(row.data as string)
      this.emitChange('replace', {
        documentKey: { _id: after._id }, fullDocument: after, fullDocumentBeforeChange: before
      })
    }
    return rows.length
  }

  /**
   * The document a replacement upsert inserts: the replacement itself, plus
   * the `_id` the filter pins when the replacement does not name one. Other
   * filter equalities are NOT carried over - a replacement document is meant
   * to be the whole document.
   */
  private upsertReplacement (filter: AnyFilter, doc: WithoutId<TSchema>, givenId: unknown): Document {
    const pinned: Document = {}
    collectEqualities(filter, pinned)
    const id = givenId ?? pinned._id
    return { ...(id == null ? {} : { _id: id }), ...doc }
  }

  async deleteOne (filter: Filter<TSchema>, options: DeleteOptions = {}): Promise<DeleteResult> {
    this.enlist(options)
    const found = this.findOneRow(filter)
    if (found === null) return { acknowledged: true, deletedCount: 0 }
    const { rowid } = found

    const result = this.run(`DELETE FROM ${this.table} WHERE rowid = :rowid`, { rowid })
    const deletedCount = Number(result.changes)
    // The pre-image is already in hand: findOneRow read it to find the rowid.
    if (this.changes.watching && deletedCount > 0) this.emitDelete(parseDocument(found.data))
    return { acknowledged: true, deletedCount }
  }

  async deleteMany (filter: Filter<TSchema>, options: DeleteOptions = {}): Promise<DeleteResult> {
    this.enlist(options)
    const compiled = toSql('data', filter, this.compileOptions)
    const sql = `DELETE FROM ${this.table} WHERE (${compiled.sql})`
    if (!this.changes.watching) {
      const result = this.run(sql, compiled.params)
      return { acknowledged: true, deletedCount: Number(result.changes) }
    }

    // RETURNING hands back every deleted document in the statement that
    // deleted it, so the events cost no extra read - and the row count IS the
    // deleted count.
    const rows = this.allRows(`${sql} RETURNING rowid, data`, compiled.params)
    for (const row of Collection.inRowidOrder(rows)) this.emitDelete(parseDocument(row.data as string))
    return { acknowledged: true, deletedCount: rows.length }
  }

  private emitDelete (document: Document): void {
    this.emitChange('delete', { documentKey: { _id: document._id }, fullDocumentBeforeChange: document })
  }

  /**
   * `RETURNING` does not promise an order, and rowid order is the order
   * `find()` reports documents in - so events describe a batch the same way
   * every other read of it does.
   */
  private static inRowidOrder (rows: DriverRow[]): DriverRow[] {
    return rows.toSorted((left, right) => Number(left.rowid) - Number(right.rowid))
  }

  /** Rejects a replacement document and returns the `_id` it pins, if any. */
  private static replacementId (doc: Document): unknown {
    // MongoDB rejects replacement documents whose first key is an operator.
    if (Object.keys(doc)[0]?.startsWith('$') === true) {
      throw Error('replacement document must not contain atomic operators')
    }
    return doc._id
  }

  async replaceOne (filter: Filter<TSchema>, doc: WithoutId<TSchema>, options: ReplaceOptions = {}): Promise<UpdateResult> {
    const session = this.enlist(options)
    const givenId = Collection.replacementId(doc)

    const found = this.findOneRow(filter)
    if (found === null) {
      if (options.upsert !== true) return updateResult(0, 0)
      return (await this.insertUpserted(this.upsertReplacement(filter, doc, givenId), session)).result
    }

    const before = parseDocument(found.data)
    const id = before._id
    if (givenId != null && id !== givenId) throw Error('_id field is immutable and cannot be changed')

    // A no-op replacement reports modifiedCount 0, matching MongoDB - SQLite
    // would otherwise count every touched row.
    return updateResult(1, this.replaceRow(found.rowid, doc, id, this.changes.watching ? before : undefined))
  }

  /** Updates the first document matching `filter` with $set/$unset/$inc operators. */
  async updateOne (filter: Filter<TSchema>, update: UpdateFilter<TSchema>, options: UpdateOptions = {}): Promise<UpdateResult> {
    const session = this.enlist(options)
    const expr = buildUpdateExpression(update, compileOptionsFor(filter, options))
    this.assertDescribableUpdate(update)

    const found = this.findOneRow(filter)
    if (found === null) {
      if (options.upsert !== true) return updateResult(0, 0)
      return (await this.insertUpserted(buildUpsertDocument(filter, update), session)).result
    }

    return updateResult(1, this.updateRow(expr, found.rowid, this.watched(found.data, update)))
  }

  /** Updates every document matching `filter` with $set/$unset/$inc operators. */
  async updateMany (filter: Filter<TSchema>, update: UpdateFilter<TSchema>, options: UpdateOptions = {}): Promise<UpdateResult> {
    const session = this.enlist(options)
    const expr = buildUpdateExpression(update, compileOptionsFor(filter, options))
    this.assertDescribableUpdate(update)
    const watching = this.changes.watching
    const compiled = toSql('data', filter, this.compileOptions)

    // While something is watching, the matched rows are READ rather than
    // counted: the events need their pre-images, and reading them replaces the
    // count instead of adding a statement to it.
    const before = watching
      ? this.allRows(`SELECT rowid, data FROM ${this.table} WHERE (${compiled.sql})`, compiled.params)
      : undefined
    const matchedCount = before?.length ?? await this.countDocuments(filter, session)
    // An upsert that matches nothing inserts exactly ONE document, as it does
    // for updateOne - "many" describes what is updated, not what is created.
    if (matchedCount === 0 && options.upsert === true) {
      return (await this.insertUpserted(buildUpsertDocument(filter, update), session)).result
    }

    // Checked across every matched row before anything is written, so a bad
    // $inc or $push target leaves the collection untouched rather than
    // partially updated. (MongoDB applies until it hits the offending document;
    // this is the safer divergence, and the one the rollback semantics implied.)
    this.assertUpdateApplies(expr, compiled.sql, compiled.params)

    // The expression's 'u' params and the filter's 'p' params merge without
    // collisions, by construction (see bindValue / buildUpdateExpression).
    const sql = `UPDATE ${this.table} SET data = ${expr.sql} WHERE (${compiled.sql}) AND data != ${expr.sql}`
    const params = { ...expr.params, ...compiled.params }
    if (before === undefined) return updateResult(matchedCount, Number(this.run(sql, params).changes))

    const after = this.allRows(`${sql} RETURNING rowid, data`, params)
    const preImages = new Map(before.map(row => [Number(row.rowid), row.data as string]))
    for (const row of Collection.inRowidOrder(after)) {
      this.emitUpdate(parseDocument(preImages.get(Number(row.rowid))!), parseDocument(row.data as string), update)
    }
    return updateResult(matchedCount, after.length)
  }

  /** What `updateRow` needs to emit an event, or undefined when nothing is watching. */
  private watched (before: string, update: AnyFilter): { before: Document, update: AnyFilter } | undefined {
    return this.changes.watching ? { before: parseDocument(before), update } : undefined
  }

  /**
   * Finds one document, applies `update` to it, and returns a version of it.
   *
   * Returns the document as it was BEFORE the update by default, matching the
   * driver's `returnDocument: 'before'`. With `upsert` and nothing matched,
   * 'before' returns null - there was no earlier version - while 'after'
   * returns the document that was inserted.
   */
  async findOneAndUpdate (
    filter: Filter<TSchema>, update: UpdateFilter<TSchema>, options: FindOneAndUpdateOptions = {}
  ): Promise<WithId<TSchema> | null> {
    const session = this.enlist(options)
    const expr = buildUpdateExpression(update, compileOptionsFor(filter, options))
    this.assertDescribableUpdate(update)
    const found = this.findOneRow(filter, options.sort)

    if (found === null) {
      if (options.upsert !== true) return null
      return await this.returnUpserted(buildUpsertDocument(filter, update), options, filter, session)
    }

    const before = parseDocument(found.data) as WithId<TSchema>
    this.updateRow(expr, found.rowid, this.changes.watching ? { before, update } : undefined)
    return this.returnWritten(before, found.rowid, options, filter)
  }

  /** As `findOneAndUpdate`, but with a whole replacement document. */
  async findOneAndReplace (
    filter: Filter<TSchema>, replacement: WithoutId<TSchema>, options: FindOneAndReplaceOptions = {}
  ): Promise<WithId<TSchema> | null> {
    const session = this.enlist(options)
    const givenId = Collection.replacementId(replacement)
    const found = this.findOneRow(filter, options.sort)

    if (found === null) {
      if (options.upsert !== true) return null
      return await this.returnUpserted(this.upsertReplacement(filter, replacement, givenId), options, filter, session)
    }

    const before = parseDocument(found.data) as WithId<TSchema>
    if (givenId != null && before._id !== givenId) throw Error('_id field is immutable and cannot be changed')
    this.replaceRow(found.rowid, replacement, before._id, this.changes.watching ? before : undefined)
    return this.returnWritten(before, found.rowid, options, filter)
  }

  /** Deletes one document and returns it, or null when nothing matched. */
  async findOneAndDelete (filter: Filter<TSchema>, options: FindOneAndDeleteOptions = {}): Promise<WithId<TSchema> | null> {
    this.enlist(options)
    const found = this.findOneRow(filter, options.sort)
    if (found === null) return null

    const document = parseDocument(found.data) as WithId<TSchema>
    this.run(`DELETE FROM ${this.table} WHERE rowid = :rowid`, { rowid: found.rowid })
    if (this.changes.watching) this.emitDelete(document)
    return this.applyProjection(document, options.projection, filter)
  }

  /** The 'before'/'after' choice, for a row that was just written in place. */
  private returnWritten (
    before: WithId<TSchema>, rowid: number, options: FindOneAndUpdateOptions, filter: Filter<TSchema>
  ): WithId<TSchema> | null {
    if (options.returnDocument !== 'after') return this.applyProjection(before, options.projection, filter)
    const row = this.prepare(`SELECT data FROM ${this.table} WHERE rowid = :rowid`).get({ rowid }) as { data: string } | undefined
    return row === undefined ? null : this.applyProjection(parseDocument(row.data), options.projection, filter)
  }

  /** The 'before'/'after' choice for an upsert: there is no 'before' version. */
  private async returnUpserted (
    doc: Document, options: FindOneAndUpdateOptions, filter: Filter<TSchema>, session: SessionOption = {}
  ): Promise<WithId<TSchema> | null> {
    const { document } = await this.insertUpserted(doc, session)
    if (options.returnDocument !== 'after') return null
    return this.applyProjection(document, options.projection, filter)
  }

  /**
   * Applies a projection to a document already in hand - the findOneAnd*
   * methods, which have no cursor to hang extra columns off.
   *
   * An ordinary projection is pure JavaScript. One using `$elemMatch` or `$`
   * costs ONE extra statement, because deciding which element matched is the
   * query engine's job (see firstMatchingElementSql); `find()` gets the same
   * answers for free as columns of the query it was already running.
   */
  private applyProjection<T>(doc: T, spec?: ProjectionSpec, filter: Filter<TSchema> = {} as Filter<TSchema>): T {
    if (spec == null) return doc
    const compiled = compileProjection(spec, filter)
    if (compiled.probes.length === 0) return compiled.project(doc)

    const bindings = createBindings('q')
    const document = `json(${bindRaw(bindings, stringifyDocument(doc))})`
    const columns = compiled.probes.map((probe, index) =>
      `${firstMatchingElementSql(document, probe.path, probe.criterion, bindings)} AS ${PROBE_COLUMN}${index}`
    )
    const row = this.prepare(`SELECT ${columns.join(', ')}`).get(bindings.values) as Record<string, unknown>
    return compiled.project(doc, compiled.probes.map((_, index) => row[`${PROBE_COLUMN}${index}`] as number | null))
  }

  async insertOne (doc: TSchema, options: InsertOneOptions = {}): Promise<InsertOneResult> {
    return {
      acknowledged: true,
      insertedId: (await this.insertMany([doc], this.enlist(options))).insertedIds[0]!
    }
  }

  /**
   * Inserts documents in order, as MongoDB's *ordered* `insertMany` does:
   * serially, stopping at the first failure, keeping everything written before
   * it and never attempting anything after it.
   *
   * **That contract is about the OUTCOME, not about transactions.** The batch
   * runs inside ONE transaction, and a failure part-way through COMMITS the
   * documents that succeeded rather than rolling them back - which leaves
   * exactly the state MongoDB would, while costing one commit instead of one
   * per document. With `journal_mode=WAL` and SQLite's default
   * `synchronous=FULL`, a commit per document means an fsync per document; the
   * batch form is orders of magnitude faster on a file-backed database and
   * makes no difference to what a caller can observe.
   *
   * With `{ ordered: false }` every document is attempted and the failures are
   * reported together at the end, again matching the server.
   *
   * The input documents are MUTATED, gaining their `_id` - the driver does the
   * same, and several specs assert on it.
   */
  async insertMany (docs: TSchema[], options: InsertManyOptions = {}): Promise<InsertManyResult> {
    this.enlist(options)
    if (!Array.isArray(docs)) throw Error('insertMany expects an array of documents')
    if (options.ordered === false) return await this.insertUnordered(docs)
    const stmt = this.prepare(`INSERT INTO ${this.table} VALUES(json(?))`)
    const insertedIds: Record<number, string> = {}
    let insertedCount = 0

    // BEGIN is attempted rather than guarded by a flag: a caller (or a future
    // withTransaction) may already have one open, and SQLite has no nested
    // transactions. Failing to open one simply means this batch does not own
    // it, and the enclosing transaction decides when the work becomes durable.
    //
    // Routed through this.exec, not this.db.exec, so the transaction shows up
    // in `debug` output like every other statement - which is also what lets
    // test/write-batching.spec.ts COUNT the commits instead of timing them.
    let owned = false
    if (docs.length > 1) {
      try {
        this.exec('BEGIN')
        owned = true
        // A change buffer pairs with the transaction, exactly as it does for
        // `Db.withTransaction`: the events become visible when (and only if)
        // this batch's own COMMIT makes the documents visible.
        this.changes.enter()
      } catch {
        owned = false
      }
    }

    /** Ends the transaction KEEPING whatever was inserted, per ordered semantics. */
    const keepWhatLanded = (): void => {
      if (!owned) return
      owned = false
      let committed = true
      try {
        this.exec('COMMIT')
      } catch {
        // A constraint failure aborts the statement, not the transaction, so
        // COMMIT normally succeeds. If SQLite did abort it, the prefix is gone
        // either way and the only correct move is to leave no transaction open.
        committed = false
        try { this.exec('ROLLBACK') } catch { /* already closed */ }
      }
      this.changes.leave(committed)
    }

    try {
      for (let index = 0; index < docs.length; index++) {
        const doc = docs[index]!
        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
          throw Error(`documents must be objects; but got: ${doc === null ? 'null' : typeof doc} at index ${index}`)
        }
        // MongoDB forbids an array _id, and here it would additionally make the
        // document ambiguous to address: the implicit array-element rule lets
        // { _id: [ ... ] } match a DIFFERENT document that merely contains it.
        if (Array.isArray(doc._id)) throw Error(`the _id field cannot be an array (at index ${index})`)
        const id = (doc._id == null) ? objectIdHexString() : doc._id;
        (doc as unknown as WithId<TSchema>)._id = id
        const stored = stringifyDocument({ _id: id, ...doc })
        try {
          stmt.run([stored])
        } catch (error) {
          throw this.mapError(error)
        }
        insertedIds[index] = id
        insertedCount++
        // The stored TEXT, decoded - not `doc`. The storage layer decides the
        // final shape (dropped `undefined`s, Date round-trip, key order), and
        // an event must report what a reader would find.
        if (this.changes.watching) {
          this.emitChange('insert', { documentKey: { _id: id }, fullDocument: parseDocument(stored) })
        }
      }
    } catch (error) {
      keepWhatLanded()
      // The driver reports the partial result on the error itself, so a caller
      // can tell how far an ordered batch got without re-querying.
      throw withPartialResult(error, insertedIds, insertedCount)
    }
    keepWhatLanded()

    return { acknowledged: true, insertedIds, insertedCount }
  }

  /**
   * `insertMany(docs, { ordered: false })`: attempt every document, then report.
   *
   * Unlike the ordered path this cannot stop at the first failure, so it cannot
   * use one transaction for the whole batch either - a failure has to leave the
   * SUCCESSFUL documents in place while the failed ones are skipped, and a
   * single transaction has only one outcome for all of them. Each document
   * therefore commits on its own, which is slower on a file-backed database;
   * that is the price of the semantics, and ordered (the default) is the fast
   * path.
   */
  private async insertUnordered (docs: TSchema[]): Promise<InsertManyResult> {
    const stmt = this.prepare(`INSERT INTO ${this.table} VALUES(json(?))`)
    const insertedIds: Record<number, string> = {}
    let insertedCount = 0
    let firstError: unknown

    for (let index = 0; index < docs.length; index++) {
      try {
        const doc = docs[index]!
        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
          throw Error(`documents must be objects; but got: ${doc === null ? 'null' : typeof doc} at index ${index}`)
        }
        if (Array.isArray(doc._id)) throw Error(`the _id field cannot be an array (at index ${index})`)
        const id = (doc._id == null) ? objectIdHexString() : doc._id;
        (doc as unknown as WithId<TSchema>)._id = id
        const stored = stringifyDocument({ _id: id, ...doc })
        try {
          stmt.run([stored])
        } catch (error) {
          throw this.mapError(error)
        }
        insertedIds[index] = id
        insertedCount++
        if (this.changes.watching) {
          this.emitChange('insert', { documentKey: { _id: id }, fullDocument: parseDocument(stored) })
        }
      } catch (error) {
        firstError ??= error
      }
    }

    if (firstError !== undefined) throw withPartialResult(firstError, insertedIds, insertedCount)
    return { acknowledged: true, insertedIds, insertedCount }
  }

  /**
   * Runs a batch of mixed writes.
   *
   * Each operation delegates to the single-document method that already
   * implements it, so `bulkWrite` cannot drift from `updateOne` and friends -
   * it is a batching and result-accounting layer, not a second implementation.
   *
   * Ordered (the default) stops at the first failed operation and reports what
   * completed; `{ ordered: false }` attempts them all. Neither is atomic, which
   * matches MongoDB - wrap the call in `db.withTransaction()` if you want
   * all-or-nothing.
   */
  async bulkWrite (
    operations: Array<AnyBulkWriteOperation<TSchema>>, options: BulkWriteOptions = {}
  ): Promise<BulkWriteResult> {
    const session = this.enlist(options)
    if (!Array.isArray(operations)) throw Error('bulkWrite expects an array of operations')
    if (operations.length === 0) throw Error('bulkWrite requires at least one operation')

    const result: BulkWriteResult = {
      acknowledged: true,
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0,
      insertedIds: {},
      upsertedIds: {}
    }
    let firstError: unknown

    for (let index = 0; index < operations.length; index++) {
      try {
        await this.applyBulkOperation(operations[index]!, index, result, session)
      } catch (error) {
        firstError ??= error
        if (options.ordered !== false) break
      }
    }

    if (firstError !== undefined) {
      // defineProperty via attach(), not Object.assign: insertMany already put
      // a non-writable `result` on this error and assigning over it throws.
      if (firstError instanceof Error) attach(firstError, 'result', result)
      throw firstError
    }
    return result
  }

  /** One `bulkWrite` entry, accumulated into `result`. */
  private async applyBulkOperation (
    operation: AnyBulkWriteOperation<TSchema>, index: number, result: BulkWriteResult, session: SessionOption
  ): Promise<void> {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
      throw Error(`bulkWrite operation at index ${index} must be a document`)
    }
    const entries = Object.entries(operation as Record<string, any>)
    if (entries.length !== 1) {
      throw Error(`bulkWrite operation at index ${index} must have exactly one key; but got ${entries.length}`)
    }
    const [name, spec] = entries[0]!
    if (spec === null || typeof spec !== 'object') {
      throw Error(`the '${name}' operation at index ${index} requires a document`)
    }

    switch (name) {
      case 'insertOne': {
        const inserted = await this.insertOne(spec.document as TSchema, session)
        result.insertedIds[index] = inserted.insertedId
        result.insertedCount++
        return
      }
      case 'updateOne':
      case 'updateMany': {
        const options = { ...session, ...(spec.upsert === true ? { upsert: true } : {}) }
        const updated = name === 'updateOne'
          ? await this.updateOne(spec.filter as Filter<TSchema>, spec.update as UpdateFilter<TSchema>, options)
          : await this.updateMany(spec.filter as Filter<TSchema>, spec.update as UpdateFilter<TSchema>, options)
        this.accumulateUpdate(updated, index, result)
        return
      }
      case 'replaceOne': {
        const replaced = await this.replaceOne(
          spec.filter as Filter<TSchema>, spec.replacement as WithoutId<TSchema>,
          { ...session, ...(spec.upsert === true ? { upsert: true } : {}) }
        )
        this.accumulateUpdate(replaced, index, result)
        return
      }
      case 'deleteOne':
      case 'deleteMany': {
        const deleted = name === 'deleteOne'
          ? await this.deleteOne(spec.filter as Filter<TSchema>, session)
          : await this.deleteMany(spec.filter as Filter<TSchema>, session)
        result.deletedCount += deleted.deletedCount
        return
      }
      default:
        throw Error(
          `unsupported bulkWrite operation: ${name} ` +
          '(supported: insertOne, updateOne, updateMany, replaceOne, deleteOne, deleteMany)'
        )
    }
  }

  private accumulateUpdate (updated: UpdateResult, index: number, result: BulkWriteResult): void {
    result.matchedCount += updated.matchedCount
    result.modifiedCount += updated.modifiedCount
    result.upsertedCount += updated.upsertedCount
    if (updated.upsertedId !== null) result.upsertedIds[index] = updated.upsertedId
  }
}
