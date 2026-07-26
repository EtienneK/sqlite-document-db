/**
 * A `MongoClient`-shaped entry point (BACKLOG item 22).
 *
 * This exists for ONE use case the README already claims: running a test suite
 * against this library instead of a real `mongod`. Without it that swap means
 * editing every `MongoClient.connect(uri)` and `client.db(name)`; with it, it is
 * a one-line import change:
 *
 * ```javascript
 * import { MongoClient } from 'sqlite-document-db'   // was: from 'mongodb'
 * ```
 *
 * **It is a shim, not a driver.** There is no server and no connection pool, and
 * the surface here says so rather than pretending: `watch` throws an error
 * naming what to use instead. What it does promise is the part this library can
 * evidence - the CRUD, query, update, aggregation and transaction subset,
 * checked assertion for assertion against a real MongoDB.
 *
 * `startSession()` DOES work (see src/client-session.ts), because
 * `session.withTransaction()` is how a great deal of MongoDB transaction code
 * is written and rewriting it is the one thing this file exists to avoid. What
 * a session cannot do here is route an operation around a transaction, and that
 * limit is documented on `ClientSession` and enforced under `strict`.
 *
 * Two deliberate leniencies, both because refusing would defeat the point:
 *
 * - **A `mongodb://` URI is accepted**, and opens an IN-MEMORY database. A test
 *   suite's connection string usually comes from configuration, so refusing it
 *   would mean editing the very line the shim exists to leave alone.
 * - **Connection options are ignored** (`maxPoolSize`, `tls`, `retryWrites`,
 *   ...). They describe a network client that is not here, and unlike an
 *   unimplemented OPERATOR they cannot produce a wrong answer - there is
 *   nothing for them to be wrong about. The options this library does have
 *   (`strict`, `busyTimeoutMs`, `debug`) are read from the same object.
 */

import { ClientSession, type ClientSessionOptions } from './client-session.js'
import { Db } from './db.js'
import type { DbOptions } from './types.js'

/** Where a `MongoClient` URL points, once the MongoDB spellings are resolved. */
interface Target {
  /** The SQLite database: a file path, or ':memory:'. */
  file: string
  /** The database named in a `mongodb://host/<name>` URI, when there is one. */
  defaultDatabase?: string
}

const MONGODB_URI = /^mongodb(?:\+srv)?:\/\/[^/?]*(?:\/([^/?]*))?/

function resolveUrl (url: string): Target {
  if (typeof url !== 'string' || url === '') throw Error('a connection string is required')

  const mongo = MONGODB_URI.exec(url)
  if (mongo === null) return { file: url } // a path, or ':memory:'

  // There is no server to reach, so a MongoDB URI means "somewhere private" -
  // which for a test double is exactly right.
  const name = mongo[1]
  return { file: ':memory:', ...(name === undefined || name === '' ? {} : { defaultDatabase: name }) }
}

/** The database the driver uses when the connection string names none. */
const DEFAULT_DATABASE = 'test'

export interface MongoClientOptions extends Partial<DbOptions> {
  /**
   * Anything else a real driver takes. Ignored - see the note at the top of
   * this file - so a connection string and its options can stay as they were.
   */
  [option: string]: unknown
}

export class MongoClient {
  private readonly target: Target
  private readonly options: Partial<DbOptions>
  private readonly databases = new Map<string, Db>()
  /** Live sessions, so `close()` can end them the way the driver does. */
  private readonly sessions = new Set<ClientSession>()
  private closed = false

  constructor (url: string, options: MongoClientOptions = {}) {
    this.target = resolveUrl(url)
    // Only the options this library actually has are carried over; the rest
    // belong to a network client and mean nothing here.
    this.options = {}
    if (typeof options.strict === 'boolean') this.options.strict = options.strict
    if (typeof options.debug === 'boolean') this.options.debug = options.debug
    if (typeof options.busyTimeoutMs === 'number') this.options.busyTimeoutMs = options.busyTimeoutMs
  }

  /** Connects and returns the client, as `MongoClient.connect(uri)` does. */
  static async connect (url: string, options: MongoClientOptions = {}): Promise<MongoClient> {
    return await new MongoClient(url, options).connect()
  }

  /**
   * A no-op that returns the client.
   *
   * Nothing is opened until a database is asked for - there is no handshake to
   * perform - but the method exists because calling code calls it.
   */
  async connect (): Promise<this> {
    this.closed = false
    return this
  }

  /**
   * The database of that name, opened on first use and cached after.
   *
   * Synchronous, like the driver's, which is what `Db.openSync` exists for.
   *
   * **An in-memory client gets one database per name**, isolated from the
   * others exactly as MongoDB's are. A FILE-backed client has only one - a
   * SQLite file IS a database, not a server - so asking it for a second name is
   * an error rather than a silent merge of two names into one set of
   * collections. (That merge is the bug `tableNameFor` exists to prevent one
   * level down; it would be a shame to reintroduce it here.)
   */
  db (name: string = this.target.defaultDatabase ?? DEFAULT_DATABASE): Db {
    if (this.closed) throw Error('MongoClient is closed')
    if (typeof name !== 'string' || name === '') throw Error('a database name must be a non-empty string')

    const existing = this.databases.get(name)
    if (existing !== undefined) return existing

    if (this.target.file !== ':memory:' && this.databases.size > 0) {
      throw Error(
        `this client is backed by the file '${this.target.file}', which is ONE database ` +
        `(already open as '${[...this.databases.keys()][0]!}') - open a second client for '${name}', ` +
        'or connect in memory, where each name is its own database'
      )
    }

    const opened = Db.openSync(this.target.file, { ...this.options, databaseName: name })
    this.databases.set(name, opened)
    return opened
  }

  /** Closes every database this client opened, ending its sessions first. */
  async close (): Promise<void> {
    // Ending a session rolls back any transaction still open on it, so this
    // order is what keeps a forgotten commit from being decided by db.close().
    // Over a copy: endSession removes the session from the set it is iterating.
    for (const session of Array.from(this.sessions)) await session.endSession()
    for (const db of this.databases.values()) await db.close()
    this.databases.clear()
    this.closed = true
  }

  /**
   * A session, for `session.withTransaction(work)` and `{ session }`.
   *
   * Options are accepted and ignored, on the same grounds as the connection
   * options above: `causalConsistency`, `readConcern` and `writeConcern`
   * describe a replica set, and one connection to a local database satisfies
   * the first trivially and has nothing for the other two to mean.
   *
   * What a session is and is not able to do here is set out on `ClientSession`
   * - in short, it can carry a transaction, and it cannot keep an operation
   * OUT of one.
   */
  startSession (_options: ClientSessionOptions = {}): ClientSession {
    if (this.closed) throw Error('MongoClient is closed')
    const session: ClientSession = new ClientSession(
      // A session may only be used on a database this client opened - the
      // driver's "ClientSession must be from the same MongoClient".
      database => [...this.databases.values()].some(db => db === database),
      () => this.sessions.delete(session)
    )
    this.sessions.add(session)
    return session
  }

  /** Runs `work` with a session, ending it afterwards however `work` finishes. */
  async withSession <T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.startSession()
    try {
      return await work(session)
    } finally {
      await session.endSession()
    }
  }

  watch (): never {
    throw Error(
      'change streams are not supported: they read a replica set oplog, which an embedded database ' +
      'does not have. A process that needs them needs a server'
    )
  }
}
