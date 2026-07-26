/**
 * `ClientSession` - the session object `MongoClient.startSession()` hands out
 * (BACKLOG item 25).
 *
 * It exists for one shape, which is how a great deal of MongoDB transaction
 * code is written:
 *
 * ```javascript
 * const session = client.startSession()
 * await session.withTransaction(async () => {
 *   await accounts.updateOne({ _id: from }, { $inc: { balance: -100 } }, { session })
 *   await accounts.updateOne({ _id: to }, { $inc: { balance: 100 } }, { session })
 * })
 * ```
 *
 * Rewriting that into `db.withTransaction()` is exactly the kind of edit the
 * `MongoClient` shim exists to avoid, so the shape is supported here.
 *
 * **A session is a ROUTING token on MongoDB, and only a CHECKED one here.**
 * `insertOne(doc, { session })` means "put this in the transaction" and leaving
 * the option off means "run it outside, right now". SQLite's `BEGIN` belongs to
 * the CONNECTION, so there is no outside to run in: a second connection would
 * be a different database in memory, and on a file it would block on the
 * transaction's write lock and deadlock a single-threaded process. So the
 * session cannot steer an operation - what it can do is refuse the operations
 * whose answer would differ, and that is what `enlist` below is.
 *
 * Three consequences, in order of how likely they are to matter:
 *
 * - **An operation inside a transaction that is NOT given the session still
 *   takes part in it.** MongoDB would run it outside and not roll it back.
 *   Forgetting `{ session }` inside a transaction is a well-known bug in
 *   MongoDB code, so correct code passes it everywhere and sees no difference;
 *   `strict: true` turns the case into an error rather than a divergence.
 * - **A transaction covers ONE database.** It opens on the first operation that
 *   names the session (which is when a real transaction starts on the server
 *   too), and an operation on a different `db()` inside it is an error rather
 *   than a write that quietly escapes the transaction.
 * - **Options that describe a network client are ignored** (`causalConsistency`,
 *   `readConcern`, `writeConcern`, ...), on the same grounds the client ignores
 *   `maxPoolSize`: one connection to a local file is trivially causally
 *   consistent, and there is no replica set for a read concern to mean anything
 *   against.
 */

import type { SessionHost, SessionLike, TransactionFrame } from './types.js'

/** Answers whether a database belongs to the client that made this session. */
export type OwnsDatabase = (database: object) => boolean

/**
 * The transaction states MongoDB distinguishes, because the errors it raises
 * depend on which one a session is in - aborting twice and aborting after a
 * commit are different messages.
 */
type TransactionState = 'none' | 'active' | 'committed' | 'aborted'

export interface ClientSessionOptions {
  /** Ignored - see the note at the top of this file. */
  [option: string]: unknown
}

export interface TransactionOptions {
  /** Ignored - a read/write concern describes a replica set, which is not here. */
  [option: string]: unknown
}

export class ClientSession implements SessionLike {
  readonly #ownsDatabase: OwnsDatabase
  readonly #onEnd: () => void
  #ended = false
  #state: TransactionState = 'none'
  /**
   * The database this session's transaction was opened on, and the frame that
   * ends it. Both stay null until the first operation names the session - see
   * `enlist`.
   */
  #host: SessionHost | null = null
  #frame: TransactionFrame | null = null

  constructor (ownsDatabase: OwnsDatabase, onEnd: () => void = () => {}) {
    this.#ownsDatabase = ownsDatabase
    this.#onEnd = onEnd
  }

  /** True once `endSession()` has been called; using it after that is an error. */
  get hasEnded (): boolean {
    return this.#ended
  }

  /** True between `startTransaction()` and its commit or abort. */
  inTransaction (): boolean {
    return this.#state === 'active'
  }

  // There is deliberately no `transaction` property, though the driver has one
  // at runtime: it is excluded from the driver's published types, so code
  // written against it here would stop COMPILING on a swap back to `mongodb` -
  // the exact drift this shim exists to prevent. `inTransaction()` is the
  // public spelling of the same question.

  /** Sessions are compared by identity, there being no session id to compare. */
  equals (other: unknown): boolean {
    return this === other
  }

