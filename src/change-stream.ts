/**
 * Change streams (BACKLOG item 27) - `watch()` on `Collection`, `Db` and
 * `MongoClient`.
 *
 * **Events come from the WRITE PATH, not from the engine.** BACKLOG item 26
 * asked whether SQLite could be made to report what changed, measured its way
 * to no (there is no update hook through `node:sqlite`, and the session
 * extension records nothing for a `(data JSON)` table with no primary key) and
 * decided against the feature. That was the wrong question: every write here
 * already goes through a `Collection` method that knows exactly what it did, so
 * emitting an event is bookkeeping rather than archaeology.
 *
 * Four things carry the design:
 *
 * - **An unwatched database pays nothing.** Every write path asks
 *   `hub.watching` first, and takes exactly the statements it took before when
 *   the answer is no. The post-images the multi-document writes need come from
 *   `UPDATE`/`DELETE ... RETURNING`, so a watched `updateMany` is still ONE
 *   statement - which matters under driver-seam rule 3, where every statement is
 *   a possible round trip.
 * - **Events are buffered per transaction and flushed on COMMIT.** A rollback
 *   discards them. That is the server's behaviour too - it does not publish
 *   uncommitted transaction data - and it is why `enter`/`leave` below pair with
 *   `Db`'s transaction frames.
 * - **The pipeline runs at READ time, not at emit time.** A change-stream stage
 *   is per-event, and `$match` goes back through SQLite (`Collection.matchBatch`)
 *   like every other filter in this library rather than through a second,
 *   JavaScript matcher. Running it when the event is read keeps the write path
 *   synchronous and keeps the cost on the stream that asked for it.
 * - **Every limit is an `invalidate`, never a silence.** Only writes made
 *   through this library on this connection can be described. `PRAGMA
 *   data_version` detects another connection's commits (measured: unchanged for
 *   this connection's own writes, incremented for anyone else's) and `db.sql`
 *   reports its own row counts, so both blind spots END the stream with an
 *   event MongoDB already has and callers already handle.
 *
 * What is deliberately NOT here: `resumeAfter`/`startAfter` (there is no oplog
 * to replay from - see `assertNoResume`), `clusterTime` (a BSON Timestamp,
 * which the storage layer cannot hold and which would be a fiction anyway), and
 * the driver's `EventEmitter` surface. The async-iterable half is what the
 * driver documents for new code and it is the half that can be supported
 * exactly.
 */

import { compileStages } from './aggregate.js'
import type { BatchMatcher } from './aggregate.js'
import { equalsBson } from './bson-order.js'
import type { UpdatedPath } from './update.js'
import type {
  ChangeStreamDocument, ChangeStreamNamespace, ChangeStreamOptions, Document, InvalidateReason,
  ResumeToken, UpdateDescription
} from './types.js'

/** One compiled pipeline stage - `compileStages`' element type, which it does not name. */
type Stage = ReturnType<typeof compileStages>[number]

/**
 * Events are numbered for the lifetime of the PROCESS.
 *
 * MongoDB's `_id` encodes a cluster time and a document key, so it points into
 * an oplog; this one points at nothing, and `assertNoResume` is the other half
 * of saying so.
 */
let eventSequence = 0

function nextToken (): ResumeToken {
  return { _data: String(++eventSequence) }
}

/** How often a waiting reader checks whether another connection has written. */
const DEFAULT_POLL_INTERVAL_MS = 100

/**
 * The stages MongoDB allows in a `watch()` pipeline, intersected with the ones
 * this library implements.
 *
 * `$replaceRoot`, `$replaceWith` and `$redact` are on the server's list and are
 * not implemented here (BACKLOG item 16), so they are refused with that reason
 * rather than with MongoDB's. Everything else is refused with MongoDB's - a
 * blocking stage like `$group` cannot work over a stream that never ends, which
 * is why the server does not allow it either.
 */
const CHANGE_STREAM_STAGES = new Set(['$addFields', '$match', '$project', '$set', '$unset'])
const UNIMPLEMENTED_STAGES = new Set(['$replaceRoot', '$replaceWith', '$redact', '$showExpandedEvents'])

