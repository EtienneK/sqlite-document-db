/**
 * The prepared-statement cache (BACKLOG item 17) - a `Driver` that wraps
 * another `Driver` and reuses prepared statements keyed by their SQL.
 *
 * Everything this library compiles binds its values as named parameters, so
 * the same operation produces the SAME SQL text every time - `updateOne` in a
 * loop was paying one `prepare()` per call for a statement SQLite had already
 * compiled. This wrapper is where that stops, and it sits at the driver seam
 * on purpose: `Db.open` wraps whatever driver it is handed, so every engine
 * gets the cache and no call site knows it exists.
 *
 * **The design problem is a LIFETIME, not a lookup** (which is why the backlog
 * sized this M): `find()` hands its statement to `iterate()` and the cursor
 * owns it until it is exhausted or closed - two cursors sharing one statement
 * would interleave their rows. Three rules keep that impossible:
 *
 * - **The statement is resolved per CALL, not per `prepare()`.** The handle
 *   this wrapper returns is a lazy name for "the statement for this SQL", so
 *   two handles over one SQL never pin one statement object - whoever CALLS
 *   first gets it, and the state is consulted at the moment it matters.
 * - **`iterate()` marks the cached entry BUSY until the iterator is done** -
 *   exhausted, returned early (a `for await` break), or failed. `run`/`get`/
 *   `all` reset the statement they run on, which is safe precisely because a
 *   busy statement is never handed to them.
 * - **A busy hit prepares a TRANSIENT statement instead** - fresh, uncached,
 *   owned by that caller alone. Correctness never waits on the cache.
 *
 * Eviction is LRU past `STATEMENT_CACHE_LIMIT`, skipping busy entries (a live
 * cursor's statement must not be re-prepared out from under it - SQLite would
 * not care, but the entry's busy flag is the interleaving guard). One-off SQL
 * - a TEMP-table batch, an EXPLAIN - just ages out.
 *
 * What is deliberately NOT here: invalidation on DDL. SQLite re-prepares a
 * cached statement transparently when the schema changes, and a statement
 * whose table was dropped fails on its next use with exactly the error a fresh
 * `prepare()` would raise - so there is nothing to invalidate for.
 */

import type { Driver, DriverParams, DriverRow, DriverStatement } from './driver.js'

/**
 * Bound on cached statements per connection. The regex cache's reasoning at a
 * heavier weight: an application generating unbounded distinct SQL (every
 * LIMIT is interpolated, for one) must not grow this without limit.
 */
export const STATEMENT_CACHE_LIMIT = 256

interface CacheEntry {
  statement: DriverStatement
  /** True while a cursor owns the statement - from `iterate()` to its end. */
  busy: boolean
}

export function cachingDriver (inner: Driver, capacity = STATEMENT_CACHE_LIMIT): Driver {
  // Insertion order is recency order: a hit is deleted and re-set.
  const cache = new Map<string, CacheEntry>()

  /** The cached entry for `sql`, or a transient statement when it is busy. */
  const resolve = (sql: string): { entry?: CacheEntry, statement: DriverStatement } => {
    const hit = cache.get(sql)
    if (hit !== undefined) {
      cache.delete(sql)
      if (hit.busy) {
        // Put the busy entry back in its recency slot and step around it.
        cache.set(sql, hit)
        return { statement: inner.prepare(sql) }
      }
      cache.set(sql, hit)
      return { entry: hit, statement: hit.statement }
    }

    const entry: CacheEntry = { statement: inner.prepare(sql), busy: false }
    if (cache.size >= capacity) {
      for (const [key, candidate] of cache) {
        if (candidate.busy) continue
        cache.delete(key)
        break
      }
    }
    cache.set(sql, entry)
    return { entry, statement: entry.statement }
  }

  return {
    supportsFunctions: inner.supportsFunctions,
    ...(inner.createFunction === undefined
      ? {}
      : { createFunction: inner.createFunction.bind(inner) }),

    exec (sql: string): void {
      inner.exec(sql)
    },

    close (): void {
      cache.clear()
      inner.close()
    },

    prepare (sql: string): DriverStatement {
      return {
        run: params => resolve(sql).statement.run(params),
        get: params => resolve(sql).statement.get(params),
        all: params => resolve(sql).statement.all(params),
        iterate: (params?: DriverParams): Iterator<DriverRow> => {
          const { entry, statement } = resolve(sql)
          if (entry === undefined) return statement.iterate(params)

          entry.busy = true
          const rows = statement.iterate(params)
          const release = (): void => { entry.busy = false }
          return {
            next (): IteratorResult<DriverRow> {
              try {
                const step = rows.next()
                if (step.done === true) release()
                return step
              } catch (error) {
                release()
                throw error
              }
            },
            return (value?: unknown): IteratorResult<DriverRow> {
              release()
              return rows.return?.(value) ?? { done: true, value: undefined }
            }
          }
        }
      }
    }
  }
}
