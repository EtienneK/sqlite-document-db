import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
// Documents round-trip through the EJSON layer, not plain JSON: Dates are
// stored as {"$date": ...} and unstorable types are rejected (BACKLOG DR-1).
import { parse as parseDocument, stringify as stringifyDocument } from './ejson.js'
import { toMongoError } from './errors.js'
import { objectIdHexString } from './object-id.js'
import { compileProjection, type ProjectionSpec } from './projection.js'
import { bindValueAsJson, quoteIdentifier, toJson1PathString, toSortSql, toSql, type SqlParams } from './query/query.js'

export type { ProjectionSpec } from './projection.js'
export { DUPLICATE_KEY_ERROR, MongoServerError } from './errors.js'

export declare interface Document {
  [key: string]: any
}

export declare type WithoutId<TSchema extends Document = Document> = Omit<TSchema, '_id'>

export declare type WithId<TSchema extends Document = Document> = WithoutId<TSchema> & {
  _id: string
}

export type Filter = Record<string, any>

// A subset of MongoDB's update document: { $set: {...}, $unset: {...}, $inc: {...} }
export type UpdateFilter = Record<string, any>

// Result shapes match the official MongoDB driver's (DR-2). `acknowledged` is
// always true - node:sqlite is synchronous, so every write is acknowledged.

export interface DeleteResult {
  acknowledged: boolean
  deletedCount: number
}

export interface InsertManyResult {
  acknowledged: boolean
  insertedCount: number
  insertedIds: Record<number, string>
}

export interface InsertOneResult {
  acknowledged: boolean
  insertedId: string
}

export interface UpdateResult {
  acknowledged: boolean
  matchedCount: number
  modifiedCount: number
  upsertedCount: number
  upsertedId: string | null
}

export type IndexDirection = 1 | -1

export type IndexSpecification = string | Record<string, IndexDirection>

export interface CreateIndexOptions {
  unique?: boolean
  name?: string
}

export interface IndexDescription {
  name: string
  key: Record<string, IndexDirection>
  unique?: boolean
}

export type SortSpecification = string | Record<string, 1 | -1>

export interface FindOptions {
  sort?: SortSpecification
  limit?: number
  skip?: number
  projection?: ProjectionSpec
}

export interface FindCursor<TSchema extends Document = Document> {
  /** Sorts results in MongoDB's BSON type order. Chainable; throws once iteration has started. */
  sort: (spec: SortSpecification) => FindCursor<TSchema>
  /** Caps the number of results; 0 means no limit. Chainable; throws once iteration has started. */
  limit: (count: number) => FindCursor<TSchema>
  /** Skips the first `count` results. Chainable; throws once iteration has started. */
  skip: (count: number) => FindCursor<TSchema>
  /** Restricts the fields returned. Chainable; throws once iteration has started. */
  project: (spec: ProjectionSpec) => FindCursor<TSchema>
  next: () => Promise<WithId<TSchema> | null>
  toArray: () => Promise<Array<WithId<TSchema>>>
  close: () => Promise<void>
  [Symbol.asyncIterator]: () => AsyncIterableIterator<WithId<TSchema>>
}

const UPDATE_OPERATORS = ['$set', '$unset', '$inc']

/**
 * Rejects field paths an update must never touch.
 *
 * An empty path is the dangerous one: `toJson1PathString([''])` is `'$'`, the
 * document ROOT, so `{ $set: { '': 1 } }` used to replace the whole document
 * with the number 1. `_id` is immutable in MongoDB, and letting `$unset` remove
 * it (or `$inc` overwrite it) leaves an unaddressable document behind.
 */
function assertUpdatableField (operator: string, field: string): void {
  if (field === '') throw Error(`${operator} requires a non-empty field name`)
  if (field === '_id' || field.startsWith('_id.')) {
    throw Error(`Performing an update on the path '${field}' would modify the immutable field '_id'`)
  }
}

/** The `{ field: value }` map an update operator applies, validated. */
function updateOperand (operator: string, value: unknown): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(`Modifiers operate on fields but ${operator} was given type: ${value === null ? 'null' : typeof value}`)
  }
  const entries = Object.entries(value)
  for (const [field] of entries) assertUpdatableField(operator, field)
  return entries
}

/**
 * Rejects an update whose operators target the same path twice, or a path and
 * one of its ancestors - MongoDB's "would create a conflict at" error. The
 * operators are applied in a fixed order here ($inc, then $unset, then $set)
 * and $inc reads the ORIGINAL column, so a conflicting update would otherwise
 * produce a result that silently depends on that ordering.
 */
