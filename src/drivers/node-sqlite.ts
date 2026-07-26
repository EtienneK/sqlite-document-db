/**
 * The `node:sqlite` driver - the only one this package ships, and the reason
 * the package has no runtime dependencies.
 *
 * It is a thin adapter, not a layer: every method forwards straight to
 * `DatabaseSync`. That thinness is the point. If this file ever grows logic,
 * the logic belongs on the other side of the seam (in `collection.ts`), because
 * every future driver would otherwise have to reimplement it.
 */

import { DatabaseSync } from 'node:sqlite'

import type { Driver, DriverParams, DriverRow, DriverStatement } from '../driver.js'

/**
 * `node:sqlite` binds either a params object or positional arguments, and its
 * signatures differ; both spellings are normalised to one call here.
 */
function bind (
  statement: ReturnType<DatabaseSync['prepare']>,
  method: 'run' | 'get' | 'all' | 'iterate',
  params?: DriverParams
): any {
  const call = statement[method].bind(statement) as (...args: any[]) => any
  if (params === undefined) return call()
  return Array.isArray(params) ? call(...params) : call(params)
}

export function nodeSqliteDriver (url: string): Driver {
  const db = new DatabaseSync(url)

  return {
    supportsFunctions: true,

    prepare (sql: string): DriverStatement {
      const statement = db.prepare(sql)
      return {
        run: params => bind(statement, 'run', params) as { changes: number | bigint },
        get: params => bind(statement, 'get', params) as DriverRow | undefined,
        all: params => bind(statement, 'all', params) as DriverRow[],
        iterate: params => bind(statement, 'iterate', params) as Iterator<DriverRow>
      }
    },

    exec (sql: string): void {
      db.exec(sql)
    },

    createFunction (name, implementation): void {
      // deterministic: the same arguments always give the same answer, which
      // lets SQLite cache and reorder calls. True of $regex, the only user.
      db.function(name, { deterministic: true }, implementation as never)
    },

    close (): void {
      db.close()
    }
  }
}
