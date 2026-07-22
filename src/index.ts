import { DatabaseSync } from 'node:sqlite'
// Documents round-trip through the EJSON layer, not plain JSON: Dates are
// stored as {"$date": ...} and unstorable types are rejected (BACKLOG DR-1).
import { parse as parseDocument, stringify as stringifyDocument } from './ejson.js'
import { objectIdHexString } from './object-id.js'
import { toJson1PathString, toSql, toSqlValue } from './query/query.js'

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

export interface FindCursor<TSchema extends Document = Document> {
  next: () => Promise<WithId<TSchema> | null>
  toArray: () => Promise<Array<WithId<TSchema>>>
  close: () => Promise<void>
  [Symbol.asyncIterator]: () => AsyncIterableIterator<WithId<TSchema>>
}

/** Escapes a SQL identifier for use inside double quotes. */
function sqlName (name: string): string {
  return name.replace(/"/g, '""')
}

const UPDATE_OPERATORS = ['$set', '$unset', '$inc']

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
 * expression computing the new value of the `data` column.
 */
function buildUpdateExpression (update: UpdateFilter): string {
  const keys = Object.keys(update)
  if (keys.length === 0) throw Error('update document must contain atomic operators (e.g. { $set: { ... } })')
  for (const key of keys) {
    if (!UPDATE_OPERATORS.includes(key)) {
      throw Error(key.startsWith('$')
        ? `unsupported update operator: ${key} (supported: ${UPDATE_OPERATORS.join(', ')})`
        : 'update document requires atomic operators (e.g. { $set: { ... } })')
    }
  }

  let expr = 'data'

  if (update.$inc != null) {
    for (const [field, amount] of Object.entries(update.$inc as Record<string, unknown>)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw Error(`$inc requires a finite number for field ${field}; but got: ${String(amount)}`)
      }
      expr = ensureParents(expr, field)
      const path = toJson1PathString([field])
      // Missing fields start from 0, like MongoDB.
      expr = `json_set(${expr}, ${path}, COALESCE(json_extract(data, ${path}), 0) + ${amount})`
    }
  }

  if (update.$unset != null) {
    const paths = Object.keys(update.$unset as Record<string, unknown>).map(field => toJson1PathString([field]))
    if (paths.length > 0) expr = `json_remove(${expr}, ${paths.join(', ')})`
  }

  if (update.$set != null) {
    for (const [field, value] of Object.entries(update.$set as Record<string, unknown>)) {
      if (field === '_id') throw Error('_id field is immutable and cannot be changed')
      expr = ensureParents(expr, field)
      expr = `json_set(${expr}, ${toJson1PathString([field])}, ${toSqlValue(value)})`
    }
  }

  return expr
}

export class Collection<TSchema extends Document = Document> {
  private readonly name: string

