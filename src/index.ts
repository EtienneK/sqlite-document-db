import convert from './query/filter'
import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'
import ObjectID from 'bson-objectid'

export type Document = Record<string, any> & {
  _id?: string
}

export interface DeleteOneResult {
  deletedCount: number
}

export interface InsertOneResult {
  insertedId: string
}

export interface ReplaceOneResult {
  modifiedCount: number
}

export interface Cursor {
  next: () => Promise<Document | null>
  toArray: () => Promise<{ documents: Document[] }>
}

export class Collection {
  private readonly init: Promise<void>

  constructor (private readonly name: string, private readonly db: Database) {
    if (name.match(/^[a-z_]+[a-z0-9_].$/) == null) throw Error('invalid collection name')

    this.name = 'collection_' + name

    this.init = this.db.run(`
      CREATE TABLE IF NOT EXISTS ${this.name} (
        id TEXT NOT NULL PRIMARY KEY,
        data JSON
      )
    `).then(r => undefined)
  }

  find (query: object = {}): Cursor {
    return new class implements Cursor {
      private currentRowId = -1

      constructor (private readonly outer: Collection) { }

      async next (): Promise<Document | null> {
        await this.outer.init
        const result = await this.outer.db.get(
          `SELECT rowid, id, data FROM ${this.outer.name} WHERE rowid > ? AND (${convert('data', query)}) ORDER BY rowid LIMIT 1`,
          this.currentRowId
        )
        if (result === undefined) return null
        this.currentRowId = result.rowid
        return JSON.parse(result.data)
      }

      async toArray (): Promise<{ documents: Document[] }> {
        const documents: Document[] = []

        let document: Document | null
        while ((document = await this.next()) !== null) {
          documents.push(document)
        }

        return {
          documents
        }
      }
    }(this)
  }

  async findOne (query: string | object): Promise<Document | null> {
    await this.init
    let result: Document | undefined

    if (typeof query === 'string')
      result = await this.db.get(`SELECT id, data FROM ${this.name} WHERE id = ?`, query)
    else
      result = await this.db.get(`SELECT id, data FROM ${this.name} WHERE (${convert('data', query)})`)

    if (result === undefined) return null
    else return JSON.parse(result.data)
  }

  async deleteOne (filter: string): Promise<DeleteOneResult> {
    await this.init
    const result = await this.db.run(`DELETE FROM ${this.name} WHERE id = ?`, filter)
    return { deletedCount: result?.changes ?? 0 }
  }

  async replaceOne (filter: string, doc: Document): Promise<ReplaceOneResult> {
    await this.init
    const result = await this.db.run(`UPDATE ${this.name} SET data = json(?) WHERE id = ?`, JSON.stringify({ ...doc, _id: filter }), filter)
    return { modifiedCount: result?.changes ?? 0 }
  }

  async insertOne (doc: Document): Promise<InsertOneResult> {
    await this.init
    const id = (doc._id === undefined) ? new ObjectID().toHexString() : doc._id
    await this.db.run(`INSERT INTO ${this.name} VALUES(?, json(?))`, id, JSON.stringify({ _id: id, ...doc }))
    return {
      insertedId: id
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
