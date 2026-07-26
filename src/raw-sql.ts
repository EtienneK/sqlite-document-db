/**
 * The raw SQL escape hatch (BACKLOG item 20).
 *
 * The pitch of this library is "your documents are in SQLite", and until this
 * existed there was no way to USE SQLite: a caller who needed a recursive CTE,
 * a window function or a join the compiler does not emit had to open a SECOND
 * connection to the same file - a different transaction, a different lock, and
 * a WAL writer fighting itself.
 *
 * Three tagged templates, named after the driver methods a SQLite user already
 * knows:
 *
 * ```javascript
 * const rows = await db.sql.all`SELECT COUNT(*) AS n FROM ${db.table('users')}`
 * const one  = await db.sql.get`SELECT * FROM ${db.table('users')} LIMIT 1`
 * const { changes } = await db.sql.run`DELETE FROM ${db.table('users')} WHERE rowid = ${id}`
 * ```
 *
 * Three rules make it safe to hand out:
 *
 * 1. **Interpolations are BOUND, never spliced.** Each `${}` becomes a `?`, so
 *    the escape hatch cannot be an injection hatch - the same posture the query
 *    compiler takes for user-supplied values.
 * 2. **Identifiers come from the library.** A table name cannot be bound, and
 *    the physical name is not guessable anyway (see `tableNameFor` - `Users` and
 *    `users` are distinguished by a digest). `db.table(name)` returns the
 *    already-quoted name as a `SqlFragment`, the ONE thing spliced rather than
 *    bound, and it is produced by this library rather than by the caller.
 * 3. **Rows come back RAW.** A document arrives as the `data` column's JSON
 *    TEXT, not as a document. Decoding is opt-in and visible, through the
 *    exported `parseDocument`. Returning decoded documents would have made the
 *    `{"$date": ...}` storage wrapper an implementation detail that leaks in
 *    only some places; raw is the honest shape for an escape hatch, and the
 *    decoder is one call away.
 *
 * What this does NOT do: map SQLite errors to MongoDB ones (a constraint
 * violation here surfaces as SQLite reports it, because you are writing SQL,
 * not calling `insertOne`), or protect the storage format. Writing a document
 * row by hand means matching what `stringifyDocument` produces - which is why
 * that is exported too.
 */

import type { Driver, DriverRow } from './driver.js'
import { stringify as stringifyDocument } from './ejson.js'

/**
 * A piece of SQL that is spliced into a template rather than bound to it.
 *
 * Only this library constructs these - `db.table()` is the only source - so a
 * caller cannot use one to smuggle in unescaped text without deliberately
 * reaching for the constructor.
 */
export class SqlFragment {
  readonly sql: string

  constructor (sql: string) {
    this.sql = sql
  }

  toString (): string {
    return this.sql
  }
}

/** What a value may be bound as. Mirrors what SQLite itself accepts. */
type Bindable = string | number | null

/** The `db.sql` namespace. */
export interface RawSql {
  /** Every row a statement produces. */
  all: <T = DriverRow>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>
  /** The first row, or `undefined`. */
  get: <T = DriverRow>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T | undefined>
  /** Runs a statement for its effect, reporting how many rows it changed. */
  run: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<{ changes: number }>
}

export function createRawSql (db: Driver, isDebug: () => boolean): RawSql {
  const compile = (strings: TemplateStringsArray, values: unknown[]): { sql: string, params: Bindable[] } => {
    const compiled = compileTemplate(strings, values)
    if (isDebug()) console.log(compiled.sql, compiled.params)
    return compiled
  }

  return {
    all: async <T = DriverRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> => {
      const { sql, params } = compile(strings, values)
      return db.prepare(sql).all(params).map(plainRow) as T[]
    },
    get: async <T = DriverRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T | undefined> => {
      const { sql, params } = compile(strings, values)
      const row = db.prepare(sql).get(params)
      return (row === undefined ? undefined : plainRow(row)) as T | undefined
    },
    run: async (strings: TemplateStringsArray, ...values: unknown[]): Promise<{ changes: number }> => {
      const { sql, params } = compile(strings, values)
      return { changes: Number(db.prepare(sql).run(params).changes) }
    }
  }
}

