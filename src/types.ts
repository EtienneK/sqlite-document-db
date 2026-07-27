/**
 * The public type surface, in one place.
 *
 * These live here rather than in index.ts because three modules need them and
 * index.ts imports those modules: `aggregate.ts`, `update.ts` and
 * `filter-types.ts` all used to import types back OUT of the entry point,
 * which made the entry point double as the shared-types module and put a cycle
 * in the graph. It was type-only, so it was erased at runtime and never broke
 * anything - but it is the reason the layout was hard to follow.
 *
 * Nothing here has runtime behaviour, and nothing here imports a module that
 * does (beyond `ProjectionSpec`, which is itself only a type).
 */

import type { ProjectionSpec } from './projection.js'

export declare interface Document {
  [key: string]: any
}

export declare type WithoutId<TSchema extends Document = Document> = Omit<TSchema, '_id'>

export declare type WithId<TSchema extends Document = Document> = WithoutId<TSchema> & {
  _id: string
}
/**
 * The loose filter/update shape the COMPILER works with.
 *
 * `Filter<TSchema>` is the public, checked type; everything below the API
 * surface dispatches on the runtime shape of a filter object and has no schema
 * to check against, so it takes this instead. Public methods narrow.
 */
export type AnyFilter = Record<string, any>
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

/**
 * What an operation needs to know about the session it was handed.
 *
 * The class that implements it is `ClientSession` in src/client-session.ts,
 * which this file cannot name: types.ts is the shared type surface and takes no
 * dependencies (see the header). Nothing outside client-session.ts acts on a
 * session anyway - `ClientSession.enlist` is the one place that does, and it
 * narrows to the class first.
 */
export interface SessionLike {
  /** True once `endSession()` has been called. Using it after that is an error. */
  readonly hasEnded: boolean
  /** True between `startTransaction()` and its commit or abort. */
  inTransaction: () => boolean
}

/**
 * The `{ session }` every operation accepts, as the MongoDB driver does.
 *
 * A session here is a token that says which transaction an operation belongs
 * to, and it is CHECKED rather than routed: SQLite's transaction is a property
 * of the connection, so an operation cannot be steered into or out of one. See
 * the note on `ClientSession` for what that means, and for the one case
 * `strict` turns into an error.
 */
export interface SessionOption {
  session?: SessionLike
}

/** A transaction frame opened on a database: BEGIN, or a named SAVEPOINT. */
export interface TransactionFrame {
  readonly savepoint: string | null
  /** Set once the frame's SQL has been ended, so it is never ended twice. */
  closed: boolean
}

/**
 * What a `ClientSession` needs from the database an operation is running on.
 *
 * `Db` builds exactly one of these and hands it to every `Collection` it opens
 * - the same way it hands over `onDrop`. It exists so that a session can open
 * and end a transaction without `Collection` holding a `Db` (it does not) and
 * without `Db`'s transaction primitives becoming public API (`withTransaction`
 * is deliberately the only shape on offer).
 */
export interface SessionHost {
  /**
   * The `Db` itself, as an identity token. A session may only be used on a
   * database its own client opened, which is the check this answers.
   */
  readonly database: object
  /** Whether this database was opened with `strict: true`. */
  readonly strict: boolean
  /** The session whose transaction is open on this database, if any. */
  activeSession: SessionLike | null
  begin: () => TransactionFrame
  commit: (frame: TransactionFrame) => void
  rollback: (frame: TransactionFrame) => void
}

// ---------------------------------------------------------------------------
// Change streams (BACKLOG item 27). The runtime is src/change-stream.ts; these
// are here for the same reason the session types are - `Collection`, `Db` and
// `MongoClient` all name them, and types.ts is the module that may be imported
// from anywhere.
// ---------------------------------------------------------------------------

/**
 * A change event's `_id`, and the thing `resumeAfter` takes.
 *
 * MongoDB's is an opaque hex string encoding a cluster time and a document key;
 * this library's is a counter for the lifetime of the PROCESS, because there is
 * no oplog to point into. That difference is why a token from an earlier run
 * cannot be resumed from and is refused rather than quietly ignored - see
 * `ChangeStreamOptions.resumeAfter`.
 */
export interface ResumeToken {
  _data: string
}

