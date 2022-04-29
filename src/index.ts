import { toSql } from './query/query'
import sqlite3 from 'sqlite3'
import { open, Database, ISqlite } from 'sqlite'
import ObjectID from 'bson-objectid'

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
}

export class Collection<TSchema extends Document = Document> {
  private readonly init: Promise<void>

  constructor (private readonly name: string, private readonly db: Database) {
    if (name.match(/^[a-z_]+[a-z0-9_].$/) == null) throw Error('invalid collection name')

    this.name = 'collection_' + name

    this.init = this.db.run(`CREATE TABLE IF NOT EXISTS ${this.name} (data JSON)`)
      .then(async () => await this.db.run(`CREATE UNIQUE INDEX ux_${this.name}_doc_id ON ${this.name}(json_extract(data, '$._id'))`))
      .then(() => undefined)
  }

  find (query: Filter = {}): FindCursor<TSchema> {
    return new class implements FindCursor {
      private currentRowId = -1

      constructor (private readonly outer: Collection) { }

      async next (): Promise<WithId<TSchema> | null> {
        await this.outer.init
        const result = await this.outer.db.get(
          `SELECT rowid, data FROM ${this.outer.name} WHERE rowid > ? AND (${toSql('data', query)}) ORDER BY rowid LIMIT 1`,
          this.currentRowId
        )
        if (result === undefined) return null
        this.currentRowId = result.rowid
        return JSON.parse(result.data)
      }

      async toArray (): Promise<Array<WithId<TSchema>>> {
        const documents: Array<WithId<TSchema>> = []

        let document: WithId<TSchema> | null
        while ((document = await this.next()) !== null) {
          documents.push(document)
        }

        return documents
      }
    }(this)
  }

  async findOne (filter: string | Filter): Promise<WithId<TSchema> | null> {
    await this.init

    if (typeof filter === 'string') filter = { _id: filter }
    const result = await this.db.get(`SELECT data FROM ${this.name} WHERE (${toSql('data', filter)}) LIMIT 1`)

    if (result == null) return null
    else return JSON.parse(result.data)
  }

  async countDocuments (filter?: Filter): Promise<number> {
    await this.init
    const result = await this.db.get(`SELECT COUNT(*) AS count FROM ${this.name} WHERE (${toSql('data', filter ?? {})})`)
    return JSON.parse(result.count)
  }

  async deleteOne (filter: Filter): Promise<DeleteResult> {
    await this.init

    const found = await this.findOne(filter)
    if (found == null) return { deletedCount: 0 }

    const result = await this.db.run(`DELETE FROM ${this.name} WHERE (${toSql('data', { _id: found._id })})`)
    return { deletedCount: result?.changes ?? 0 }
  }

  async deleteMany (filter: Filter): Promise<DeleteResult> {
    await this.init
    const result = await this.db.run(`DELETE FROM ${this.name} WHERE (${toSql('data', filter)})`)
    return { deletedCount: result?.changes ?? 0 }
  }

  async replaceOne (filter: Filter, doc: WithoutId<TSchema>): Promise<UpdateResult> {
    await this.init

    const found = await this.findOne(filter)
    let result
    if (found != null) {
      if (doc._id != null && found._id !== doc._id) throw Error('_id field is immutable and cannot be changed')
      result = await this.db.run(
        `UPDATE ${this.name} SET data = json(?) WHERE ${toSql('data', { _id: found._id })}`,
        JSON.stringify({ ...doc, _id: found._id })
      )
    }
    return { modifiedCount: result?.changes ?? 0 }
  }

  async insertOne (doc: TSchema): Promise<InsertOneResult> {
    await this.init
    return {
      insertedId: (await this.insertMany([doc])).insertedIds[0]
    }
  }

  async insertMany (docs: TSchema[]): Promise<InsertManyResult> {
    await this.init

    const results: Array<{ id: string, index: string, result: ISqlite.RunResult }> = []
    let stmt
    try {
      stmt = await this.db.prepare(`INSERT INTO ${this.name} VALUES(json(?))`)
      for (let index = 0; index < docs.length; index++) {
        const doc = docs[index]
        const id = (doc._id == null) ? new ObjectID().toHexString() : doc._id;
        (doc as unknown as WithId<TSchema>)._id = id
        results.push({
          id,
          index: `${index}`,
          result: await stmt.run(JSON.stringify({ _id: id, ...doc }))
        })
      }
    } finally {
      if (stmt != null) await stmt.finalize()
    }

    const insertedIds = results.reduce<Record<string, string>>(
      (prev, current) => {
        prev[current.index] = current.id
        return prev
      },
      {}
    )

    return {
      insertedIds,
      insertedCount: results.length
    }
  }
}

export class Db {
  private collections: { [key: string]: Collection } = {}

  private constructor (private readonly db: Database) { }

  static async fromUrl (url: string): Promise<Db> {
    const db = await open({
      filename: url,
      driver: sqlite3.Database
    })

    await db.run('PRAGMA journal_mode=WAL')

    return new Db(db)
  }

  collection (name: string): Collection {
    name = name.toLowerCase()
    if (this.collections[name] == null) { this.collections[name] = new Collection(name, this.db) }
    return this.collections[name]
  }

  async close (): Promise<void> {
    return await this.db.close()
  }
}
