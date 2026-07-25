/**
 * MongoDB-shaped errors (BACKLOG item 10).
 *
 * Application code branches on `error.code === 11000` to tell "this document
 * already exists" apart from "the write failed" - it is the one error code
 * almost every MongoDB application handles. Raw `node:sqlite` errors carry
 * `SQLITE_CONSTRAINT_UNIQUE` and a message naming an internal index instead,
 * which gives callers nothing portable to branch on.
 *
 * The class name and the `code`/`keyValue` fields mirror the official driver's
 * (DR-2, "compatible subset"), so a caller's error handling ports unchanged.
 * `instanceof` against the driver's own class cannot work - that would mean
 * depending on `mongodb` - so branch on `code`.
 */

/** MongoDB's error code for a unique-index violation. */
export const DUPLICATE_KEY_ERROR = 11000

/** SQLite's extended result codes for the constraint failures we translate. */
const SQLITE_CONSTRAINT_UNIQUE = 2067
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555

export interface MongoServerErrorOptions {
  code: number
  keyValue?: Record<string, unknown>
  cause?: unknown
}

export class MongoServerError extends Error {
  override readonly name = 'MongoServerError'
  /** MongoDB's numeric error code, e.g. 11000 for a duplicate key. */
  readonly code: number
  /** The offending key, when the error is a duplicate-key error. */
  readonly keyValue?: Record<string, unknown>

  constructor (message: string, options: MongoServerErrorOptions) {
    super(message, { cause: options.cause })
    this.code = options.code
    if (options.keyValue !== undefined) this.keyValue = options.keyValue
  }
}

interface SqliteError extends Error { errcode: number }

function isSqliteConstraintError (error: unknown): error is SqliteError {
  if (!(error instanceof Error)) return false
  const { errcode } = error as Partial<SqliteError>
  return errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY
}

/**
 * Translates a `node:sqlite` unique-constraint failure into the driver's
 * duplicate-key error, leaving every other error untouched. `describeIndex`
 * maps the physical SQLite index name out of the message back to the index
 * name the caller knows (`_id_`, `email_1`, ...).
 */
export function toMongoError (
  error: unknown,
  collectionName: string,
  describeIndex: (physicalName: string) => string
): unknown {
  if (!isSqliteConstraintError(error)) return error
  const physicalName = /index '(.+)'/.exec(error.message)?.[1]
  const index = physicalName === undefined ? 'unknown' : describeIndex(physicalName)
  return new MongoServerError(
    `E11000 duplicate key error collection: ${collectionName} index: ${index}`,
    { code: DUPLICATE_KEY_ERROR, cause: error }
  )
}
