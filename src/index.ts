import { DatabaseSync } from 'node:sqlite'
// Documents round-trip through the EJSON layer, not plain JSON: Dates are
// stored as {"$date": ...} and unstorable types are rejected (BACKLOG DR-1).
import { parse as parseDocument, stringify as stringifyDocument } from './ejson.js'
import { objectIdHexString } from './object-id.js'
import { toSql } from './query/query.js'

export declare interface Document {
  [key: string]: any
}

export declare type WithoutId<TSchema extends Document = Document> = Omit<TSchema, '_id'>

export declare type WithId<TSchema extends Document = Document> = WithoutId<TSchema> & {
  _id: string
}

export type Filter = Record<string, any>

export interface DeleteResult {
  deletedCount: number
}

export interface InsertManyResult {
  insertedCount: number
  insertedIds: Record<number, string>
}

export interface InsertOneResult {
  insertedId: string
}

export interface UpdateResult {
  modifiedCount: number
}

export interface FindCursor<TSchema extends Document = Document> {
  next: () => Promise<WithId<TSchema> | null>
  toArray: () => Promise<Array<WithId<TSchema>>>
  close: () => Promise<void>
  [Symbol.asyncIterator]: () => AsyncIterableIterator<WithId<TSchema>>
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
    // over a large collection stays cheap. Deliberately no ORDER BY: like
    // MongoDB, order without sort() is unspecified - and even a bare
    // `ORDER BY rowid` makes SQLite pick a rowid-order scan over a field
    // index (measured via EXPLAIN QUERY PLAN), which would defeat indexing.
    // The parens around the filter are load-bearing: $exists compiles to a
    // bare scalar subquery, which is only valid SQL inside parentheses.
    const sql = `SELECT data FROM ${this.name} WHERE (${toSql('data', query)})`
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
    const sql = `SELECT data FROM ${this.name} WHERE (${toSql('data', filter)}) LIMIT 1`
    const result = this.prepare(sql).get() as { data: string } | undefined

    if (result == null) return null
    else return parseDocument(result.data)
  }

  async countDocuments (filter?: Filter): Promise<number> {
    const sql = `SELECT COUNT(*) AS count FROM ${this.name} WHERE (${toSql('data', filter ?? {})})`
    const result = this.prepare(sql).get() as { count: number }
    return Number(result.count)
  }

  async deleteOne (filter: Filter): Promise<DeleteResult> {
    const found = await this.findOne(filter)
    if (found == null) return { deletedCount: 0 }

    const sql = `DELETE FROM ${this.name} WHERE (${toSql('data', { _id: found._id })})`
    const result = this.prepare(sql).run()
    return { deletedCount: Number(result.changes) }
  }

  async deleteMany (filter: Filter): Promise<DeleteResult> {
    const sql = `DELETE FROM ${this.name} WHERE (${toSql('data', filter)})`
    const result = this.prepare(sql).run()
    return { deletedCount: Number(result.changes) }
  }

  async replaceOne (filter: Filter, doc: WithoutId<TSchema>): Promise<UpdateResult> {
    const found = await this.findOne(filter)
    if (found == null) return { modifiedCount: 0 }

    if (doc._id != null && found._id !== doc._id) throw Error('_id field is immutable and cannot be changed')

    const sql = `UPDATE ${this.name} SET data = json(?) WHERE ${toSql('data', { _id: found._id })}`
    const result = this.prepare(sql).run(stringifyDocument({ ...doc, _id: found._id }))
    return { modifiedCount: Number(result.changes) }
  }

  async insertOne (doc: TSchema): Promise<InsertOneResult> {
    return {
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

    return { insertedIds, insertedCount }
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
