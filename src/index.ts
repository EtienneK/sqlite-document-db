/**
 * The public entry point: everything the package exports, and nothing else.
 *
 * `Db` lives in db.ts, `Collection` in collection.ts and the shared types in
 * types.ts. This file holds no implementation on purpose - the dependency rule
 * in CLAUDE.md says nothing may import the entry point, and a file that is only
 * re-exports cannot tempt anyone to.
 */

import { Db } from './db.js'

export { Db } from './db.js'
export { Collection } from './collection.js'
// The storage codec, exported for the raw SQL escape hatch: rows come back with
// `data` as JSON TEXT, and these are how that text becomes a document and back.
// Anything writing a document row by hand MUST go through stringifyDocument, or
// Dates stop round-tripping.
export { parse as parseDocument, stringify as stringifyDocument } from './ejson.js'
export { SqlFragment } from './raw-sql.js'
export type { RawSql } from './raw-sql.js'
// The drop-in-shaped entry point, for a suite that wants to swap one import
// rather than every call. See src/mongo-client.ts for what it does and does not
// promise.
export { MongoClient } from './mongo-client.js'
export type { MongoClientOptions } from './mongo-client.js'
// `client.startSession()`, and the `{ session }` every operation accepts.
export { ClientSession } from './client-session.js'
export type { ClientSessionOptions, TransactionOptions } from './client-session.js'
export type { Driver, DriverParams, DriverRow, DriverStatement } from './driver.js'
export { DUPLICATE_KEY_ERROR, MongoServerError } from './errors.js'
export type { PartialWriteResult } from './errors.js'
export type { ProjectionSpec } from './projection.js'
export type {
  AddToSetOperand, ArrayPaths, BsonTypeAlias, Condition, Filter, FilterOperators,
  InferIdType, Paths, PathValue, PositionalPaths, PullOperand, PushOperand, UpdateFilter
} from './filter-types.js'
export type {
  AggregateOptions, AggregationCursor, AnyBulkWriteOperation, BulkWriteOptions, BulkWriteResult,
  CollectionInfo, CountOptions, CreateCollectionOptions, CreateIndexOptions, DbOptions,
  DeleteOptions, DeleteResult, DistinctOptions, Document, DropCollectionOptions,
  DropDatabaseOptions, DropIndexOptions, EstimatedDocumentCountOptions, FindCursor,
  FindOneAndDeleteOptions, FindOneAndReplaceOptions, FindOneAndUpdateOptions, FindOptions,
  IndexDescription, IndexDirection, IndexSpecification, InsertManyOptions, InsertManyResult,
  InsertOneOptions, InsertOneResult, ListCollectionsOptions, ListIndexesOptions,
  PipelineExplanation, ReplaceOptions, SessionOption, SortSpecification, UpdateOptions,
  UpdateResult, WithId, WithoutId
} from './types.js'

export default Db