/** The collection an event happened in. `coll` is absent on `dropDatabase`. */
export interface ChangeStreamNamespace {
  db: string
  coll?: string
}

/** What an `update` event says changed. See the note in src/change-stream.ts. */
export interface UpdateDescription {
  /** The paths the update wrote, with their values in the new document. */
  updatedFields: Document
  /** The paths the update removed - `$unset`, and a `$rename`'s source. */
  removedFields: string[]
  /**
   * Arrays shortened in place, as `{ field, newSize }`. Empty for every
   * OPERATOR update - each array those rebuild comes back whole in
   * `updatedFields` (measured) - and populated only by a PIPELINE update,
   * whose description is diffed from the two images as the server's is.
   */
  truncatedArrays: Document[]
}

export type ChangeStreamOperationType =
  | 'insert' | 'update' | 'replace' | 'delete'
  | 'drop' | 'rename' | 'dropDatabase' | 'invalidate'

/**
 * Why a stream ended for a reason MongoDB does not have.
 *
 * Absent on the `invalidate` events a real server also emits (after a `drop`,
 * `rename` or `dropDatabase`); present on the two boundaries that are this
 * library's alone, where the honest report is "there were changes, and they
 * cannot be described".
 */
export type InvalidateReason = 'foreignWrite' | 'rawSqlWrite'

export interface ChangeStreamDocument<TSchema extends Document = Document> {
  _id: ResumeToken
  operationType: ChangeStreamOperationType
  /** When the event was emitted. */
  wallTime: Date
  ns?: ChangeStreamNamespace
  /** Where a `rename` sent the collection. */
  to?: ChangeStreamNamespace
  documentKey?: { _id: any }
  fullDocument?: WithId<TSchema>
  fullDocumentBeforeChange?: WithId<TSchema>
  updateDescription?: UpdateDescription
  /** Set only on the invalidates this library emits of its own accord. */
  invalidateReason?: InvalidateReason
}

export interface ChangeStreamOptions extends SessionOption {
  /**
   * Whether an `update` event carries the document as well as the diff.
   *
   * `'default'` (the default) omits it, exactly as MongoDB does; any of
   * `'updateLookup'`, `'whenAvailable'` and `'required'` includes it. The
   * document is the POST-IMAGE - the row as this update left it - where
   * MongoDB's `updateLookup` re-reads the document when the event is delivered
   * and so can return a later version. Ours is the more useful answer and it is
   * certainly a different one.
   */
  fullDocument?: 'default' | 'updateLookup' | 'whenAvailable' | 'required'
  /**
   * Whether an `update`, `replace` or `delete` event carries the document as it
   * was BEFORE the change.
   *
   * MongoDB requires the collection to have been created with
   * `changeStreamPreAndPostImages` and errors otherwise; here the pre-image is
   * already in hand (the single-document writes read the row first, and
   * `deleteMany` gets it back from `RETURNING`), so it is simply provided.
   */
  fullDocumentBeforeChange?: 'off' | 'whenAvailable' | 'required'
  /**
   * Resume after a token this PROCESS issued, and only when nothing has
   * happened since - there is no oplog to replay from, so any other token is
   * refused rather than silently skipped over.
   */
  resumeAfter?: ResumeToken
  /** As `resumeAfter`; MongoDB distinguishes them only across an invalidate. */
  startAfter?: ResumeToken
  /** Ignored - it describes a network batch, and there is no network. */
  batchSize?: number
  /** Ignored - `next()` waits for an event however long that takes. */
  maxAwaitTimeMS?: number
  /**
   * How often (ms) to check whether ANOTHER connection has written, which is
   * what turns "events you cannot see" into an `invalidate`. This library's own
   * option; MongoDB has nothing to poll for. Only checked while a reader is
   * waiting, and only meaningful for a file-backed database.
   */
  pollIntervalMS?: number
}

export type IndexDirection = 1 | -1

export type IndexSpecification = string | Record<string, IndexDirection>