function assertNoConflictingPaths (update: UpdateFilter): void {
  const seen: string[] = []
  for (const operator of UPDATE_OPERATORS) {
    for (const field of Object.keys((update[operator] ?? {}) as Record<string, unknown>)) {
      const clash = seen.find(other => other === field || field.startsWith(`${other}.`) || other.startsWith(`${field}.`))
      if (clash !== undefined) {
        throw Error(`Updating the path '${field}' would create a conflict at '${clash}'`)
      }
      seen.push(field)
    }
  }
}

/**
 * For a dotted field like 'a.b.c', wraps `expr` in json_insert calls creating
 * '$.a' and '$.a.b' as empty objects when missing - MongoDB creates missing
 * parents on $set/$inc, but SQLite's json_set only creates the leaf.
 * json_insert is a no-op when the path already exists, so present parents
 * (of any type) are left untouched.
 */
function ensureParents (expr: string, field: string): string {
  const segments = field.split('.')
  for (let i = 1; i < segments.length; i++) {
    const parent = segments.slice(0, i).join('.')
    expr = `json_insert(${expr}, ${toJson1PathString([parent])}, json('{}'))`
  }
  return expr
}

/**
 * Compiles a MongoDB update document ({ $set, $unset, $inc }) into a SQL
 * expression computing the new value of the `data` column, plus its named
 * parameters. Update params are prefixed 'u' so they can be merged with a
 * filter's 'p'-prefixed params in one statement without collisions.
 */
function buildUpdateExpression (update: UpdateFilter): { sql: string, params: SqlParams } {
  const keys = Object.keys(update)
  if (keys.length === 0) throw Error('update document must contain atomic operators (e.g. { $set: { ... } })')
  for (const key of keys) {
    if (!UPDATE_OPERATORS.includes(key)) {
      throw Error(key.startsWith('$')
        ? `unsupported update operator: ${key} (supported: ${UPDATE_OPERATORS.join(', ')})`
        : 'update document requires atomic operators (e.g. { $set: { ... } })')
    }
  }

  assertNoConflictingPaths(update)

  let expr = 'data'
  const params: SqlParams = {}
  let n = 0

  if (update.$inc != null) {
    for (const [field, amount] of updateOperand('$inc', update.$inc)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw Error(`$inc requires a finite number for field ${field}; but got: ${String(amount)}`)
      }
      expr = ensureParents(expr, field)
      const path = toJson1PathString([field])
      const name = `u${n++}`
      params[name] = amount
      // Missing fields start from 0, like MongoDB. Present-but-non-numeric
      // fields are an error there, and used to be silent data loss here:
      // SQLite coerced 'hello' + 1 to 1 and wrote the number back.
      expr = `json_set(${expr}, ${path}, CASE ` +
        `WHEN json_type(data, ${path}) IS NULL THEN :${name} ` +
        `WHEN json_type(data, ${path}) IN ('integer','real') THEN json_extract(data, ${path}) + :${name} ` +
        `ELSE mdb_raise('Cannot apply $inc to a value of non-numeric type (field ${field.replace(/'/g, "''")})') END)`
    }
  }

  if (update.$unset != null) {
    const paths = updateOperand('$unset', update.$unset).map(([field]) => toJson1PathString([field]))
    if (paths.length > 0) expr = `json_remove(${expr}, ${paths.join(', ')})`
  }

  if (update.$set != null) {
    for (const [field, value] of updateOperand('$set', update.$set)) {
      expr = ensureParents(expr, field)
      expr = `json_set(${expr}, ${toJson1PathString([field])}, ${bindValueAsJson(params, `u${n++}`, value)})`
    }
  }

  return { sql: expr, params }
}

/** The driver's UpdateResult shape; upserts are not supported yet, hence the zeroes. */
function updateResult (matchedCount: number, modifiedCount: number): UpdateResult {
  return { acknowledged: true, matchedCount, modifiedCount, upsertedCount: 0, upsertedId: null }
}

function assertLimit (count: number): void {
  if (typeof count !== 'number' || !Number.isFinite(count)) throw Error(`limit must be a finite number; but got: ${String(count)}`)
}

