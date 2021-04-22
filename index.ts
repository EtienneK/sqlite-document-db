import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'
import ObjectID from 'bson-objectid'

type Document = Record<string, any> & {
  _id?: string
}

interface DeleteOneResult {
  deletedCount: number
}

interface InsertOneResult {
  insertedId: string
}

interface ReplaceOneResult {
  modifiedCount: number
}

interface Cursor {
  next (): Promise<Document | null>
}

class Collection {
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

  find (): Cursor {
    let currentRowId = -1
    return {
      next: async () => {
        await this.init
        const result = await this.db.get(
          `SELECT rowid, id, data FROM ${this.name} WHERE rowid > ? ORDER BY rowid LIMIT 1`,
          currentRowId
        )
        if (result === undefined) return null
        currentRowId = result.rowid
        return { _id: result.id, ...JSON.parse(result.data) }
      }
    }
  }

  async findOne (filter: string): Promise<Document | null> {
    await this.init
    const result = await this.db.get(`SELECT id, data FROM ${this.name} WHERE id = ?`, filter)
    if (result === undefined) return null
    else return { _id: result.id, ...JSON.parse(result.data) }
  }

  async deleteOne (filter: string): Promise<DeleteOneResult> {
    await this.init
    const result = await this.db.run(`DELETE FROM ${this.name} WHERE id = ?`, filter)
    return { deletedCount: result.changes ? result.changes : 0 }
  }

  async replaceOne(filter: string, doc: Document): Promise<ReplaceOneResult> {
    await this.init
    const result = await this.db.run(`UPDATE ${this.name} SET data = json(?) WHERE id = ?`, JSON.stringify({ ...doc, _id: undefined }), filter)
    return { modifiedCount: result.changes ? result.changes : 0 }
  }

  async insertOne (doc: Document): Promise<InsertOneResult> {
    await this.init
    const id = (doc._id == undefined) ? new ObjectID().toHexString() : doc._id
    await this.db.run(`INSERT INTO ${this.name} VALUES(?, json(?))`, id, JSON.stringify(doc))
    return {
      insertedId: id
    }
  }
}

export class Db {
  private collections: { [key: string]: Collection } = {}

  constructor (private readonly db: Database) { }

  collection (name: string): Collection {
    name = name.toLowerCase()
    if (this.collections[name] === undefined) { this.collections[name] = new Collection(name, this.db) }
    return this.collections[name]
  }

  async close() {
    return this.db.close()
  }

}

export default class Json1Client {
  static async connect (url: string): Promise<Db> {
    const db = await open({
      filename: url,
      driver: sqlite3.Database
    })
    return new Db(db)
  }
}