export interface CreateIndexOptions extends SessionOption {
  unique?: boolean
  name?: string
  /**
   * Index only the documents that HAVE the field (any of them, for a compound
   * key), which is a SQLite partial index over `... IS NOT NULL`.
   *
   * It also changes what `unique` means, exactly as it does on MongoDB: a
   * non-sparse unique index treats every document missing the field as holding
   * the same (null) key and so permits only one of them, while a sparse one
   * ignores them entirely.
   */
  sparse?: boolean
  /**
   * Index only the documents matching this filter.
   *
   * **Narrower than MongoDB's**, and the error message says why: SQLite forbids
   * subqueries in a partial index's `WHERE`, and every comparison this library
   * compiles carries one so that `{ status: 'A' }` also matches
   * `{ status: ['A'] }`. `$exists`, `$and` and `$or` are what is left.
   */
  partialFilterExpression?: Document
}

export interface DropIndexOptions extends SessionOption {}

export interface ListIndexesOptions extends SessionOption {}

export interface IndexDescription {
  name: string
  key: Record<string, IndexDirection>
  unique?: boolean
  sparse?: boolean
  partialFilterExpression?: Document
}

/** One entry of `createIndexes()`, as the driver shapes it. */
export interface IndexDescriptionInput extends Omit<CreateIndexOptions, 'session'> {
  key: Record<string, IndexDirection>
}

/**
 * A full-text search index (BACKLOG item 31) - this library's OWN feature,
 * with no MongoDB parity claim. `$text` cannot be honest here (FTS5's stemmer
 * disagrees with MongoDB's, so the same query would return different
 * documents) and `$search` is Atlas-only, so neither can be oracle-verified;
 * this API promises only what it can keep, and the tokenizer - the thing that
 * cannot be made to agree with anybody - is named by the caller.
 */
export interface SearchIndexDescription {
  /**
   * Defaults to 'default'. Letters, digits, '_' and '-' only: the name is the
   * suffix of a physical table and has to round-trip back out of it.
   */
  name?: string
  /**
   * The document paths to index (dot notation). A path contributes its value
   * when it is a string, and its STRING elements (joined by spaces) when it is
   * an array - anything else contributes nothing, which is the rule MongoDB's
   * own text indexes follow.
   */
  fields: string[]
  /**
   * The FTS5 tokenizer spec, verbatim - e.g. 'porter', 'trigram', or
   * 'unicode61 remove_diacritics 2'. FTS5's default (unicode61) when omitted.
   */
  tokenizer?: string
}

/** What `listSearchIndexes()` reports: the description, recovered from the schema. */
export interface SearchIndexInfo {
  name: string
  fields: string[]
  tokenizer?: string
}

export interface CreateSearchIndexOptions extends SessionOption {}

export interface DropSearchIndexOptions extends SessionOption {}

export interface ListSearchIndexesOptions extends SessionOption {}

export interface SearchTextOptions extends SessionOption {
  /** Which search index to query. Only needed when the collection has more than one. */
  index?: string
  /** As on `find()`: 0 means no limit, a negative limit its absolute value. */
  limit?: number
  skip?: number
}

/** One `searchText()` hit. */
export interface SearchHit<TSchema extends Document = Document> {
  /**
   * BM25 relevance, higher is more relevant. The ORDERING is the contract;
   * the magnitude is FTS5's and can sit near zero for terms most documents
   * contain.
   */
  score: number
  document: WithId<TSchema>
}

export type SortSpecification = string | Record<string, 1 | -1>

/**
 * Force a particular index, by name or by the key pattern it was built from.
 *
 * SQLite spells it `INDEXED BY`, and like MongoDB's hint it FAILS rather than
 * quietly falling back: an index that cannot serve the query raises "no query
 * solution", and an index that does not exist raises before that.
 */
export type Hint = string | Record<string, IndexDirection>

export interface FindOptions extends SessionOption {
  sort?: SortSpecification
  limit?: number
  skip?: number
  projection?: ProjectionSpec
  hint?: Hint
}

export interface CountOptions extends SessionOption {
  /** Stop counting after this many matches. */
  limit?: number
  /** Skip this many matches before counting. */
  skip?: number
  hint?: Hint
}

export interface EstimatedDocumentCountOptions extends SessionOption {}

export interface DistinctOptions extends SessionOption {}

export interface AggregateOptions extends SessionOption {}

export interface DropCollectionOptions extends SessionOption {}

export interface RenameOptions extends SessionOption {
  /** Drop an existing collection of the target name instead of failing. */
  dropTarget?: boolean
}