function assertChangeStreamPipeline (pipeline: Document[]): void {
  if (!Array.isArray(pipeline)) throw Error('watch expects an array of pipeline stages')
  for (const stage of pipeline) {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw Error('each watch pipeline stage must be a document')
    }
    const name = Object.keys(stage)[0]
    if (name === undefined) throw Error('a watch pipeline stage must have exactly one key')
    if (CHANGE_STREAM_STAGES.has(name)) continue
    throw Error(UNIMPLEMENTED_STAGES.has(name)
      ? `${name} is allowed in a change stream pipeline but is not implemented here`
      : `${name} is not permitted in a $changeStream pipeline ` +
        `(allowed: ${[...CHANGE_STREAM_STAGES].join(', ')})`)
  }
}

/**
 * `resumeAfter` and friends, refused with the reason.
 *
 * A resume token here names an event, and the events are held only in the
 * streams that were open at the time - there is no oplog behind them. Accepting
 * the option would mean starting from NOW and calling it a resume, which is the
 * silent gap this whole feature is shaped to avoid.
 */
function assertNoResume (options: Record<string, unknown>): void {
  for (const option of ['resumeAfter', 'startAfter', 'startAtOperationTime']) {
    if (options[option] == null) continue
    throw Error(
      `watch does not support '${option}': a resume token points into an oplog, and an embedded database ` +
      'has none - the events exist only while a stream is open. Open the stream BEFORE the writes it ' +
      'must not miss'
    )
  }
}

const KNOWN_OPTIONS = new Set([
  'fullDocument', 'fullDocumentBeforeChange', 'resumeAfter', 'startAfter', 'startAtOperationTime',
  'batchSize', 'maxAwaitTimeMS', 'pollIntervalMS', 'session', 'comment'
])

function assertWatchOptions (options: ChangeStreamOptions): void {
  const given = options as Record<string, unknown>
  const unknown = Object.keys(given).find(option => !KNOWN_OPTIONS.has(option))
  if (unknown !== undefined) throw Error(`watch does not support the '${unknown}' option`)
  assertNoResume(given)
}

/** What the hub needs from the database it belongs to. */
export interface ChangeHubHost {
  /** What `db.databaseName` reports, and what an event's `ns.db` carries. */
  readonly databaseName: string
  /**
   * `PRAGMA data_version`, or null for a database that cannot be shared.
   *
   * SQLite bumps it when ANOTHER connection commits and leaves it alone for
   * this one's own writes (measured), which makes it exactly the "there were
   * changes you cannot see" signal a stream needs.
   */
  dataVersion: () => number | null
  /**
   * Applies a filter to documents that are not rows - `Collection.matchBatch`.
   * Supplied rather than implemented so a `$match` in a watch pipeline is the
   * SAME matcher as everywhere else in the library.
   */
  match: BatchMatcher
}

/**
 * An event on its way out, and which streams it ENDS.
 *
 * An invalidate travels the same path as an ordinary event so that it obeys
 * the same transaction rules: a `drop` inside a transaction that rolls back
 * must not end a stream, and it would if the invalidate went straight to the
 * streams while the `drop` event sat in a buffer.
 */
interface PendingEvent {
  event: ChangeStreamDocument<any>
  /** Absent for an ordinary event; a namespace or 'all' for an invalidate. */
  invalidates?: ChangeStreamNamespace | 'all'
}

/**
 * The per-connection event bus: one per `Db`, handed to every `Collection` it
 * opens the way `SessionHost` is.
 */
export class ChangeHub {
  readonly #host: ChangeHubHost
  readonly #streams = new Set<ChangeStream<any>>()
  /** One buffer per open transaction frame; the innermost is last. */
  readonly #frames: PendingEvent[][] = []
  #dataVersion: number | null = null
  #polling = false
  #pollIntervalMs = DEFAULT_POLL_INTERVAL_MS

  constructor (host: ChangeHubHost) {
    this.#host = host
  }

  get host (): ChangeHubHost {
    return this.#host
  }

  /**
   * True while anything is watching.
   *
   * Every write path asks this before doing any change-stream work at all, so
   * an unwatched collection runs exactly the statements it always did.
   */
  get watching (): boolean {
    return this.#streams.size > 0
  }