/**
 * Copies a row onto an ordinary object.
 *
 * `node:sqlite` returns rows with a NULL prototype, which is a property of that
 * engine rather than of this API: `toStrictEqual`, `instanceof Object` and
 * `row.hasOwnProperty(...)` all behave surprisingly, and a driver that returned
 * plain objects would hand callers a different shape for the same query - a
 * leak straight through the seam DR-3 exists to close. Spread rather than
 * assignment, so a column aliased `__proto__` stays an own property instead of
 * becoming a prototype write.
 */
function plainRow (row: DriverRow): DriverRow {
  return { ...row }
}

function compileTemplate (
  strings: TemplateStringsArray, values: unknown[]
): { sql: string, params: Bindable[] } {
  if (!Array.isArray(strings) || !Array.isArray((strings as { raw?: unknown }).raw)) {
    throw Error(
      'db.sql.all/get/run are tagged templates: write db.sql.all`SELECT ...`, ' +
      'not db.sql.all("SELECT ...") - a plain string would have nothing bound and nothing checked'
    )
  }

  let sql = strings[0] ?? ''
  const params: Bindable[] = []
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value instanceof SqlFragment) {
      sql += value.sql
    } else {
      params.push(bindable(value, i))
      sql += '?'
    }
    sql += strings[i + 1] ?? ''
  }

  assertSingleStatement(sql)
  return { sql, params }
}

/**
 * Converts an interpolated value into something SQLite can bind.
 *
 * A `Date` becomes its ISO string, which is exactly what the storage encoder
 * writes at `<field>.$date` - so `WHERE json_extract(data, '$.at.$date') >
 * ${cutoff}` compares the right things. Objects and arrays become their storage
 * JSON, ready for `json(?)`. Booleans become 1/0 because SQLite has no boolean.
 */
function bindable (value: unknown, index: number): Bindable {
  if (value === null) return null

  switch (typeof value) {
    case 'string':
    case 'number':
      return value
    case 'boolean':
      return value ? 1 : 0
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw Error(`cannot bind an invalid Date (interpolation ${index + 1})`)
    return value.toISOString()
  }

  if (typeof value === 'object') return stringifyDocument(value)

  throw Error(
    `cannot bind a value of type ${value === undefined ? 'undefined' : typeof value} ` +
    `(interpolation ${index + 1}): bind a string, number, boolean, null, Date, object or array`
  )
}

/**
 * Rejects a template holding more than one statement.
 *
 * This is not tidiness. `DatabaseSync.prepare()` compiles the FIRST statement
 * and silently discards the rest, so `db.sql.run\`INSERT ...; INSERT ...\``
 * inserts one row and reports success - measured, not assumed. An escape hatch
 * that half-executes is worse than one that refuses.
 *
 * The scan skips string literals, quoted identifiers and comments, so a
 * semicolon inside `'a;b'` is data rather than a separator.
 */
function assertSingleStatement (sql: string): void {
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!

    // Quoted regions: ' and " and ` take a doubled quote as an escaped one,
    // [ ] (SQLite's legacy identifier form) has no escape.
    if (char === "'" || char === '"' || char === '`') {
      i = skipQuoted(sql, i, char)
      continue
    }
    if (char === '[') {
      i = sql.indexOf(']', i + 1)
      if (i === -1) return // unterminated - let SQLite report it
      continue
    }
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      if (end === -1) return
      i = end
      continue
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) return
      i = end + 1
      continue
    }

    // A separator only matters if something other than whitespace follows it:
    // a single trailing semicolon is ordinary and harmless.
    if (char === ';' && sql.slice(i + 1).trim() !== '') {
      throw Error(
        'db.sql takes ONE statement: node:sqlite compiles the first and silently ignores the rest, ' +
        'so a script would half-execute and report success. Send them one at a time, ' +
        'inside db.withTransaction() if they must be atomic'
      )
    }
  }
}

/** The index of the closing quote, or the end of the string if unterminated. */
function skipQuoted (sql: string, start: number, quote: string): number {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== quote) continue
    if (sql[i + 1] === quote) { i++; continue } // '' is an escaped quote
    return i
  }
  return sql.length
}
