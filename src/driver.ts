/**
 * The database driver seam (BACKLOG DR-3).
 *
 * Everything this library needs from an engine, and nothing more: prepare a
 * statement, run it, read rows back, execute DDL, register a scalar function.
 * `node:sqlite` is the only implementation today and the only one this package
 * depends on.
 *
 * **Why this exists before it is needed.** Porting to another engine without a
 * seam means forking `collection.ts`, `query.ts` and `update.ts` - measured at
 * 59% of `src`. Behind a seam the same work ADDS a file. The interface is
 * therefore shaped by what other engines can actually offer, not by what
 * `node:sqlite` happens to expose:
 *
 * - **`all()` returns rows; `iterate()` MAY fall back to it.** libSQL's remote
 *   client and Turso's JavaScript binding have no streaming API - `execute()`
 *   returns every row. A driver that cannot stream implements `iterate` as
 *   "materialise, then yield", and the only casualty is memory, not
 *   correctness.
 * - **`createFunction` is OPTIONAL.** `$regex` compiles to a registered
 *   JavaScript function, and neither libSQL nor Turso supports one
 *   (`sqlite3_create_function` is "❌ No" in Turso's COMPAT.md). A driver that
 *   returns false from `supportsFunctions` tells the compiler to fall back to
 *   filtering in JavaScript - which the benchmarks say costs little, because
 *   `$regex` is already "JS RegExp per row".
 * - **Results are plain rows**, so nothing here knows about documents, JSON, or
 *   the storage encoding.
 *
 * The interface is deliberately SYNCHRONOUS, matching `node:sqlite`. Async
 * engines are a separate step (see item 24): the public API is already async,
 * but the internals are not, and converting them is its own change rather than
 * something to smuggle in here.
 */

/** One row, as the driver hands it back. */
export type DriverRow = Record<string, unknown>

/** Values a driver can bind: named (`:p0`) or positional. */
export type DriverParams = Record<string, string | number | null> | unknown[]

export interface DriverStatement {
  /** Runs a write, reporting how many rows changed. */
  run: (params?: DriverParams) => { changes: number | bigint }
  /** The first row, or undefined. */
  get: (params?: DriverParams) => DriverRow | undefined
  /** Every row. */
  all: (params?: DriverParams) => DriverRow[]
  /**
   * Rows one at a time. A driver without a streaming API may materialise and
   * yield - callers must not assume laziness for correctness, only for memory.
   */
  iterate: (params?: DriverParams) => Iterator<DriverRow>
}

export interface Driver {
  prepare: (sql: string) => DriverStatement
  exec: (sql: string) => void
  close: () => void
  /**
   * Registers a deterministic scalar function, when the engine has them.
   * Callers must check `supportsFunctions` first; `$regex` is the only feature
   * that needs one, and it has a JavaScript fallback for engines that do not.
   */
  createFunction?: (name: string, implementation: (...args: unknown[]) => unknown) => void
  /** Whether `createFunction` will work. Read this, do not probe. */
  readonly supportsFunctions: boolean
}