  /** Publishes an event, or buffers it when a transaction is open. */
  emit (event: ChangeStreamDocument<any>): void {
    this.#send({ event })
  }

  /**
   * Ends the streams a namespace going away makes meaningless, as the server
   * does: a COLLECTION stream is invalidated by its collection being dropped or
   * renamed, a DATABASE stream by `dropDatabase` (which names no collection),
   * and a client-wide stream by neither.
   */
  emitInvalidate (ns: ChangeStreamNamespace): void {
    this.#send({ event: invalidateEvent(), invalidates: ns })
  }

  #send (pending: PendingEvent): void {
    if (!this.watching) return
    const frame = this.#frames.at(-1)
    if (frame !== undefined) {
      frame.push(pending)
      return
    }
    this.#publish(pending)
  }

  /**
   * Opens a buffer, paired with a transaction frame (`Db.enterTransaction`, and
   * `insertMany`'s own batch transaction).
   *
   * Pushed even when nobody is watching, so that a stream opened DURING a
   * transaction still finds the stack balanced when it commits.
   */
  enter (): void {
    this.#frames.push([])
  }

  /** Closes the innermost buffer, publishing its events or discarding them. */
  leave (publish: boolean): void {
    const frame = this.#frames.pop()
    if (frame === undefined || !publish) return
    const parent = this.#frames.at(-1)
    // One at a time, not a spread: a transaction can hold arbitrarily many
    // events and `push(...frame)` is an argument list.
    if (parent !== undefined) {
      for (const pending of frame) parent.push(pending)
      return
    }
    for (const pending of frame) this.#publish(pending)
  }

  #publish (pending: PendingEvent): void {
    const { event, invalidates } = pending
    // Over a copy: an invalidate detaches the stream that receives it, which
    // would otherwise be a mutation of the set being iterated.
    for (const stream of Array.from(this.#streams)) {
      if (invalidates === undefined) {
        stream.receive(event, this)
        continue
      }
      if (invalidates === 'all' || stream.invalidatedBy(invalidates)) stream.finish(event, this)
    }
  }

  attach (stream: ChangeStream<any>, pollIntervalMs?: number): void {
    if (pollIntervalMs !== undefined) this.#pollIntervalMs = pollIntervalMs
    // The baseline for "somebody else wrote": anything before the first stream
    // opened is not a change this stream could have reported.
    this.#dataVersion ??= this.#host.dataVersion()
    this.#streams.add(stream)
  }

  detach (stream: ChangeStream<any>): void {
    this.#streams.delete(stream)
  }

  /**
   * Closes every stream on this connection - what `Db.close()` needs.
   *
   * Not an invalidate: nothing was missed, the database is simply gone. A
   * reader blocked on `next()` would otherwise wait for an event that can no
   * longer arrive.
   */
  async closeStreams (): Promise<void> {
    for (const stream of Array.from(this.#streams)) await stream.close()
  }

  /**
   * Checks whether another connection has committed since the last look, and
   * ends every stream here if it has.
   *
   * The answer cannot say WHAT changed - `data_version` is one counter for the
   * whole database - so the stream reports that it can no longer describe the
   * collection rather than guessing.
   */
  checkForeignWrites (): void {
    if (!this.watching) return
    const version = this.#host.dataVersion()
    if (version === null || this.#dataVersion === null) return
    if (version === this.#dataVersion) return
    this.#dataVersion = version
    // Straight out, not through the transaction buffer: another connection has
    // already COMMITTED, and rolling this one back does not undo that.
    this.#publish({ event: invalidateEvent('foreignWrite'), invalidates: 'all' })
  }

  /**
   * Reports a write this library cannot describe - `db.sql` (see src/raw-sql.ts).
   *
   * Buffered like an ordinary event, because a raw statement runs on THIS
   * connection: a transaction that rolls back takes the raw write with it, and
   * there is then nothing a stream missed.
   */
  reportOpaqueWrite (): void {
    this.#send({ event: invalidateEvent('rawSqlWrite'), invalidates: 'all' })
  }

  /**
   * Starts (or keeps) the poll that watches for another connection's writes.
   *
   * Only runs while a reader is actually waiting - a stream nobody is reading
   * costs no timer - and the handle is unref'd so a change stream never holds
   * the process open on its own.
   */
  poll (): void {
    if (this.#polling || !this.watching) return
    this.#polling = true
    const timer = setTimeout(() => {
      this.#polling = false
      this.checkForeignWrites()
      if (Array.from(this.#streams).some(stream => stream.waiting)) this.poll()
    }, this.#pollIntervalMs)
    unrefTimer(timer)
  }
}

/**
 * Keeps a poll timer from holding the process open.
 *
 * Node hands back a `Timeout` with `unref()`; Deno hands back a number and
 * spells it `Deno.unrefTimer`. Both are asked for and neither is required.
 */
function unrefTimer (timer: unknown): void {
  const handle = timer as { unref?: () => void }
  if (typeof handle?.unref === 'function') {
    handle.unref()
    return
  }
  const deno = (globalThis as { Deno?: { unrefTimer?: (id: number) => void } }).Deno
  if (typeof deno?.unrefTimer === 'function' && typeof timer === 'number') deno.unrefTimer(timer)
}

function invalidateEvent (reason?: InvalidateReason): ChangeStreamDocument<any> {
  return {
    _id: nextToken(),
    operationType: 'invalidate',
    wallTime: new Date(),
    ...(reason === undefined ? {} : { invalidateReason: reason })
  }
}

/**
 * A change event, minted by the write path.
 *
 * `clusterTime` is deliberately absent: it is a BSON Timestamp, which
 * src/ejson.ts cannot store and which would describe a replication clock that
 * does not exist. `wallTime` is a real Date and is here.
 */
export function changeEvent (
  operationType: ChangeStreamDocument['operationType'], fields: Partial<ChangeStreamDocument> = {}
): ChangeStreamDocument<any> {
  return { _id: nextToken(), operationType, wallTime: new Date(), ...fields }
}

/**
 * An `update` event's `updateDescription`, from the paths the update wrote and
 * the two documents.
 *
 * The paths come from the update spec (`updatedPaths` in src/update.ts, which
 * says why); each is then looked up in the NEW document. Present means the
 * update set it, absent means it removed it - so `$unset`, a `$rename`'s source
 * and every other removal need no special case here.
 *
 * The one place the BEFORE document is consulted is an array append: MongoDB
 * reports `$push` and `$addToSet` one appended index at a time (`'tags.1'`) and
 * everything else that rebuilds an array as the whole array, so the two
 * versions have to be compared to tell an append from a rebuild.
 *
 * `truncatedArrays` is always empty, and that is measured rather than assumed:
 * the server produced none for any operator this library implements, including
 * `$pop` and `$pull` over a 40-element array, both of which come back as a
 * whole `updatedFields` entry.
 */
export function updateDescriptionFor (
  paths: UpdatedPath[], after: Document, before: Document
): UpdateDescription {
  const updatedFields: Document = {}
  const removedFields: string[] = []
  for (const { path, appends } of paths) {
    const value = valueAtPath(after, path)
    if (value === undefined) {
      removedFields.push(path)
      continue
    }
    const appended = appends ? appendedIndices(valueAtPath(before, path), value) : null
    if (appended === null) {
      updatedFields[path] = value
      continue
    }
    for (const index of appended) updatedFields[`${path}.${index}`] = (value as unknown[])[index]
  }
  return { updatedFields, removedFields, truncatedArrays: [] }
}

/**
 * An `update` event's `updateDescription` for a PIPELINE update, DIFFED from
 * the two images (BACKLOG item 28).
 *
 * An operator update's description comes from its SPEC (`updateDescriptionFor`
 * above), because that is what the server reports for one - `$set: { a: {...} }`
 * names `a` whole, however little of it changed. A pipeline update has no spec
 * of that shape: it rewrites the document, and the server derives its
 * description by diffing the images - granularly, so the same `$set` written as
 * a pipeline stage names only the sub-paths that actually differ. This is that
 * diff. The rules, each pinned dual-engine in test/change-streams.spec.ts:
 *
 * - A field present only in the new document is updated; only in the old one,
 *   removed; different scalars are updated whole.
 * - Two DOCUMENTS recurse, naming dotted sub-paths.
 * - Two ARRAYS compare per index: a changed element is `'arr.3'` (recursing
 *   when both sides are documents), an appended one likewise, and a SHORTER
 *   array is a `truncatedArrays` entry `{ field, newSize }` - the one place
 *   that field is ever non-empty here.
 */
export function diffUpdateDescription (before: Document, after: Document): UpdateDescription {
  const description: UpdateDescription = { updatedFields: {}, removedFields: [], truncatedArrays: [] }
  diffDocuments('', before, after, description)
  return description
}

function diffDocuments (prefix: string, before: Document, after: Document, out: UpdateDescription): void {
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) out.removedFields.push(`${prefix}${key}`)
  }
  for (const key of Object.keys(after)) {
    const path = `${prefix}${key}`
    if (!Object.hasOwn(before, key)) {
      out.updatedFields[path] = after[key]
      continue
    }
    const left = before[key]
    const right = after[key]
    if (equalsBson(left, right)) continue
    if (isPlainDocument(left) && isPlainDocument(right)) diffDocuments(`${path}.`, left, right, out)
    else if (Array.isArray(left) && Array.isArray(right)) diffArrays(path, left, right, out)
    else out.updatedFields[path] = right
  }
}

function diffArrays (path: string, before: unknown[], after: unknown[], out: UpdateDescription): void {
  if (after.length < before.length) out.truncatedArrays.push({ field: path, newSize: after.length })
  for (let index = 0; index < after.length; index++) {
    const left = before[index]
    const right = after[index]
    if (index < before.length && equalsBson(left, right)) continue
    if (index < before.length && isPlainDocument(left) && isPlainDocument(right)) {
      diffDocuments(`${path}.${index}.`, left, right, out)
    } else {
      out.updatedFields[`${path}.${index}`] = right
    }
  }
}

/** A document to recurse into - not an array, not a Date, not null. */
function isPlainDocument (value: unknown): value is Document {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

/**
 * The indexes an array gained, when the new one is the old one plus a tail -
 * and null when it is anything else.
 *
 * That is exactly the case MongoDB reports per index. `$push` with `$position`,
 * `$sort` or `$slice` rewrites the array rather than extending it, so the
 * element-by-element check falls through to null and the whole array is
 * reported, which is what the server does for those too.
 */
function appendedIndices (before: unknown, after: unknown): number[] | null {
  if (!Array.isArray(before) || !Array.isArray(after)) return null
  if (after.length <= before.length) return null
  for (let index = 0; index < before.length; index++) {
    if (!equalsBson(before[index], after[index])) return null
  }
  return Array.from({ length: after.length - before.length }, (_, offset) => before.length + offset)
}

/**
 * One dotted path, read out of a document.
 *
 * Deliberately NOT MongoDB's array-crossing path resolution (the rule that
 * makes `{ 'instock.qty': 5 }` match an element of `instock`): this reads the
 * value an update WROTE, and an update writes to exactly one place.
 */
function valueAtPath (document: Document, path: string): unknown {
  let current: unknown = document
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
      continue
    }
    if (!Object.hasOwn(current, segment)) return undefined
    current = (current as Document)[segment]
  }
  return current
}

/** Which events a stream is interested in. Empty watches everything. */
export interface ChangeStreamScope {
  /** The database an event must name; undefined watches every database. */
  db?: string
  /** The collection an event must name; undefined watches the whole database. */
  coll?: string
}

/** One queued event, with the hub that produced it - a `$match` runs on that connection. */
interface QueuedEvent {
  event: ChangeStreamDocument<any>
  hub: ChangeHub
}

/**
 * The stream `watch()` returns: an async iterable of change events.
 *
 * ```javascript
 * const stream = orders.watch([{ $match: { operationType: 'insert' } }])
 * for await (const event of stream) console.log(event.fullDocument)
 * ```
 *
 * A stream buffers every event it accepts until it is read, so a stream nobody
 * reads and nobody closes grows. `close()` is what releases it, and
 * `for await` closes it on the way out.
 */
export class ChangeStream<TSchema extends Document = Document>
implements AsyncIterable<ChangeStreamDocument<TSchema>> {
  readonly #scope: ChangeStreamScope
  readonly #options: ChangeStreamOptions
  readonly #pipeline: Document[]
  readonly #hubs = new Set<ChangeHub>()
  /** Compiled per hub, because `$match` runs on the connection that emitted. */
  readonly #stages = new Map<ChangeHub, Stage[]>()
  /** Accepted but unread. Raw: the pipeline runs when the event is read. */
  readonly #queue: QueuedEvent[] = []
  #waiters: Array<() => void> = []
  #peeked: ChangeStreamDocument<TSchema> | null = null
  #closed = false
  /** An invalidate has been queued: the stream ends once the queue drains. */
  #ending = false
  #waiting = false
  #resumeToken: ResumeToken | undefined

  constructor (scope: ChangeStreamScope, pipeline: Document[] = [], options: ChangeStreamOptions = {}) {
    assertChangeStreamPipeline(pipeline)
    assertWatchOptions(options)
    this.#scope = scope
    this.#pipeline = pipeline
    this.#options = options
  }

  /** True while a reader is blocked - what tells the hub to keep polling. */
  get waiting (): boolean {
    return this.#waiting
  }

  get closed (): boolean {
    return this.#closed
  }

  /**
   * The `_id` of the last event read.
   *
   * It is reported because the driver reports it and because it identifies an
   * event; it cannot be resumed FROM (see `assertNoResume`).
   */
  get resumeToken (): ResumeToken | undefined {
    return this.#resumeToken
  }

  /** Subscribes to a database's events. Called by `watch()`, and by `MongoClient.db()`. */
  listenTo (hub: ChangeHub): void {
    if (this.#closed || this.#ending) return
    this.#hubs.add(hub)
    hub.attach(this, this.#options.pollIntervalMS)
  }

  /** Queues an event this stream is scoped to. Called by the hub. */
  receive (event: ChangeStreamDocument<any>, hub: ChangeHub): void {
    if (this.#closed || this.#ending || !this.#accepts(event)) return
    this.#queue.push({ event, hub })
    this.#wake()
  }

  /** True when this stream is the kind a dropped namespace should end. */
  invalidatedBy (ns: ChangeStreamNamespace): boolean {
    if (this.#scope.coll !== undefined) {
      return ns.db === this.#scope.db && (ns.coll === undefined || ns.coll === this.#scope.coll)
    }
    // A database stream ends on dropDatabase (which names no collection) and
    // survives one collection being dropped, as the server's does.
    if (this.#scope.db !== undefined) return ns.coll === undefined && ns.db === this.#scope.db
    return false
  }

  /**
   * Ends the stream with a final event, which stays readable.
   *
   * Detaching here rather than at close is what lets `hub.watching` go false
   * again the moment an invalidate is issued: the stream is over, so the write
   * path should stop paying for it immediately.
   */
  finish (event: ChangeStreamDocument<any>, hub: ChangeHub): void {
    if (this.#closed || this.#ending) return
    this.#ending = true
    this.#queue.push({ event, hub })
    for (const attached of this.#hubs) attached.detach(this)
    this.#hubs.clear()
    this.#wake()
  }

  async next (): Promise<ChangeStreamDocument<TSchema>> {
    const event = await this.#take()
    if (event === null) throw Error('ChangeStream is closed')
    return event
  }

  /**
   * The next event if one is already waiting, else null.
   *
   * Unlike `next()` this does not block - and because it is the shape a polling
   * caller uses, it takes the opportunity to check whether another connection
   * has written, so such a caller learns about that boundary without the timer
   * a blocked reader relies on.
   */
  async tryNext (): Promise<ChangeStreamDocument<TSchema> | null> {
    if (this.#peeked === null && this.#queue.length === 0) {
      for (const hub of this.#hubs) hub.checkForeignWrites()
    }
    return await this.#take(false)
  }

  /** True when another event is waiting. Peeks; it never consumes one. */
  async hasNext (): Promise<boolean> {
    this.#peeked ??= await this.#take()
    return this.#peeked !== null
  }

  async close (): Promise<void> {
    this.#closed = true
    this.#peeked = null
    this.#queue.length = 0
    for (const hub of this.#hubs) hub.detach(this)
    this.#hubs.clear()
    this.#wake()
  }

  async * [Symbol.asyncIterator] (): AsyncIterableIterator<ChangeStreamDocument<TSchema>> {
    try {
      for (;;) {
        const event = await this.#take()
        if (event === null) return
        yield event
      }
    } finally {
      await this.close()
    }
  }

  /**
   * The next event, waiting for one when `block` is true.
   *
   * The loop is what makes a pipeline that filters an event out invisible
   * rather than a null: the stream keeps reading until something survives it.
   */
  async #take (block = true): Promise<ChangeStreamDocument<TSchema> | null> {
    if (this.#peeked !== null) {
      const held = this.#peeked
      this.#peeked = null
      return held
    }
    for (;;) {
      const queued = this.#queue.shift()
      if (queued !== undefined) {
        this.#resumeToken = queued.event._id
        const shaped = await this.#shape(queued)
        if (shaped !== null) return shaped
        continue
      }
      // Nothing left, and an invalidate has already been read: the stream is
      // over, exactly as it is on the server after an invalidate.
      if (this.#ending) {
        await this.close()
        return null
      }
      if (this.#closed || !block) return null
      await this.#wait()
    }
  }

  /** Applies this stream's options and pipeline to one event. */
  async #shape (queued: QueuedEvent): Promise<ChangeStreamDocument<TSchema> | null> {
    const event = this.#trim(queued.event)
    if (this.#pipeline.length === 0) return event
    let stages = this.#stages.get(queued.hub)
    if (stages === undefined) {
      stages = compileStages(
        this.#pipeline, queued.hub.host.match,
        // A change-stream pipeline cannot contain $lookup (MongoDB does not
        // allow it either), so there is no foreign collection to read.
        async () => { throw Error('$lookup is not permitted in a $changeStream pipeline') }
      )
      this.#stages.set(queued.hub, stages)
    }
    return await runStages(stages, event) as ChangeStreamDocument<TSchema> | null
  }

  /**
   * Drops the images this stream did not ask for.
   *
   * A copy per stream, because one event is delivered to every stream watching
   * and they can have asked for different things. MongoDB's own rules decide
   * which are on by default: an `insert` and a `replace` always carry the new
   * document, an `update` carries one only for `fullDocument: 'updateLookup'`
   * and friends, and a pre-image is never on by default.
   */
  #trim (event: ChangeStreamDocument<any>): ChangeStreamDocument<TSchema> {
    const wantsFull = event.operationType === 'insert' || event.operationType === 'replace' ||
      (this.#options.fullDocument !== undefined && this.#options.fullDocument !== 'default')
    const wantsBefore = this.#options.fullDocumentBeforeChange !== undefined &&
      this.#options.fullDocumentBeforeChange !== 'off'

    const trimmed = { ...event }
    if (!wantsFull) delete trimmed.fullDocument
    if (!wantsBefore) delete trimmed.fullDocumentBeforeChange
    return trimmed as ChangeStreamDocument<TSchema>
  }

  #accepts (event: ChangeStreamDocument<any>): boolean {
    if (this.#scope.db !== undefined && event.ns?.db !== this.#scope.db) return false
    if (this.#scope.coll !== undefined && event.ns?.coll !== this.#scope.coll) return false
    return true
  }

  async #wait (): Promise<void> {
    this.#waiting = true
    // Only a waiting reader starts the poll for another connection's writes.
    for (const hub of this.#hubs) hub.poll()
    try {
      await new Promise<void>(resolve => this.#waiters.push(resolve))
    } finally {
      this.#waiting = false
    }
  }

  #wake (): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters) resolve()
  }
}

/**
 * Runs one event through a compiled pipeline.
 *
 * A change-stream stage is per-event by construction (the blocking ones are not
 * on MongoDB's allow-list, because they could never complete over a stream that
 * does not end), so a one-document batch is the whole input and the first
 * document out is the answer.
 */
async function runStages (stages: Stage[], event: Document): Promise<Document | null> {
  let stream: AsyncIterable<Document> = (async function * () { yield event })()
  for (const stage of stages) stream = stage(stream)
  for await (const document of stream) return document
  return null
}