  constructor (name: string, private readonly db: DatabaseSync, private readonly dbOptions: DbOptions) {
    if (name.match(/^[a-z_]+[a-z0-9_]*$/) == null) throw Error('invalid collection name: ' + name)

    this.name = 'collection_' + name

    // node:sqlite is synchronous, so a collection is fully usable the moment
    // its constructor returns - no init promise to await on every call.
    this.exec(`CREATE TABLE IF NOT EXISTS ${this.name} (data JSON)`)
    this.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${this.name}_doc_id ON ${this.name}(json_extract(data, '$._id'))`)
  }

  private exec (sql: string): void {
    if (this.dbOptions.debug) console.log(sql)
    this.db.exec(sql)
  }

  private prepare (sql: string): ReturnType<DatabaseSync['prepare']> {
    if (this.dbOptions.debug) console.log(sql)
    return this.db.prepare(sql)
  }

  find (query: Filter = {}): FindCursor<TSchema> {
    // One prepared statement per cursor, streamed with iterate() so a cursor
    // over a large collection stays cheap. ORDER BY rowid gives insertion
    // order, matching MongoDB's natural order in practice - and is safe for
    // index use because comparison predicates compile to `rowid IN (...)`
    // subqueries, whose internal index searches the outer ORDER BY cannot
    // defeat (a bare scalar predicate + ORDER BY rowid, by contrast, makes
    // SQLite pick a rowid scan over a field index - measured).
    // The parens around the filter are load-bearing: $exists compiles to a
    // bare scalar subquery, which is only valid SQL inside parentheses.
    const sql = `SELECT data FROM ${this.name} WHERE (${toSql('data', query, this.name)}) ORDER BY rowid`
    let rows: Iterator<unknown> | undefined
    let done = false

    const next = async (): Promise<WithId<TSchema> | null> => {
      if (done) return null
      rows ??= this.prepare(sql).iterate()
      const row = rows.next()
      if (row.done === true) {
        done = true
        return null
      }
      return parseDocument((row.value as { data: string }).data)
    }

    const close = async (): Promise<void> => {
      done = true
      rows?.return?.(undefined) // finalizes the underlying statement early
    }

    return {
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
  }

  async findOne (filter: string | Filter): Promise<WithId<TSchema> | null> {
    if (typeof filter === 'string') filter = { _id: filter }
    // ORDER BY rowid: findOne returns the FIRST match in natural order, like
    // MongoDB - updateOne/deleteOne/replaceOne depend on this for "one".
    const sql = `SELECT data FROM ${this.name} WHERE (${toSql('data', filter, this.name)}) ORDER BY rowid LIMIT 1`
    const result = this.prepare(sql).get() as { data: string } | undefined

    if (result == null) return null
    else return parseDocument(result.data)
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
    this.exec(`CREATE ${unique}INDEX IF NOT EXISTS "${sqlName(`ix_${this.name}_${name}`)}" ON ${this.name} (${columns})`)

    if (entries.length === 1) {
      const [field, direction] = entries[0]!
      const dateColumn = `json_extract(data, ${toJson1PathString([`${field}.$date`])}) ${direction === 1 ? 'ASC' : 'DESC'}`
      this.exec(`CREATE INDEX IF NOT EXISTS "${sqlName(`ixd_${this.name}_${name}`)}" ON ${this.name} (${dateColumn})`)
    }

    return name
  }

  /** Drops an index by the name createIndex returned. Throws if it does not exist. */
  async dropIndex (name: string): Promise<void> {
    const physical = `ix_${this.name}_${name}`
    const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(physical)
    if (found === undefined) throw Error(`index not found with name [${name}]`)
    this.exec(`DROP INDEX "${sqlName(physical)}"`)
    this.exec(`DROP INDEX IF EXISTS "${sqlName(`ixd_${this.name}_${name}`)}"`)
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
      for (const match of row.sql.matchAll(/json_extract\(data, '([^']+)'\) (ASC|DESC)/g)) {
        // '$.a.b[0]' back to the dotted field form 'a.b.0' used in queries.
        const field = match[1]!.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1')
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
    const sql = `SELECT COUNT(*) AS count FROM ${this.name} WHERE (${toSql('data', filter ?? {}, this.name)})`
    const result = this.prepare(sql).get() as { count: number }
    return Number(result.count)
  }

  async deleteOne (filter: Filter): Promise<DeleteResult> {
    const found = await this.findOne(filter)
    if (found == null) return { acknowledged: true, deletedCount: 0 }

    const sql = `DELETE FROM ${this.name} WHERE (${toSql('data', { _id: found._id }, this.name)})`
    const result = this.prepare(sql).run()
    return { acknowledged: true, deletedCount: Number(result.changes) }
  }

  async deleteMany (filter: Filter): Promise<DeleteResult> {
    const sql = `DELETE FROM ${this.name} WHERE (${toSql('data', filter, this.name)})`
    const result = this.prepare(sql).run()
    return { acknowledged: true, deletedCount: Number(result.changes) }
  }

  async replaceOne (filter: Filter, doc: WithoutId<TSchema>): Promise<UpdateResult> {
    // MongoDB rejects replacement documents whose first key is an operator.
    if (Object.keys(doc)[0]?.startsWith('$') === true) {
      throw Error('replacement document must not contain atomic operators')
    }

    const found = await this.findOne(filter)
    if (found == null) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }

    if (doc._id != null && found._id !== doc._id) throw Error('_id field is immutable and cannot be changed')

    // `data != json(?)` makes a no-op replacement report modifiedCount 0,
    // matching MongoDB (SQLite would otherwise count every touched row).
    const sql = `UPDATE ${this.name} SET data = json(?) WHERE (${toSql('data', { _id: found._id }, this.name)}) AND data != json(?)`
    const text = stringifyDocument({ ...doc, _id: found._id })
    const result = this.prepare(sql).run(text, text)
    return { acknowledged: true, matchedCount: 1, modifiedCount: Number(result.changes), upsertedCount: 0, upsertedId: null }
  }

  /** Updates the first document matching `filter` with $set/$unset/$inc operators. */
  async updateOne (filter: Filter, update: UpdateFilter): Promise<UpdateResult> {
    const expr = buildUpdateExpression(update)

    const found = await this.findOne(filter)
    if (found == null) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }

    // `data != <expr>` makes a no-op update report modifiedCount 0, like MongoDB.
    const sql = `UPDATE ${this.name} SET data = ${expr} WHERE (${toSql('data', { _id: found._id }, this.name)}) AND data != ${expr}`
    const result = this.prepare(sql).run()
    return { acknowledged: true, matchedCount: 1, modifiedCount: Number(result.changes), upsertedCount: 0, upsertedId: null }
  }

  /** Updates every document matching `filter` with $set/$unset/$inc operators. */
  async updateMany (filter: Filter, update: UpdateFilter): Promise<UpdateResult> {
    const expr = buildUpdateExpression(update)

    const matchedCount = await this.countDocuments(filter)
    const sql = `UPDATE ${this.name} SET data = ${expr} WHERE (${toSql('data', filter, this.name)}) AND data != ${expr}`
    const result = this.prepare(sql).run()
    return { acknowledged: true, matchedCount, modifiedCount: Number(result.changes), upsertedCount: 0, upsertedId: null }
  }

  async insertOne (doc: TSchema): Promise<InsertOneResult> {
    return {
      acknowledged: true,
      insertedId: (await this.insertMany([doc])).insertedIds[0]!
    }
  }

  async insertMany (docs: TSchema[]): Promise<InsertManyResult> {
    const stmt = this.prepare(`INSERT INTO ${this.name} VALUES(json(?))`)
    const insertedIds: Record<number, string> = {}
    let insertedCount = 0

    // Inserts are ordered and not wrapped in a transaction: like MongoDB's
    // ordered insertMany, a failure part-way through keeps the documents that
    // were already written.
    for (let index = 0; index < docs.length; index++) {
      const doc = docs[index]!
      const id = (doc._id == null) ? objectIdHexString() : doc._id;
      (doc as unknown as WithId<TSchema>)._id = id
      stmt.run(stringifyDocument({ _id: id, ...doc }))
      insertedIds[index] = id
      insertedCount++
    }

    return { acknowledged: true, insertedIds, insertedCount }
  }
}

export interface DbOptions {
  debug: boolean
}

export class Db {
  private readonly collections: { [key: string]: Collection } = {}

  private constructor (private readonly db: DatabaseSync, private readonly options: DbOptions) { }

  static async fromUrl (url: string, options: Partial<DbOptions> = {}): Promise<Db> {
    const dbOptions: DbOptions = {
      debug: false,
      ...options
    }

    const db = new DatabaseSync(url)

    const sql = 'PRAGMA journal_mode=WAL'
    if (dbOptions.debug) console.log(sql)
    db.exec(sql)

    return new Db(db, dbOptions)
  }

  collection <TSchema extends Document = Document>(name: string): Collection<TSchema> {
    name = name.toLowerCase()
    // The type parameter is a caller-side assertion about the collection's
    // contents, not something the cache can verify - the same stance the
    // official MongoDB driver takes. Two callers naming the same collection
    // at different types get whatever is actually stored.
    return (this.collections[name] ??= new Collection(name, this.db, this.options)) as Collection<TSchema>
  }

  async close (): Promise<void> {
    this.db.close()
  }
}

export default Db