export interface InsertOneOptions extends SessionOption {}

export interface DeleteOptions extends SessionOption {}

export interface CreateCollectionOptions extends SessionOption {}

export interface DropDatabaseOptions extends SessionOption {}

export interface ListCollectionsOptions extends SessionOption {}

export interface DbStatsOptions extends SessionOption {}

/**
 * `db.stats()`. The counts mean what they do on MongoDB; the byte figures
 * describe a SQLite file. See the method for which is which.
 */
export interface DbStats {
  db: string
  collections: number
  objects: number
  avgObjSize: number
  dataSize: number
  storageSize: number
  indexes: number
  indexSize: number
  totalSize: number
  ok: number
}

export interface InsertManyOptions extends SessionOption {
  /**
   * Ordered (the default) inserts serially and stops at the first failure.
   * Unordered attempts every document and reports the failures together.
   */
  ordered?: boolean
}

// `AnyBulkWriteOperation` lives in filter-types.ts, so its filters and updates
// can be typed as `Filter<TSchema>`/`UpdateFilter<TSchema>` like the standalone
// methods - types.ts is below filter-types.ts in the dependency graph and
// cannot import them without closing a cycle.

export interface BulkWriteOptions extends SessionOption {
  /** Ordered (the default) stops at the first failed operation. */
  ordered?: boolean
}

export interface BulkWriteResult {
  acknowledged: boolean
  insertedCount: number
  matchedCount: number
  modifiedCount: number
  deletedCount: number
  upsertedCount: number
  /** `{ <index in the operation list>: <_id> }`, as the driver reports them. */
  insertedIds: Record<number, string>
  upsertedIds: Record<number, string>
}

/** One collection, as `db.listCollections()` describes it. */
export interface CollectionInfo {
  name: string
  type: 'collection'
}

export interface UpdateOptions extends SessionOption {
  /** Insert a document built from the filter and the update when nothing matches. */
  upsert?: boolean
  /**
   * Which array elements `$[<identifier>]` writes to, one document per
   * identifier: `[{ 'e.score': { $lt: 50 } }]` for a path of `'grades.$[e].score'`.
   */
  arrayFilters?: Document[]
}

export interface ReplaceOptions extends SessionOption {
  /** Insert the replacement (plus any `_id` the filter pins) when nothing matches. */
  upsert?: boolean
}

export interface FindOneAndUpdateOptions extends SessionOption {
  /** Which version to return. Defaults to 'before', as the driver does. */
  returnDocument?: 'before' | 'after'
  upsert?: boolean
  sort?: SortSpecification
  projection?: ProjectionSpec
  /** Which array elements `$[<identifier>]` writes to. See `UpdateOptions`. */
  arrayFilters?: Document[]
}

export interface FindOneAndReplaceOptions extends FindOneAndUpdateOptions {}

export interface FindOneAndDeleteOptions extends SessionOption {
  sort?: SortSpecification
  projection?: ProjectionSpec
}

/** Where an aggregation pipeline's stages actually run. See `AggregationCursor.explain`. */
export interface PipelineExplanation {
  /** The SELECT the pushed-down leading stages compiled to. */
  sql: string
  /** How many leading stages SQLite runs. The rest run in JavaScript. */
  pushedDown: number
  /** The names of the stages that did not push down, in order. */
  inJavaScript: string[]
}

/**
 * What every cursor can do, whatever produced it - the driver calls this
 * `AbstractCursor`, and `map()` returns one because a mapped cursor is no
 * longer a cursor over documents of the collection's schema.
 */
export interface Cursor<TDocument> {
  next: () => Promise<TDocument | null>
  /**
   * The next document if one is already available, else null.
   *
   * On a real server this is "do not wait for the network"; `node:sqlite` is
   * synchronous and has no such state, so it is exactly `next()`. It exists
   * because ported code calls it.
   */
  tryNext: () => Promise<TDocument | null>
  /** True while another document is waiting. Peeks; it never consumes one. */
  hasNext: () => Promise<boolean>
  toArray: () => Promise<TDocument[]>
  /** Applies `fn` to every remaining document, then closes the cursor. */
  forEach: (fn: (doc: TDocument) => unknown) => Promise<void>
  close: () => Promise<void>
  [Symbol.asyncIterator]: () => AsyncIterableIterator<TDocument>
}