function assertSkip (count: number): void {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw Error(`skip must be a non-negative finite number; but got: ${String(count)}`)
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

  constructor (name: string, db: DatabaseSync, dbOptions: DbOptions) {
    assertValidCollectionName(name)

    this.db = db
    this.dbOptions = dbOptions
    this.collectionName = name
    this.name = tableNameFor(name)
    this.table = quoteIdentifier(this.name)

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

  find (query: Filter = {}, options: FindOptions = {}): FindCursor<TSchema> {
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
      const orderBy = normalizedSort == null ? 'rowid' : `${toSortSql('data', normalizedSort)}, rowid`
      const filter = toSql('data', query, this.table)
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

  async findOne (filter: string | Filter = {}, options: FindOptions = {}): Promise<WithId<TSchema> | null> {
    if (typeof filter === 'string') filter = { _id: filter }
    // Delegates to find() with limit 1: same SQL shape (ORDER BY rowid LIMIT 1
    // returns the FIRST match in natural order, like MongoDB - updateOne/
    // deleteOne/replaceOne depend on this), plus sort/projection support.
    const cursor = this.find(filter, { ...options, limit: 1 })
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

  async countDocuments (filter?: Filter): Promise<number> {
    const compiled = toSql('data', filter ?? {}, this.table)
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
  private findOneRow (filter: Filter): { rowid: number, data: string } | null {
    const compiled = toSql('data', filter, this.table)
    const sql = `SELECT rowid, data FROM ${this.table} WHERE (${compiled.sql}) ORDER BY rowid LIMIT 1`
    const row = this.prepare(sql).get(compiled.params) as { rowid: number, data: string } | undefined
    return row ?? null
  }

  async deleteOne (filter: Filter): Promise<DeleteResult> {
    const found = this.findOneRow(filter)
    if (found === null) return { acknowledged: true, deletedCount: 0 }
    const { rowid } = found

    const result = this.run(`DELETE FROM ${this.table} WHERE rowid = :rowid`, { rowid })
    return { acknowledged: true, deletedCount: Number(result.changes) }
  }

  async deleteMany (filter: Filter): Promise<DeleteResult> {
    const compiled = toSql('data', filter, this.table)
    const result = this.run(`DELETE FROM ${this.table} WHERE (${compiled.sql})`, compiled.params)
    return { acknowledged: true, deletedCount: Number(result.changes) }
  }

  async replaceOne (filter: Filter, doc: WithoutId<TSchema>): Promise<UpdateResult> {
    // MongoDB rejects replacement documents whose first key is an operator.
    if (Object.keys(doc)[0]?.startsWith('$') === true) {
      throw Error('replacement document must not contain atomic operators')
    }

    const found = this.findOneRow(filter)
    if (found === null) return updateResult(0, 0)

    const id = parseDocument(found.data)._id
    if (doc._id != null && id !== doc._id) throw Error('_id field is immutable and cannot be changed')

    // `data != json(:doc)` makes a no-op replacement report modifiedCount 0,
    // matching MongoDB (SQLite would otherwise count every touched row). One
    // named parameter serves both occurrences.
    const sql = `UPDATE ${this.table} SET data = json(:doc) WHERE rowid = :rowid AND data != json(:doc)`
    const result = this.run(sql, { rowid: found.rowid, doc: stringifyDocument({ ...doc, _id: id }) })
    return updateResult(1, Number(result.changes))
  }

  /** Updates the first document matching `filter` with $set/$unset/$inc operators. */
  async updateOne (filter: Filter, update: UpdateFilter): Promise<UpdateResult> {
    const expr = buildUpdateExpression(update)

    const found = this.findOneRow(filter)
    if (found === null) return updateResult(0, 0)
    const { rowid } = found

    // `data != <expr>` makes a no-op update report modifiedCount 0, like
    // MongoDB. Each 'u' parameter binds once for both occurrences of expr.
    const sql = `UPDATE ${this.table} SET data = ${expr.sql} WHERE rowid = :rowid AND data != ${expr.sql}`
    const result = this.run(sql, { ...expr.params, rowid })
    return updateResult(1, Number(result.changes))
  }

  /** Updates every document matching `filter` with $set/$unset/$inc operators. */
  async updateMany (filter: Filter, update: UpdateFilter): Promise<UpdateResult> {
    const expr = buildUpdateExpression(update)

    const matchedCount = await this.countDocuments(filter)
    const compiled = toSql('data', filter, this.table)
    // The expression's 'u' params and the filter's 'p' params merge without
    // collisions, by construction (see bindValue / buildUpdateExpression).
    const sql = `UPDATE ${this.table} SET data = ${expr.sql} WHERE (${compiled.sql}) AND data != ${expr.sql}`
    const result = this.run(sql, { ...expr.params, ...compiled.params })
    return updateResult(matchedCount, Number(result.changes))
  }

  async insertOne (doc: TSchema): Promise<InsertOneResult> {
    return {
      acknowledged: true,
      insertedId: (await this.insertMany([doc])).insertedIds[0]!
    }
  }

  async insertMany (docs: TSchema[]): Promise<InsertManyResult> {
    if (!Array.isArray(docs)) throw Error('insertMany expects an array of documents')
    const stmt = this.prepare(`INSERT INTO ${this.table} VALUES(json(?))`)
    const insertedIds: Record<number, string> = {}
    let insertedCount = 0

    // Inserts are ordered and not wrapped in a transaction: like MongoDB's
    // ordered insertMany, a failure part-way through keeps the documents that
    // were already written.
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

    return { acknowledged: true, insertedIds, insertedCount }
  }
}

export interface DbOptions {
  /** Logs every statement to the console. */
  debug: boolean
  /**
   * Milliseconds a write waits behind a competing writer before failing with
   * SQLITE_BUSY. Only meaningful for file-backed databases - WAL mode still
   * serialises writers, and SQLite's default of 0 fails instantly on contention.
   */
  busyTimeoutMs: number
}

/**
 * Bound on the per-connection $regex cache. SQLite calls mdb_regexp once per
 * candidate row, so recompiling the pattern every time is wasteful - but an
 * application building patterns from user input would otherwise grow this map
 * without limit. Past the cap the oldest entry is evicted.
 */
const REGEX_CACHE_LIMIT = 256

export class Db {
  // A Map, not an object: a collection legitimately named '__proto__' or
  // 'constructor' would otherwise resolve to something off Object.prototype
  // and be handed back as if it were a Collection.
  private readonly collections = new Map<string, Collection>()
  private readonly db: DatabaseSync
  private readonly options: DbOptions

  private constructor (db: DatabaseSync, options: DbOptions) {
    this.db = db
    this.options = options
  }

  static async fromUrl (url: string, options: Partial<DbOptions> = {}): Promise<Db> {
    const dbOptions: DbOptions = {
      debug: false,
      busyTimeoutMs: 5000,
      ...options
    }

    const db = new DatabaseSync(url)

    // $regex compiles to calls of this function (src/query/query.ts). It only
    // ever sees strings - the compiled SQL type-guards with json_type - but
    // the typeof check keeps it total. Compiled patterns are cached because
    // SQLite calls the function once per candidate row.
    // Requires Node >= 22.13 (DatabaseSync.prototype.function).
    const regexCache = new Map<string, RegExp>()
    db.function('mdb_regexp', { deterministic: true }, (pattern, flags, value) => {
      if (typeof value !== 'string' || typeof pattern !== 'string' || typeof flags !== 'string') return 0
      const key = `${flags} ${pattern}`
      let regex = regexCache.get(key)
      if (regex === undefined) {
        regex = new RegExp(pattern, flags)
        if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.delete(regexCache.keys().next().value as string)
        regexCache.set(key, regex)
      }
      return regex.test(value) ? 1 : 0
    })

    // Lets a compiled UPDATE expression abort its statement with a real error;
    // SQLite has no RAISE outside triggers. $inc uses it to reject non-numeric
    // fields rather than silently overwriting them (buildUpdateExpression).
    // Deliberately NOT deterministic: its argument is a constant, and SQLite
    // hoists constant deterministic calls out of the row loop - which would
    // raise on every update rather than only on the branch that reaches it.
    db.function('mdb_raise', (message) => {
      throw Error(String(message))
    })

    const pragmas = [
      `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(dbOptions.busyTimeoutMs))}`,
      'PRAGMA journal_mode = WAL' // a no-op for :memory: databases
    ]
    for (const pragma of pragmas) {
      if (dbOptions.debug) console.log(pragma)
      db.exec(pragma)
    }

    return new Db(db, dbOptions)
  }

  /**
   * Opens a collection. Names are case-SENSITIVE, exactly as MongoDB's are:
   * `Users` and `users` are two different collections. (They used to be
   * lowercased into one, silently merging their documents.)
   */
  collection <TSchema extends Document = Document>(name: string): Collection<TSchema> {
    // The type parameter is a caller-side assertion about the collection's
    // contents, not something the cache can verify - the same stance the
    // official MongoDB driver takes. Two callers naming the same collection
    // at different types get whatever is actually stored.
    let collection = this.collections.get(name)
    if (collection === undefined) {
      collection = new Collection(name, this.db, this.options)
      this.collections.set(name, collection)
    }
    return collection as Collection<TSchema>
  }

  async close (): Promise<void> {
    this.db.close()
  }
}

export default Db
