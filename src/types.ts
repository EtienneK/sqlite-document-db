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

export type IndexDirection = 1 | -1

export type IndexSpecification = string | Record<string, IndexDirection>

export interface CreateIndexOptions {
  unique?: boolean
  name?: string
}

export interface IndexDescription {
  name: string
  key: Record<string, IndexDirection>
  unique?: boolean
}

export type SortSpecification = string | Record<string, 1 | -1>

export interface FindOptions {
  sort?: SortSpecification
  limit?: number
  skip?: number
  projection?: ProjectionSpec
}

export interface CountOptions {
  /** Stop counting after this many matches. */
  limit?: number
  /** Skip this many matches before counting. */
  skip?: number
}

export interface InsertManyOptions {
  /**
   * Ordered (the default) inserts serially and stops at the first failure.
   * Unordered attempts every document and reports the failures together.
   */
  ordered?: boolean
}

/** One entry of a `bulkWrite` batch. Exactly one key, as MongoDB requires. */
export type AnyBulkWriteOperation<TSchema extends Document = Document> =
  | { insertOne: { document: TSchema } }
  | { updateOne: { filter: Document, update: Document, upsert?: boolean } }
  | { updateMany: { filter: Document, update: Document, upsert?: boolean } }
  | { replaceOne: { filter: Document, replacement: Document, upsert?: boolean } }
  | { deleteOne: { filter: Document } }
  | { deleteMany: { filter: Document } }

export interface BulkWriteOptions {
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

export interface UpdateOptions {
  /** Insert a document built from the filter and the update when nothing matches. */
  upsert?: boolean
  /**
   * Which array elements `$[<identifier>]` writes to, one document per
   * identifier: `[{ 'e.score': { $lt: 50 } }]` for a path of `'grades.$[e].score'`.
   */
  arrayFilters?: Document[]
}

export interface ReplaceOptions {
  /** Insert the replacement (plus any `_id` the filter pins) when nothing matches. */
  upsert?: boolean
}

export interface FindOneAndUpdateOptions {
  /** Which version to return. Defaults to 'before', as the driver does. */
  returnDocument?: 'before' | 'after'
  upsert?: boolean
  sort?: SortSpecification
  projection?: ProjectionSpec
  /** Which array elements `$[<identifier>]` writes to. See `UpdateOptions`. */
  arrayFilters?: Document[]
}

export interface FindOneAndReplaceOptions extends FindOneAndUpdateOptions {}

export interface FindOneAndDeleteOptions {
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

export interface AggregationCursor<TSchema extends Document = Document> {
  next: () => Promise<TSchema | null>
  toArray: () => Promise<TSchema[]>
  close: () => Promise<void>
  /**
   * Where this pipeline's work happens. Unlike MongoDB's `explain`, this
   * reports the SQL/JavaScript split rather than an index plan - the question
   * it answers is "is my leading $match still index-eligible?".
   */
  explain: () => PipelineExplanation
  [Symbol.asyncIterator]: () => AsyncIterableIterator<TSchema>
}

export interface FindCursor<TSchema extends Document = Document> {
  /** Sorts results in MongoDB's BSON type order. Chainable; throws once iteration has started. */
  sort: (spec: SortSpecification) => FindCursor<TSchema>
  /** Caps the number of results; 0 means no limit. Chainable; throws once iteration has started. */
  limit: (count: number) => FindCursor<TSchema>
  /** Skips the first `count` results. Chainable; throws once iteration has started. */
  skip: (count: number) => FindCursor<TSchema>
  /** Restricts the fields returned. Chainable; throws once iteration has started. */
  project: (spec: ProjectionSpec) => FindCursor<TSchema>
  next: () => Promise<WithId<TSchema> | null>
  toArray: () => Promise<Array<WithId<TSchema>>>
  close: () => Promise<void>
  [Symbol.asyncIterator]: () => AsyncIterableIterator<WithId<TSchema>>
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
}