  /**
   * Marks the session as being in a transaction. No SQL runs yet: the
   * transaction opens on the first operation that names this session, which is
   * also when one starts on a real server.
   */
  startTransaction (_options: TransactionOptions = {}): void {
    if (this.#state === 'active') throw Error('Transaction already in progress')
    this.#state = 'active'
    this.#host = null
    this.#frame = null
  }

  /** Commits the transaction. Committing twice is a no-op, as it is on the driver. */
  async commitTransaction (): Promise<void> {
    if (this.#state === 'none') throw Error('No transaction started')
    if (this.#state === 'aborted') throw Error('Cannot call commitTransaction after calling abortTransaction')
    if (this.#state === 'committed') return
    this.#state = 'committed'
    this.#end(true)
  }

  /** Rolls the transaction back. */
  async abortTransaction (): Promise<void> {
    if (this.#state === 'none') throw Error('No transaction started')
    if (this.#state === 'committed') throw Error('Cannot call abortTransaction after calling commitTransaction')
    if (this.#state === 'aborted') throw Error('Cannot call abortTransaction twice')
    this.#state = 'aborted'
    this.#end(false)
  }

  /**
   * Runs `work` in a transaction, committing when it returns and rolling back
   * if it throws, and returns whatever `work` returns.
   *
   * Unlike the driver's, this does not retry: a retry exists for transient
   * network and election errors, and there is no network and no election.
   *
   * Transactions do NOT nest on one session - `withTransaction` inside
   * `withTransaction` on the same session is "Transaction already in progress",
   * exactly as on a server. (`db.withTransaction` DOES nest, via SAVEPOINT;
   * that is a different API making a different promise.)
   */
  async withTransaction <T>(
    work: (session: ClientSession) => Promise<T> | T, options: TransactionOptions = {}
  ): Promise<T> {
    this.startTransaction(options)
    try {
      // The session is passed in as well as captured, as the driver passes it.
      const result = await work(this)
      // The callback is allowed to commit or abort for itself, as it is on the
      // driver; only finish the transaction if it is still running.
      if (this.#state === 'active') await this.commitTransaction()
      return result
    } catch (error) {
      if (this.#state === 'active') await this.abortTransaction()
      throw error
    }
  }

  /** Ends the session, rolling back any transaction still open on it. */
  async endSession (): Promise<void> {
    if (this.#ended) return
    if (this.#state === 'active') await this.abortTransaction()
    this.#ended = true
    this.#onEnd()
  }

  /** Ends the transaction's SQL and releases the database it was open on. */
  #end (commit: boolean): void {
    const host = this.#host
    const frame = this.#frame
    this.#host = null
    this.#frame = null
    if (host === null || frame === null) return // no operation ever named it
    host.activeSession = null
    if (!commit) {
      host.rollback(frame)
      return
    }
    try {
      host.commit(frame)
    } catch (error) {
      // A COMMIT that fails leaves the transaction open; rolling it back is the
      // only way not to strand the connection inside one.
      host.rollback(frame)
      throw error
    }
  }

  /**
   * Checks that `session` may be used on `host`, and opens the session's
   * transaction there if this is the first operation to name it.
   *
   * Every operation calls this exactly once, including with no session at all -
   * which is the case `strict` exists for. It is a static method because the
   * checks read another instance's private state, and because the alternative
   * (public methods for binding a transaction) would put the mechanism on the
   * session's own surface, where a caller could drive it.
   */
  static enlist (session: SessionLike | undefined, host: SessionHost): void {
    if (session == null) {
      // No session, inside a transaction one is running: this operation is
      // about to take part in a transaction MongoDB would have run it outside
      // of. It is the divergence documented at the top of this file, and the
      // only one a caller can hit by writing ordinary, correct-looking code.
      if (host.activeSession !== null && host.strict) {
        throw Error(
          'strict: this operation is inside a session transaction but was not given { session }, so it ' +
          'takes part in that transaction - MongoDB would run it OUTSIDE, and would not roll it back. ' +
          'Pass { session } to every operation inside the transaction'
        )
      }
      return
    }

    if (!(session instanceof ClientSession)) {
      throw Error('session must be a ClientSession, as returned by client.startSession()')
    }
    if (session.#ended) throw Error('Use of expired sessions is not permitted')
    if (!session.#ownsDatabase(host.database)) throw Error('ClientSession must be from the same MongoClient')

    if (host.activeSession !== null && host.activeSession !== session) {
      // A DIFFERENT session's transaction owns this connection. MongoDB would
      // run this operation outside that transaction; here it cannot, so the
      // honest answer is to refuse rather than to enrol it silently.
      throw Error(
        'another session has a transaction open on this database, and an operation outside it cannot run ' +
        'until that transaction ends - a SQLite transaction belongs to the connection, not to the session'
      )
    }

    if (session.#state !== 'active') return

    if (session.#host === null) {
      // First operation of the transaction: this is the database it covers.
      session.#host = host
      session.#frame = host.begin()
      host.activeSession = session
      return
    }

    if (session.#host !== host) {
      throw Error(
        'a transaction here covers ONE database, because it is one SQLite connection - this session already ' +
        'has one open on another database'
      )
    }
  }
}
