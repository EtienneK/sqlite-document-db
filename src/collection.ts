/**
 * `Collection` - the CRUD, query, index and aggregation surface.
 *
 * Split out of index.ts, which had grown to hold the public types, this class
 * and `Db` all at once. Everything that decides HOW a statement is built lives
 * in the compiler modules (query.ts, update.ts, aggregate.ts); this file is
 * where those get turned into statements and run.
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { compileStages, splitPipeline } from './aggregate.js'
import { compareBson } from './bson-order.js'
// Documents round-trip through the EJSON layer, not plain JSON: Dates are
// stored as {"$date": ...} and unstorable types are rejected (BACKLOG DR-1).
import { parse as parseDocument, stringify as stringifyDocument } from './ejson.js'
import { toMongoError, withPartialResult } from './errors.js'
import type { Filter, UpdateFilter } from './filter-types.js'
import { objectIdHexString } from './object-id.js'
import { compileProjection, type ProjectionSpec } from './projection.js'
import { quoteIdentifier, toJson1PathString, toSortSql, toSql, type CompileOptions, type SqlParams } from './query.js'
import type {
  AggregationCursor, AnyFilter, CreateIndexOptions, DbOptions, DeleteResult, Document,
  FindCursor, FindOneAndDeleteOptions, FindOneAndReplaceOptions, FindOneAndUpdateOptions,
  FindOptions, IndexDescription, IndexDirection, IndexSpecification, InsertManyResult,
  InsertOneResult, ReplaceOptions, SortSpecification, UpdateOptions, UpdateResult, WithId, WithoutId
} from './types.js'
import { buildUpdateExpression, buildUpsertDocument, collectEqualities, type UpdateExpression } from './update.js'

/** The driver's UpdateResult shape for a write that did not upsert. */
function updateResult (matchedCount: number, modifiedCount: number): UpdateResult {
  return { acknowledged: true, matchedCount, modifiedCount, upsertedCount: 0, upsertedId: null }
}

