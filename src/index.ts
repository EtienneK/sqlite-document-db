import convert from './query/filter'
import sqlite3 from 'sqlite3'
import { open, Database, ISqlite } from 'sqlite'
import ObjectID from 'bson-objectid'

export type Document = Record<string, any> & {
  _id?: string
}

export type Filter = Record<string, any>

export interface DeleteOneResult {
  deletedCount: number
}

export interface InsertManyResult {
  insertedCount: number
  insertedIds: Record<number, string>
}

export interface InsertOneResult {
  insertedId: string
}

export interface ReplaceOneResult {
  modifiedCount: number
}

export interface Cursor {
  next: () => Promise<Document | null>
  toArray: () => Promise<Document[]>
}

export class Collection {
  private readonly init: Promise<void>

  constructor (private readonly name: string, private readonly db: Database) {
    if (name.match(/^[a-z_]+[a-z0-9_].$/) == null) throw Error('invalid collection name')

    this.name = 'collection_' + name

    this.init = this.db.run(`CREATE TABLE IF NOT EXISTS ${this.name} (data JSON)`)
      .then(async _ => await this.db.run(`CREATE UNIQUE INDEX ux_${this.name}_doc_id ON ${this.name}(json_extract(data, '$._id'))`))
      .then(_ => undefined)
  }

  find (query: Filter = {}): Cursor {
    return new class implements Cursor {
      private currentRowId = -1

      constructor (private readonly outer: Collection) { }

      async next (): Promise<Document | null> {
        await this.outer.init
        const result = await this.outer.db.get(
          `SELECT rowid, data FROM ${this.outer.name} WHERE rowid > ? AND (${convert('data', query)}) ORDER BY rowid LIMIT 1`,
          this.currentRowId
        )
        if (result === undefined) return null
        this.currentRowId = result.rowid
        return JSON.parse(result.data)
      }

      async toArray (): Promise<Document[]> {
        const documents: Document[] = []

        let document: Document | null
        while ((document = await this.next()) !== null) {
          documents.push(document)
        }

        return documents
      }
    }(this)
  }

  async findOne (query: string | Filter): Promise<Document | null> {
    await this.init

    if (typeof query === 'string') query = { _id: query }
    const result = await this.db.get(`SELECT data FROM ${this.name} WHERE (${convert('data', query)})`)

    if (result === undefined) return null
    else return JSON.parse(result.data)
  }

  async deleteOne (filter: Filter): Promise<DeleteOneResult> {
    await this.init
    const result = await this.db.run(`DELETE FROM ${this.name} WHERE (${convert('data', filter)})`)
    return { deletedCount: result?.changes ?? 0 }
  }

  async replaceOne (filter: Filter, doc: Document): Promise<ReplaceOneResult> {
    await this.init

    const found = await this.findOne(filter)
    let result
    if (found !== null) {
      if (doc._id !== undefined && found._id !== doc._id) throw Error('_id field is immutable and cannot be changed')
      result = await this.db.run(
        `UPDATE ${this.name} SET data = json(?) WHERE ${convert('data', { _id: found._id })}`,
        JSON.stringify({ ...doc, _id: found._id })
      )
    }
    return { modifiedCount: result?.changes ?? 0 }
  }

  async insertOne (doc: Document): Promise<InsertOneResult> {
    await this.init
    return {
      insertedId: (await this.insertMany([doc])).insertedIds[0]
    }
  }

  async insertMany (docs: Document[]): Promise<InsertManyResult> {
    await this.init

    const results: Array<{ id: string, index: string, result: ISqlite.RunResult }> = []
    let stmt
    try {
      stmt = await this.db.prepare(`INSERT INTO ${this.name} VALUES(json(?))`)
      for (let index = 0; index < docs.length; index++) {
        const doc = docs[index]
        const id = (doc._id === undefined) ? new ObjectID().toHexString() : doc._id
        results.push({
          id,
          index: `${index}`,
          result: await stmt.run(JSON.stringify({ _id: id, ...doc }))
        })
      }
    } finally {
      if (stmt !== undefined) await stmt.finalize()
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

export default class Db {
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
    if (this.collections[name] === undefined) { this.collections[name] = new Collection(name, this.db) }
    return this.collections[name]
  }

  async close (): Promise<void> {
    return await this.db.close()
  }
}