/** What `find().explain()` reports. This library's own shape - see the method. */
export interface QueryExplanation {
  /** The SELECT this cursor runs. */
  sql: string
  /** Its bound parameters, in the order the compiler allocated them. */
  params: Record<string, string | number | null>
  /** SQLite's `EXPLAIN QUERY PLAN` output, one string per step. */
  plan: string[]
  /** The indexes the plan names, if any - the question the method exists for. */
  indexes: string[]
}

export interface AggregationCursor<TSchema extends Document = Document> extends Cursor<TSchema> {
  /**
   * Where this pipeline's work happens. Unlike MongoDB's `explain`, this
   * reports the SQL/JavaScript split rather than an index plan - the question
   * it answers is "is my leading $match still index-eligible?".
   */
  explain: () => PipelineExplanation
}

export interface FindCursor<TSchema extends Document = Document> extends Cursor<WithId<TSchema>> {
  /** Sorts results in MongoDB's BSON type order. Chainable; throws once iteration has started. */
  sort: (spec: SortSpecification) => FindCursor<TSchema>
  /** Caps the number of results; 0 means no limit. Chainable; throws once iteration has started. */
  limit: (count: number) => FindCursor<TSchema>
  /** Skips the first `count` results. Chainable; throws once iteration has started. */
  skip: (count: number) => FindCursor<TSchema>
  /** Restricts the fields returned. Chainable; throws once iteration has started. */
  project: (spec: ProjectionSpec) => FindCursor<TSchema>
  /** A cursor over transformed documents. Not chainable, exactly as the driver's is not. */
  map: <T>(transform: (doc: WithId<TSchema>) => T) => Cursor<T>
  /** Puts the cursor back to un-started, so it can be iterated again. */
  rewind: () => void
  /** How many documents this cursor would yield, honouring its skip and limit. */
  count: () => Promise<number>
  /**
   * The SQL this cursor runs and the plan SQLite chose for it.
   *
   * MongoDB's shape is a large nested report about a query planner that is not
   * here, so this is this library's own - and it answers the question the
   * MongoDB one is usually opened for: is the index being used? It is `async`
   * because it runs a statement; `AggregationCursor.explain()` is not, because
   * the split it reports is decided at compile time.
   */
  explain: () => Promise<QueryExplanation>
}

export interface DbOptions {
  /** Logs every statement to the console. */
  debug: boolean
  /**
   * Rejects the constructs whose answer is KNOWN to differ from MongoDB's,
   * instead of quietly returning the different answer.
   *
   * This library is a compatible subset, and everything outside that subset is
   * already an error. The cases below are the harder ones: they are accepted,
   * they return something, and what they return is not what a server would
   * say. That is exactly what makes a partial implementation dangerous to
   * develop against, so `strict` turns each of them into a failure:
   *
   * - a dotted path that could cross more array levels than the compiler
   *   expands (see MAX_ARRAY_PATH_DEPTH);
   * - `$type` naming a BSON type the storage layer cannot hold, which compiles
   *   to "matches nothing" rather than to a fact about the data;
   * - a sort whose key holds an ARRAY in some document, which MongoDB orders
   *   by the array's smallest/largest element and this library orders as text;
   * - a sort whose key holds BINARY in some document, which MongoDB orders by
   *   length then bytes and this library by the stored base64 text;
   * - an aggregation field path that runs through an array, which MongoDB maps
   *   over and this library reads as missing.
   *
   * It is a boundary check, not a proof of equivalence: it catches the
   * divergences that are known and detectable, and cannot catch one nobody has
   * found yet. Off by default; the intended use is a test suite that runs
   * against this library instead of a real mongod.
   */
  strict: boolean
  /**
   * Milliseconds a write waits behind a competing writer before failing with
   * SQLITE_BUSY. Only meaningful for file-backed databases - WAL mode still
   * serialises writers, and SQLite's default of 0 fails instantly on contention.
   */
  busyTimeoutMs: number
  /**
   * What `db.databaseName` reports.
   *
   * A SQLite file has no name of its own the way a MongoDB database does, so
   * this is carried rather than derived. It names nothing physical - two `Db`s
   * on the same file with different names are the same data.
   */
  databaseName?: string
}
