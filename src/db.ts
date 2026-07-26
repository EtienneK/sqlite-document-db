/**
 * `Db` - the connection, and the collections on it.
 *
 * Split out of index.ts so that file can be nothing but exports. The dependency
 * rule (see CLAUDE.md) is that NOTHING imports the entry point; with `Db` here,
 * that holds by construction rather than by care - src/mongo-client.ts needs the
 * class, and importing it from index.ts would have made the graph circular.
 */

import { ChangeHub, ChangeStream, changeEvent } from './change-stream.js'
import { ClientSession } from './client-session.js'
import {
  assertValidCollectionName, changeHubHost, Collection, collectionNames, collectionTables, dropRegistry,
  tableNameFor
} from './collection.js'
import type { Driver } from './driver.js'
import { nodeSqliteDriver } from './drivers/node-sqlite.js'
import { parse as parseDocument } from './ejson.js'
import { evaluateExpression, isTruthy } from './expression.js'
import { quoteIdentifier } from './query.js'
import { createRawSql, sqlFragment, type RawSql, type SqlFragment } from './raw-sql.js'
import { cachingDriver } from './statement-cache.js'
import type {
  ChangeStreamOptions, CollectionInfo, CreateCollectionOptions, DbOptions, DbStats, DbStatsOptions,
  Document, DropDatabaseOptions, ListCollectionsOptions, RenameOptions, SessionHost, TransactionFrame
} from './types.js'

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
  private readonly db: Driver
  private readonly options: DbOptions
  /** How many `withTransaction` callbacks are currently on the stack. */
  private transactionDepth = 0

  /**
   * The raw SQL escape hatch: `db.sql.all`, `db.sql.get` and `db.sql.run`, each
   * a tagged template whose interpolations are BOUND rather than spliced.
   *
   * ```javascript
   * const busiest = await db.sql.all`
   *   SELECT json_extract(data, '$.city') AS city, COUNT(*) AS n
   *   FROM ${db.table('places')}
   *   GROUP BY city HAVING n > ${threshold}
   *   ORDER BY n DESC`
   * ```
   *
   * It runs on THIS connection, so it sees uncommitted writes and takes part in
   * `withTransaction` without anything being threaded through. Rows come back
   * raw - a document is the `data` column's JSON text until `parseDocument`
   * decodes it. See src/raw-sql.ts for why.
   */
  readonly sql: RawSql

  /**
   * What a `ClientSession` needs from this database, handed to every
   * `Collection` opened on it - the same way `onDrop` is.
   *
   * The transaction primitives live behind it rather than on the class because
   * `withTransaction` is deliberately the only transaction SHAPE this library
   * offers (see its comment); a public begin/commit pair would be a second one,
   * and a worse one.
   */
  private readonly sessions: SessionHost

  /**
   * Where change events go (BACKLOG item 27). One per connection, shared with
   * every `Collection` this database opens - which is what makes `db.watch()`
   * see all of them and `collection.watch()` see one.
   */
  private readonly changes: ChangeHub

  private constructor (db: Driver, options: DbOptions) {
    this.db = db
    this.options = options
    this.changes = new ChangeHub(changeHubHost(db, options, 'db'))
    this.sql = createRawSql(db, () => this.options.debug, statement => this.observeRawStatement(statement))
    this.sessions = {
      database: this,
      strict: options.strict,
      activeSession: null,
      begin: () => this.enterTransaction(),
      commit: frame => this.commitFrame(frame),
      rollback: frame => this.rollbackFrame(frame)
    }
  }

  static async fromUrl (url: string, options: Partial<DbOptions> = {}): Promise<Db> {
    return await Db.fromDriver(nodeSqliteDriver(url), options)
  }

  /**
   * `fromUrl` without the promise.
   *
   * It exists because the MongoDB driver's `client.db(name)` is SYNCHRONOUS, so
   * the shim in src/mongo-client.ts cannot await anything - and opening a
   * `node:sqlite` database genuinely is synchronous, so the promise `fromUrl`
   * returns is API symmetry rather than work.
   *
   * **This is a synchronous assumption, and a deliberate one** (see the driver
   * seam notes in CLAUDE.md): it works only with a synchronous `Driver`, which
   * the bundled one is. When an async engine lands, this method and the shim on
   * top of it are two of the places that have to change - visibly, at compile
   * time. Prefer `fromUrl` everywhere else.
   */
  static openSync (url: string, options: Partial<DbOptions> = {}): Db {
    return Db.open(nodeSqliteDriver(url), options)
  }

  /**
   * Opens a database on a caller-supplied driver.
   *
   * This is the seam DR-3 describes: the core is HANDED an engine rather than
   * importing one, which is what keeps "zero runtime dependencies" true no
   * matter what other engines exist. A PostgreSQL or libSQL backend is a
   * separate package that implements `Driver` and calls this - it never becomes
   * a dependency of this one.
   *
   * `fromUrl` is this with the bundled `node:sqlite` driver already chosen.
   */
  static async fromDriver (db: Driver, options: Partial<DbOptions> = {}): Promise<Db> {
    return Db.open(db, options)
  }

  /** The body of `fromDriver`, which does no awaiting. See `openSync`. */
  private static open (raw: Driver, options: Partial<DbOptions> = {}): Db {
    // Every statement this library compiles binds its values as named
    // parameters, so the same operation is the same SQL text - wrapping the
    // driver HERE (whatever engine it is) means every call site below reuses
    // prepared statements without knowing a cache exists. See
    // src/statement-cache.ts for the cursor-lifetime rules that make it safe.
    const db = cachingDriver(raw)
    const dbOptions: DbOptions = {
      debug: false,
      strict: false,
      busyTimeoutMs: 5000,
      ...options
    }

    // $regex compiles to calls of this function (src/query.ts). It only
    // ever sees strings - the compiled SQL type-guards with json_type - but
    // the typeof check keeps it total. Compiled patterns are cached because
    // SQLite calls the function once per candidate row.
    // Requires Node >= 22.13 (DatabaseSync.prototype.function).
    // Engines without user-defined functions (libSQL, Turso - see DR-3) will
    // need $regex to fall back to filtering in JavaScript. Guarding the
    // registration is the first half of that; the compiler side is item 24.
    const regexCache = new Map<string, RegExp>()
    const expressionCache = new Map<string, unknown>()
    if (db.supportsFunctions && db.createFunction !== undefined) {
      db.createFunction('mdb_regexp', (pattern, flags, value) => {
        if (typeof value !== 'string' || typeof pattern !== 'string' || typeof flags !== 'string') return 0
        const key = `${flags}:${pattern}`
        let regex = regexCache.get(key)
        if (regex === undefined) {
          regex = new RegExp(pattern, flags)
          if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.delete(regexCache.keys().next().value as string)
          regexCache.set(key, regex)
        }
        return regex.test(value) ? 1 : 0
      })

      // $expr: the aggregation expression language, evaluated per candidate
      // row (see the $expr case in src/query.ts for why it is not compiled to
      // SQL). The expression arrives as its storage JSON and is parsed once per
      // DISTINCT expression rather than once per row; the document has to be
      // parsed every time, which is why $expr is a scan and says so.
      db.createFunction('mdb_expr', (expression, document) => {
        if (typeof expression !== 'string' || typeof document !== 'string') return 0
        let parsed = expressionCache.get(expression)
        if (parsed === undefined) {
          parsed = parseDocument(expression)
          if (expressionCache.size >= REGEX_CACHE_LIMIT) {
            expressionCache.delete(expressionCache.keys().next().value as string)
          }
          expressionCache.set(expression, parsed)
        }
        try {
          return isTruthy(evaluateExpression(parsed, parseDocument(document), dbOptions.strict)) ? 1 : 0
        } catch {
          // A TYPE error against ONE document is not a match, and is not fatal.
          // It also cannot be surfaced: an exception thrown from a
          // db.function() callback is SWALLOWED on the Node 22.13 floor and
          // propagates on Node 26, so letting it out would make the same query
          // behave differently on two supported runtimes. Structural mistakes
          // (an unknown operator, wrong arity) are caught at compile time
          // instead - see assertKnownExpressionOperators.
          return 0
        }
      })
    }

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
      collection = new Collection(
        name, this.db, this.options, () => this.collections.delete(name), this.sessions,
        // A rename leaves BOTH names stale in the cache: the source instance is
        // bound to a table that is gone, and any instance already opened under
        // the target name was bound to the table the rename replaced.
        target => {
          this.collections.delete(target)
          return this.collection(target)
        },
        this.changes
      )
      this.collections.set(name, collection)
    }
    return collection as Collection<TSchema>
  }

  /**
   * The name this database was opened under.
   *
   * A SQLite file has no name of its own, so this is whatever `databaseName`
   * said - `MongoClient.db(name)` sets it. It names nothing physical.
   */
  get databaseName (): string {
    return this.options.databaseName ?? ''
  }

  /**
   * Creates a collection and returns it.
   *
   * Collections are created eagerly here, so this is `collection()` under the
   * name the driver uses for it. Options are rejected rather than ignored:
   * capped collections, validators and collations are not implemented, and
   * accepting the option while not honouring it is the failure mode this
   * library avoids everywhere else.
   */
  async createCollection <TSchema extends Document = Document>(
    name: string, options: CreateCollectionOptions & Record<string, unknown> = {}
  ): Promise<Collection<TSchema>> {
    const unsupported = Object.keys(options).find(option => option !== 'session')
    if (unsupported !== undefined) {
      throw Error(`createCollection does not support the '${unsupported}' option`)
    }
    ClientSession.enlist(options.session, this.sessions)
    return this.collection<TSchema>(name)
  }

  /**
   * The physical table backing a collection, quoted and ready to splice into a
   * `db.sql` template - the one interpolation that is NOT bound.
   *
   * It exists because the mapping is not guessable: `tableNameFor()` sends a
   * simple name to `collection_<name>` but anything else to
   * `collectionx_<slug>_<digest>`, since SQLite compares identifiers
   * case-insensitively and `Users` and `users` are two collections. Reproducing
   * that by hand is exactly the kind of duplicated rule that drifts.
   *
   * ```javascript
   * await db.sql.all`SELECT rowid, data FROM ${db.table('users')} LIMIT 5`
   * ```
   *
   * Naming a collection does NOT create it - `db.collection(name)` does that.
   * Ask for a table nothing has opened and SQLite answers "no such table".
   */
  table (collectionName: string): SqlFragment {
    assertValidCollectionName(collectionName)
    return sqlFragment(quoteIdentifier(tableNameFor(collectionName)))
  }

  /**
   * The collections in this database.
   *
   * Returns a cursor-shaped object like the driver's, so `.toArray()` is the
   * way in. Names come from the registry `Collection` writes when it opens one
   * (see REGISTRY_TABLE) - the physical table name cannot always be reversed.
   *
   * The `filter` the driver takes is accepted only when it is empty: selecting
   * collections by name or by options is not implemented, and ignoring the
   * argument would answer a question nobody asked.
   */
  listCollections (
    filter: Document = {}, options: ListCollectionsOptions = {}
  ): { toArray: () => Promise<CollectionInfo[]> } {
    const unsupported = Object.keys(filter)[0]
    if (unsupported !== undefined) {
      throw Error(`listCollections does not support a filter (got '${unsupported}')`)
    }
    ClientSession.enlist(options.session, this.sessions)
    return {
      toArray: async () => collectionNames(this.db).map(name => ({ name, type: 'collection' as const }))
    }
  }

  /**
   * What is in this database, and what it costs on disk.
   *
   * The counts are EXACT and mean what they do on MongoDB - `collections`,
   * `objects` and `dataSize` (the JSON bytes of every document) are the ones
   * worth reading. The byte figures below them describe a SQLite FILE:
   * `storageSize` is `page_count * page_size`, which includes the free list and
   * every index, and `indexSize` comes from SQLite's own `dbstat` table when
   * the build has it (it is optional) and is 0 when it does not. They are not
   * comparable with a real server's, and nothing else here pretends they are.
   *
   * `db.command()` is deliberately NOT implemented: it is the whole wire
   * protocol behind one method, and there is no wire.
   */
  async stats (options: DbStatsOptions = {}): Promise<DbStats> {
    ClientSession.enlist(options.session, this.sessions)
    let objects = 0
    let dataSize = 0
    const tables = collectionTables(this.db)
    for (const table of tables) {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS bytes FROM ${quoteIdentifier(table)}`
      ).get() as { n: number, bytes: number }
      objects += Number(row.n)
      dataSize += Number(row.bytes)
    }
    // Only the indexes on COLLECTION tables, so the name registry's own does
    // not show up as one a caller created.
    const collectionIndexes = this.db.prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'"
    ).all() as Array<{ name: string, tbl_name: string }>
    const indexes = collectionIndexes.filter(index => tables.includes(index.tbl_name)).length

    const pages = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    const pageSize = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
    const storageSize = Number(pages) * Number(pageSize)

    let indexSize = 0
    try {
      // dbstat is a compile-time option, so this is asked for rather than
      // assumed - and answered with 0 rather than an error when it is absent.
      const sizes = this.db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name')
        .all() as Array<{ name: string, bytes: number }>
      const indexNames = new Set(collectionIndexes.map(index => index.name))
      indexSize = sizes.filter(row => indexNames.has(row.name))
        .reduce((total, row) => total + Number(row.bytes), 0)
    } catch { /* this SQLite was built without dbstat */ }

    return {
      db: this.databaseName,
      collections: tables.length,
      objects,
      avgObjSize: objects === 0 ? 0 : dataSize / objects,
      dataSize,
      storageSize,
      indexes: Number(indexes),
      indexSize,
      totalSize: storageSize,
      ok: 1
    }
  }

  /**
   * Watches every collection in this database for changes (BACKLOG item 27).
   *
   * ```javascript
   * const stream = db.watch([{ $match: { operationType: 'delete' } }])
   * for await (const event of stream) console.log(event.ns.coll, event.documentKey)
   * ```
   *
   * `collection.watch()` is the same thing scoped to one collection, and
   * `MongoClient.watch()` the same thing across every database a client opened.
   * What a stream here can and cannot see is set out on `ChangeStream` in
   * src/change-stream.ts.
   */
  watch <TDocument extends Document = Document>(
    pipeline: Document[] = [], options: ChangeStreamOptions = {}
  ): ChangeStream<TDocument> {
    ClientSession.enlist(options.session, this.sessions)
    const stream = new ChangeStream<TDocument>({ db: this.databaseName }, pipeline, options)
    stream.listenTo(this.changes)
    return stream
  }

  /**
   * Subscribes an already-open stream to this database's events.
   *
   * The seam `MongoClient.watch()` needs: a client can hold several databases,
   * each its own connection and so its own hub, and one client-wide stream has
   * to listen to all of them - including the ones opened after it started.
   * Prefer `db.watch()`, which is the same thing for one database.
   */
  attachChangeStream (stream: ChangeStream<any>): void {
    stream.listenTo(this.changes)
  }

  /**
   * Runs a `db.sql` statement, reporting to any open change stream whether it
   * wrote anything.
   *
   * Intercepting raw SQL properly would mean parsing it, so this asks SQLite
   * instead: `total_changes()` counts every row this CONNECTION has changed, so
   * a difference across the statement means rows moved that no change event can
   * describe. The stream is then ended with an `invalidate` rather than
   * carrying on as if nothing had happened. Two extra statements, and only
   * while something is watching.
   */
  private observeRawStatement <T>(statement: () => T): T {
    if (!this.changes.watching) return statement()
    const before = this.totalChanges()
    const result = statement()
    if (this.totalChanges() !== before) this.changes.reportOpaqueWrite()
    return result
  }

  private totalChanges (): number {
    const row = this.db.prepare('SELECT total_changes() AS changed').get() as { changed: number }
    return Number(row.changed)
  }

  /**
   * Renames a collection. `collection.rename()` is the same operation from the
   * other end, and both return the collection under its new name.
   */
  async renameCollection <TSchema extends Document = Document>(
    from: string, to: string, options: RenameOptions = {}
  ): Promise<Collection<TSchema>> {
    return await this.collection(from).rename(to, options) as Collection<TSchema>
  }

  /**
   * Drops every collection, and the registry with them.
   *
   * The `Collection` cache is cleared too: each cached instance is bound to a
   * table that no longer exists, and would otherwise keep being handed out.
   */
  async dropDatabase (options: DropDatabaseOptions = {}): Promise<boolean> {
    ClientSession.enlist(options.session, this.sessions)
    // Read before dropping: the registry is one of the things that goes.
    const dropped = this.changes.watching ? collectionNames(this.db) : []
    for (const table of collectionTables(this.db)) {
      this.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`)
    }
    dropRegistry(this.db)
    this.collections.clear()

    if (this.changes.watching) {
      // A `drop` per collection and then `dropDatabase`, which is the sequence
      // a server emits. The single invalidate that follows names no collection,
      // and so ends the collection streams as well as the database ones - see
      // ChangeStream.invalidatedBy.
      for (const coll of dropped) {
        this.changes.emit(changeEvent('drop', { ns: { db: this.databaseName, coll } }))
      }
      this.changes.emit(changeEvent('dropDatabase', { ns: { db: this.databaseName } }))
      this.changes.emitInvalidate({ db: this.databaseName })
    }
    return true
  }

  /**
   * Runs `work` inside a transaction, committing when it returns and rolling
   * back if it throws. Returns whatever `work` returns.
   *
   * ```javascript
   * await db.withTransaction(async () => {
   *   await accounts.updateOne({ _id: 'a' }, { $inc: { balance: -100 } })
   *   await accounts.updateOne({ _id: 'b' }, { $inc: { balance: 100 } })
   * })
   * ```
   *
   * **Not modelled on MongoDB's session API**, deliberately. `node:sqlite` is
   * synchronous, so nothing can interleave between two statements here and
   * there is no concurrency for a session object to coordinate; handing the
   * caller a token to thread through every call would imply a model that does
   * not exist. A callback is the honest shape, and it is the one thing SQLite
   * is better at than the database this library imitates.
   *
   * Nesting works, via SAVEPOINT: an inner `withTransaction` rolls back only
   * its own work, and an outer rollback still discards everything. SQLite has
   * no nested BEGIN, so a plain BEGIN here would fail with "cannot start a
   * transaction within a transaction" and make composition impossible.
   *
   * Two things to know:
   *
   * - **`insertMany` stops keeping its prefix.** On its own, an ordered
   *   `insertMany` that fails part-way keeps the documents it wrote, matching
   *   MongoDB. Inside a transaction that then rolls back, those go too - which
   *   is what the caller asked for by opening a transaction.
   * - **Do not iterate a cursor across a rollback.** A live statement holds a
   *   read; materialise with `toArray()` inside the transaction instead.
   */
  async withTransaction <T>(work: () => Promise<T> | T): Promise<T> {
    const frame = this.enterTransaction()
    try {
      const result = await work()
      this.commitFrame(frame)
      return result
    } catch (error) {
      // A no-op if the commit above already ended the frame, which is what
      // makes this safe on both paths through the try.
      this.rollbackFrame(frame)
      throw error
    }
  }

  /**
   * Opens a transaction, or a SAVEPOINT if one is already open.
   *
   * Shared by `withTransaction` and by `ClientSession`, which needs the two
   * halves separately - its `startTransaction`/`commitTransaction` pair has no
   * callback to sit inside.
   */
  private enterTransaction (): TransactionFrame {
    // Depth is tracked here rather than read from DatabaseSync.isTransaction,
    // which is not available on the Node 22.13 floor this package declares.
    const depth = this.transactionDepth
    // The name is generated, never caller-supplied - it is interpolated.
    const frame: TransactionFrame = { savepoint: depth === 0 ? null : `sdb_savepoint_${depth}`, closed: false }
    this.exec(frame.savepoint === null ? 'BEGIN' : `SAVEPOINT ${frame.savepoint}`)
    // Both AFTER the SQL, so a BEGIN that throws leaves nothing behind: the depth
    // is not raised (or the next transaction would wrongly nest with a SAVEPOINT)
    // and no change buffer is opened (the frame is never returned, so nothing
    // would ever close it).
    this.transactionDepth++
    this.changes.enter()
    return frame
  }

  private commitFrame (frame: TransactionFrame): void {
    if (frame.closed) return
    // Deliberately NOT in a `finally`: a COMMIT that fails leaves the frame
    // open, so the caller's rollback path still has something to roll back -
    // which is what the original single-method version did. The change buffer
    // follows the same rule, and is released by that rollback instead.
    this.exec(frame.savepoint === null ? 'COMMIT' : `RELEASE ${frame.savepoint}`)
    this.changes.leave(true)
    this.closeFrame(frame)
  }

  private rollbackFrame (frame: TransactionFrame): void {
    if (frame.closed) return
    try {
      if (frame.savepoint === null) {
        this.exec('ROLLBACK')
      } else {
        // ROLLBACK TO rewinds to the savepoint but LEAVES it on the stack, so
        // it has to be released too or the next RELEASE unwinds the wrong one.
        this.exec(`ROLLBACK TO ${frame.savepoint}`)
        this.exec(`RELEASE ${frame.savepoint}`)
      }
      // DDL is transactional in SQLite, so a collection opened for the FIRST
      // time inside this transaction had its CREATE TABLE rolled back too - and
      // the cache would keep handing out a Collection bound to a table that no
      // longer exists ("no such table" on the next call). Dropping the cache
      // makes the next db.collection() rebuild it; the constructor's
      // CREATE TABLE IF NOT EXISTS is cheap and idempotent, so this costs
      // nothing for collections that were already there.
      this.collections.clear()
    } finally {
      // The events this transaction produced go with it - the server does not
      // publish uncommitted transaction data either.
      this.changes.leave(false)
      this.closeFrame(frame)
    }
  }

  /** Gives up a frame's depth exactly once, however its SQL turned out. */
  private closeFrame (frame: TransactionFrame): void {
    if (frame.closed) return
    frame.closed = true
    this.transactionDepth--
  }

  /** True while a `withTransaction` callback is running. */
  get inTransaction (): boolean {
    return this.transactionDepth > 0
  }

  private exec (sql: string): void {
    if (this.options.debug) console.log(sql)
    this.db.exec(sql)
  }

  async close (): Promise<void> {
    // Before the connection goes: a stream blocked on next() would otherwise
    // wait for an event that can no longer be emitted.
    await this.changes.closeStreams()
    this.db.close()
  }
}