/** Applies a projection to a single document, when one was requested. */
function applyProjection<T> (doc: T, spec?: ProjectionSpec): T {
  return spec == null ? doc : compileProjection(spec)(doc)
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
 * Makes each `$match`-after-`$group` temp table uniquely named, so a pipeline
 * iterated while another one is mid-flight cannot drop the other's table.
 */
let matchBatchSequence = 0

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
function tableNameFor (name: string): string {
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
function assertValidCollectionName (name: string): void {
  if (typeof name !== 'string' || name === '') throw Error('collection name must be a non-empty string')
  if (name.includes('\0')) throw Error('collection name must not contain a null character')
  if (name.includes('$')) throw Error(`collection name must not contain '$': ${name}`)
  if (name.startsWith('system.')) throw Error(`collection name must not start with 'system.': ${name}`)
  if (name.toLowerCase().startsWith('sqlite_')) throw Error(`collection name must not start with 'sqlite_': ${name}`)
  if (name.length > 200) throw Error('collection name must be at most 200 characters')
}

export class Collection<TSchema extends Document = Document> {
  /** The name this collection was opened with, as the MongoDB driver exposes it. */
  readonly collectionName: string

  private readonly db: DatabaseSync
  private readonly dbOptions: DbOptions
  /** Physical table name, unquoted - for sqlite_master lookups and index names. */
  private readonly name: string
  /** Physical table name, quoted - for interpolation into SQL. */
  private readonly table: string
  /** What every filter compiled against this collection is compiled with. */
  private readonly compileOptions: CompileOptions
  /** Evicts this collection from its `Db`'s cache. See drop(). */
  private readonly onDrop: () => void

  constructor (name: string, db: DatabaseSync, dbOptions: DbOptions, onDrop: () => void = () => {}) {
    assertValidCollectionName(name)

    this.db = db
    this.dbOptions = dbOptions
    this.onDrop = onDrop
    this.collectionName = name
    this.name = tableNameFor(name)
    this.table = quoteIdentifier(this.name)
    this.compileOptions = { table: this.table, strict: dbOptions.strict }

    // node:sqlite is synchronous, so a collection is fully usable the moment
    // its constructor returns - no init promise to await on every call.
    this.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (data JSON)`)
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

  private prepare (sql: string): ReturnType<DatabaseSync['prepare']> {
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

  /** Physical SQLite index name back to the name createIndex() handed out. */
  private mongoIndexName (physicalName: string): string {
    if (physicalName === `ux_${this.name}_doc_id`) return '_id_'
    for (const prefix of [`ix_${this.name}_`, `ixd_${this.name}_`]) {
      if (physicalName.startsWith(prefix)) return physicalName.slice(prefix.length)
    }
    return physicalName
  }

  private mapError (error: unknown): unknown {
    return toMongoError(error, this.collectionName, name => this.mongoIndexName(name))
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
    const row = this.prepare(sql).get(scopeParams) as { guard: number } | undefined
    if (row === undefined) return
    throw Error(expr.guards[row.guard]!.message)
  }

  find (query: Filter<TSchema> = {}, options: FindOptions = {}): FindCursor<TSchema> {
    // The options form gets the same validation as the chainable setters -
    // limit and skip are interpolated into SQL, so a NaN arriving from
    // unvalidated caller input surfaced as "no such column: NaN".
    if (options.limit !== undefined) assertLimit(options.limit)
    if (options.skip !== undefined) assertSkip(options.skip)

    let sortSpec = options.sort
    let limitCount = options.limit
    let skipCount = options.skip
    let projectionSpec = options.projection
    let projector: ((doc: any) => any) | undefined
    let rows: Iterator<unknown> | undefined
    let done = false

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
      const filter = toSql('data', query, this.compileOptions)
      let sql = `SELECT data FROM ${this.table} WHERE (${filter.sql}) ORDER BY ${orderBy}`

      if (limitCount != null || skipCount != null) {
        // MongoDB: limit(0) means no limit (SQLite spells that -1), and a
        // negative limit behaves like its absolute value.
        const limit = limitCount == null || limitCount === 0 ? -1 : Math.trunc(Math.abs(limitCount))
        sql += ` LIMIT ${limit}`
        if (skipCount != null && skipCount !== 0) sql += ` OFFSET ${Math.trunc(skipCount)}`
      }
      return { sql, params: filter.params }
    }

    const assertNotStarted = (): void => {
      if (rows !== undefined || done) throw Error('Cursor is already initialized, cannot be modified')
    }

    const next = async (): Promise<WithId<TSchema> | null> => {
      if (done) return null
      if (rows === undefined) {
        // Compiling here (not in find()) surfaces invalid projections as a
        // rejected promise, matching where the driver reports them.
        projector = projectionSpec == null ? undefined : compileProjection(projectionSpec)
        const { sql, params } = buildStatement()
        rows = this.prepare(sql).iterate(params)
      }
      const row = rows.next()
      if (row.done === true) {
        done = true
        return null
      }
      const document = parseDocument((row.value as { data: string }).data)
      return projector === undefined ? document : projector(document)
    }

    const close = async (): Promise<void> => {
      done = true
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
  aggregate <TResult extends Document = Document>(pipeline: Document[] = []): AggregationCursor<TResult> {
    if (!Array.isArray(pipeline)) throw Error('aggregate expects an array of pipeline stages')
    // Split (and therefore validate) eagerly, so a malformed pipeline throws
    // where it was written rather than on first iteration.
    const split = splitPipeline(pipeline)
    const stages = compileStages(split.jsStages, (filter, docs) => this.matchBatch(filter, docs), this.dbOptions.strict)

    const source = this.find(split.filter as Filter<TSchema>, {
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

    const cursor: AggregationCursor<TResult> = {
      next,
      close,

      explain: () => ({
        sql: this.findSql(split.filter, split.sort, split.skip, split.limit),
        pushedDown: split.pushedDown,
        inJavaScript: split.jsStages.map(stage => Object.keys(stage)[0]!)
      }),

      async toArray (): Promise<TResult[]> {
        const documents: TResult[] = []
        let document: TResult | null
        while ((document = await next()) !== null) documents.push(document)
        return documents
      },

      async * [Symbol.asyncIterator] (): AsyncIterableIterator<TResult> {
        try {
          let document: TResult | null
          while ((document = await next()) !== null) yield document
        } finally {
          await close()
        }
      }
    }
    return cursor
  }

  /**
   * Applies a filter to documents that are no longer rows in this collection -
   * what a `$match` after a `$group` needs.
   *
   * The batch goes into a TEMP table and back through the ordinary query
   * compiler, rather than through a JavaScript re-implementation of the filter
   * language. A second matcher would be a second set of semantics to keep in
   * step with the first, and every quirk pinned down in the specs (implicit
   * array matching, the dotted-array-path rule, Date comparison through
   * `.$date`) would have to be reproduced and would eventually drift.
   */
  private matchBatch (filter: AnyFilter, docs: Document[]): Document[] {
    const name = `aggmatch_${this.name}_${matchBatchSequence++}`
    const table = quoteIdentifier(name)
    // TEMP, so it never touches the user's schema and disappears with the
    // connection even if something below throws.
    this.exec(`CREATE TEMP TABLE ${table} (data JSON)`)
    try {
      const insert = this.prepare(`INSERT INTO ${table} VALUES(json(?))`)
      for (const doc of docs) insert.run(stringifyDocument(doc))
      const compiled = toSql('data', filter, { ...this.compileOptions, table })
      const rows = this.prepare(`SELECT data FROM ${table} WHERE (${compiled.sql}) ORDER BY rowid`)
        .all(compiled.params) as Array<{ data: string }>
      return rows.map(row => parseDocument(row.data))
    } finally {
      this.exec(`DROP TABLE IF EXISTS ${table}`)
    }
  }

  /** The SELECT `find()` would build, for AggregationCursor.explain(). */
  private findSql (filter: AnyFilter, sort?: SortSpecification, skip?: number, limit?: number): string {
    const normalizedSort = typeof sort === 'string' ? { [sort]: 1 } : sort
    const orderBy = normalizedSort == null ? 'rowid' : `${toSortSql('data', normalizedSort)}, rowid`
    let sql = `SELECT data FROM ${this.table} WHERE (${toSql('data', filter, this.compileOptions).sql}) ORDER BY ${orderBy}`
    if (limit != null || skip != null) {
      sql += ` LIMIT ${limit == null || limit === 0 ? -1 : Math.trunc(Math.abs(limit))}`
      if (skip != null && skip !== 0) sql += ` OFFSET ${Math.trunc(skip)}`
    }
    return sql
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
   * query on an indexed field is index-eligible. For single-field indexes a
   * non-unique companion index on `<field>.$date` is also created, because
   * Date values are stored as `{"$date": ...}` (see src/ejson.ts) and date
   * comparisons therefore query that sub-path.
   */
  async createIndex (spec: IndexSpecification, options: CreateIndexOptions = {}): Promise<string> {
    const key: Record<string, IndexDirection> = typeof spec === 'string' ? { [spec]: 1 } : spec
    const entries = Object.entries(key)
    if (entries.length === 0) throw Error('createIndex requires at least one field')
    for (const [field, direction] of entries) {
      if (field === '') throw Error('createIndex field names must be non-empty')
      if (direction !== 1 && direction !== -1) {
        throw Error(`unsupported index direction for field ${field}: ${String(direction)} (only 1 and -1 are supported)`)
      }
    }

    // MongoDB's generated name: `<field>_<direction>` pairs joined with '_'.
    const name = options.name ?? entries.map(([field, direction]) => `${field}_${direction}`).join('_')
    const unique = options.unique === true ? 'UNIQUE ' : ''

    const columns = entries
      .map(([field, direction]) => `json_extract(data, ${toJson1PathString([field])}) ${direction === 1 ? 'ASC' : 'DESC'}`)
      .join(', ')
    this.exec(`CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(`ix_${this.name}_${name}`)} ON ${this.table} (${columns})`)

    if (entries.length === 1) {
      const [field, direction] = entries[0]!
      const dateColumn = `json_extract(data, ${toJson1PathString([`${field}.$date`])}) ${direction === 1 ? 'ASC' : 'DESC'}`
      this.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`ixd_${this.name}_${name}`)} ON ${this.table} (${dateColumn})`)
    }

    return name
  }

  /** Drops an index by the name createIndex returned. Throws if it does not exist. */
  async dropIndex (name: string): Promise<void> {
    const physical = `ix_${this.name}_${name}`
    const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(physical)
    if (found === undefined) throw Error(`index not found with name [${name}]`)
    this.exec(`DROP INDEX ${quoteIdentifier(physical)}`)
    this.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(`ixd_${this.name}_${name}`)}`)
  }

  /** Lists indexes in (a subset of) MongoDB's shape: `{ name, key, unique? }`. */
  async indexes (): Promise<IndexDescription[]> {
    const rows = this.db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name"
    ).all(this.name) as Array<{ name: string, sql: string | null }>

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
        ...(row.sql.startsWith('CREATE UNIQUE') ? { unique: true } : {})
      })
    }
    return descriptions
  }

  listIndexes (): { toArray: () => Promise<IndexDescription[]> } {
    return { toArray: async () => await this.indexes() }
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
  async distinct (field: string, filter: Filter<TSchema> = {}): Promise<any[]> {
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
  async drop (): Promise<boolean> {
    this.exec(`DROP TABLE IF EXISTS ${this.table}`)
    this.onDrop()
    return true
  }

  async countDocuments (filter?: Filter<TSchema>): Promise<number> {
    const compiled = toSql('data', filter ?? {}, this.compileOptions)
    const sql = `SELECT COUNT(*) AS count FROM ${this.table} WHERE (${compiled.sql})`
    const result = this.prepare(sql).get(compiled.params) as { count: number }
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
  private async insertUpserted (doc: Document): Promise<{ result: UpdateResult, document: WithId<TSchema> }> {
    const insert = await this.insertMany([doc as TSchema])
    const upsertedId = insert.insertedIds[0]!
    return {
      result: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId },
      // Read back rather than reusing `doc`: the storage layer decides the
      // final shape (dropped `undefined`s, Date round-trip, key order).
      document: (await this.findOne({ _id: upsertedId } as AnyFilter))!
    }
  }

  /** Applies a compiled update expression to exactly one row. */
  private updateRow (expr: UpdateExpression, rowid: number): number {
    this.assertUpdateApplies(expr, 'rowid = :rowid', { rowid })
    // `data != <expr>` makes a no-op update report modifiedCount 0, like
    // MongoDB. Each 'u' parameter binds once for both occurrences of expr.
    const sql = `UPDATE ${this.table} SET data = ${expr.sql} WHERE rowid = :rowid AND data != ${expr.sql}`
    return Number(this.run(sql, { ...expr.params, rowid }).changes)
  }

  /** Replaces exactly one row's document, keeping its `_id`. */
  private replaceRow (rowid: number, doc: WithoutId<TSchema>, id: unknown): number {
    // One named parameter serves both occurrences of the new document.
    const sql = `UPDATE ${this.table} SET data = json(:doc) WHERE rowid = :rowid AND data != json(:doc)`
    return Number(this.run(sql, { rowid, doc: stringifyDocument({ ...doc, _id: id }) }).changes)
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

  async deleteOne (filter: Filter<TSchema>): Promise<DeleteResult> {
    const found = this.findOneRow(filter)
    if (found === null) return { acknowledged: true, deletedCount: 0 }
    const { rowid } = found

    const result = this.run(`DELETE FROM ${this.table} WHERE rowid = :rowid`, { rowid })
    return { acknowledged: true, deletedCount: Number(result.changes) }
  }

  async deleteMany (filter: Filter<TSchema>): Promise<DeleteResult> {
    const compiled = toSql('data', filter, this.compileOptions)
    const result = this.run(`DELETE FROM ${this.table} WHERE (${compiled.sql})`, compiled.params)
    return { acknowledged: true, deletedCount: Number(result.changes) }
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
    const givenId = Collection.replacementId(doc)

    const found = this.findOneRow(filter)
    if (found === null) {
      if (options.upsert !== true) return updateResult(0, 0)
      return (await this.insertUpserted(this.upsertReplacement(filter, doc, givenId))).result
    }

    const id = parseDocument(found.data)._id
    if (givenId != null && id !== givenId) throw Error('_id field is immutable and cannot be changed')

    // A no-op replacement reports modifiedCount 0, matching MongoDB - SQLite
    // would otherwise count every touched row.
    return updateResult(1, this.replaceRow(found.rowid, doc, id))
  }

  /** Updates the first document matching `filter` with $set/$unset/$inc operators. */
  async updateOne (filter: Filter<TSchema>, update: UpdateFilter<TSchema>, options: UpdateOptions = {}): Promise<UpdateResult> {
    const expr = buildUpdateExpression(update)

    const found = this.findOneRow(filter)
    if (found === null) {
      if (options.upsert !== true) return updateResult(0, 0)
      return (await this.insertUpserted(buildUpsertDocument(filter, update))).result
    }

    return updateResult(1, this.updateRow(expr, found.rowid))
  }

  /** Updates every document matching `filter` with $set/$unset/$inc operators. */
  async updateMany (filter: Filter<TSchema>, update: UpdateFilter<TSchema>, options: UpdateOptions = {}): Promise<UpdateResult> {
    const expr = buildUpdateExpression(update)

    const matchedCount = await this.countDocuments(filter)
    // An upsert that matches nothing inserts exactly ONE document, as it does
    // for updateOne - "many" describes what is updated, not what is created.
    if (matchedCount === 0 && options.upsert === true) {
      return (await this.insertUpserted(buildUpsertDocument(filter, update))).result
    }
    const compiled = toSql('data', filter, this.compileOptions)

    // Checked across every matched row before anything is written, so a bad
    // $inc or $push target leaves the collection untouched rather than
    // partially updated. (MongoDB applies until it hits the offending document;
    // this is the safer divergence, and the one the rollback semantics implied.)
    this.assertUpdateApplies(expr, compiled.sql, compiled.params)

    // The expression's 'u' params and the filter's 'p' params merge without
    // collisions, by construction (see bindValue / buildUpdateExpression).
    const sql = `UPDATE ${this.table} SET data = ${expr.sql} WHERE (${compiled.sql}) AND data != ${expr.sql}`
    const result = this.run(sql, { ...expr.params, ...compiled.params })
    return updateResult(matchedCount, Number(result.changes))
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
    const expr = buildUpdateExpression(update)
    const found = this.findOneRow(filter, options.sort)

    if (found === null) {
      if (options.upsert !== true) return null
      return await this.returnUpserted(buildUpsertDocument(filter, update), options)
    }

    const before = parseDocument(found.data) as WithId<TSchema>
    this.updateRow(expr, found.rowid)
    return this.returnWritten(before, found.rowid, options)
  }

  /** As `findOneAndUpdate`, but with a whole replacement document. */
  async findOneAndReplace (
    filter: Filter<TSchema>, replacement: WithoutId<TSchema>, options: FindOneAndReplaceOptions = {}
  ): Promise<WithId<TSchema> | null> {
    const givenId = Collection.replacementId(replacement)
    const found = this.findOneRow(filter, options.sort)

    if (found === null) {
      if (options.upsert !== true) return null
      return await this.returnUpserted(this.upsertReplacement(filter, replacement, givenId), options)
    }

    const before = parseDocument(found.data) as WithId<TSchema>
    if (givenId != null && before._id !== givenId) throw Error('_id field is immutable and cannot be changed')
    this.replaceRow(found.rowid, replacement, before._id)
    return this.returnWritten(before, found.rowid, options)
  }

  /** Deletes one document and returns it, or null when nothing matched. */
  async findOneAndDelete (filter: Filter<TSchema>, options: FindOneAndDeleteOptions = {}): Promise<WithId<TSchema> | null> {
    const found = this.findOneRow(filter, options.sort)
    if (found === null) return null

    const document = parseDocument(found.data) as WithId<TSchema>
    this.run(`DELETE FROM ${this.table} WHERE rowid = :rowid`, { rowid: found.rowid })
    return applyProjection(document, options.projection)
  }

  /** The 'before'/'after' choice, for a row that was just written in place. */
  private returnWritten (
    before: WithId<TSchema>, rowid: number, options: FindOneAndUpdateOptions
  ): WithId<TSchema> | null {
    if (options.returnDocument !== 'after') return applyProjection(before, options.projection)
    const row = this.prepare(`SELECT data FROM ${this.table} WHERE rowid = :rowid`).get({ rowid }) as { data: string } | undefined
    return row === undefined ? null : applyProjection(parseDocument(row.data), options.projection)
  }

  /** The 'before'/'after' choice for an upsert: there is no 'before' version. */
  private async returnUpserted (doc: Document, options: FindOneAndUpdateOptions): Promise<WithId<TSchema> | null> {
    const { document } = await this.insertUpserted(doc)
    if (options.returnDocument !== 'after') return null
    return applyProjection(document, options.projection)
  }

  async insertOne (doc: TSchema): Promise<InsertOneResult> {
    return {
      acknowledged: true,
      insertedId: (await this.insertMany([doc])).insertedIds[0]!
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
   * The input documents are MUTATED, gaining their `_id` - the driver does the
   * same, and several specs assert on it.
   */
  async insertMany (docs: TSchema[]): Promise<InsertManyResult> {
    if (!Array.isArray(docs)) throw Error('insertMany expects an array of documents')
    const stmt = this.prepare(`INSERT INTO ${this.table} VALUES(json(?))`)
    const insertedIds: Record<number, string> = {}
    let insertedCount = 0

    // BEGIN is attempted rather than guarded by a flag: a caller (or a future
    // withTransaction) may already have one open, and SQLite has no nested
    // transactions. Failing to open one simply means this batch does not own
    // it, and the enclosing transaction decides when the work becomes durable.
    let owned = false
    if (docs.length > 1) {
      try {
        this.db.exec('BEGIN')
        owned = true
      } catch {
        owned = false
      }
    }

    /** Ends the transaction KEEPING whatever was inserted, per ordered semantics. */
    const keepWhatLanded = (): void => {
      if (!owned) return
      owned = false
      try {
        this.db.exec('COMMIT')
      } catch {
        // A constraint failure aborts the statement, not the transaction, so
        // COMMIT normally succeeds. If SQLite did abort it, the prefix is gone
        // either way and the only correct move is to leave no transaction open.
        try { this.db.exec('ROLLBACK') } catch { /* already closed */ }
      }
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
        try {
          stmt.run(stringifyDocument({ _id: id, ...doc }))
        } catch (error) {
          throw this.mapError(error)
        }
        insertedIds[index] = id
        insertedCount++
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
}
