/**
 * Shared machinery for the stress suite (BACKLOG item 34).
 *
 * Two things live here that the phases all need: a file-backed database in a
 * directory that gets swept, and the measurement helpers - because what this
 * suite asserts is CEILINGS, not timings. A shared CI runner cannot be held to
 * a duration; it can be held to "this completed", "the compiled SQL stayed
 * under N bytes" and "peak RSS stayed under N MB", each of which fails on a
 * real regression and not on a busy afternoon.
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { Db } from '../src/index.js'

/**
 * Documents of each cheap shape. Overridable with `STRESS_DOCS=5000 npm run
 * stress` for a deliberately larger run; the default is sized to be worth
 * running on every change.
 */
export const DOC_COUNT = Number(process.env.STRESS_DOCS ?? 500)

/**
 * Where the databases live.
 *
 * A real FILE, not `:memory:`, and not `os.tmpdir()` - the same reasoning as
 * bench/db.bench.ts. /tmp is a tmpfs on many Linux systems, so a commit there
 * costs no fsync and the suite would be measuring a configuration nobody runs.
 */
export function makeStressDir (): string {
  for (const entry of readdirSync(process.cwd())) {
    if (entry.startsWith('.stress-')) rmSync(join(process.cwd(), entry), { recursive: true, force: true })
  }
  return mkdtempSync(join(process.cwd(), '.stress-'))
}

export async function openStressDb (dir: string, name: string, options = {}): Promise<Db> {
  return await Db.fromUrl(join(dir, `${name}.db`), options)
}

export function fileSizeBytes (path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Milliseconds, peak RSS and a label - one row of the report printed at the end. */
export interface Measurement {
  phase: string
  label: string
  ms: number
  rssMb: number
}

const measurements: Measurement[] = []
let peakRssBytes = 0

/** Runs `work`, records how long it took and the RSS after it, and returns its result. */
export async function timed <T>(phase: string, label: string, work: () => Promise<T> | T): Promise<T> {
  const started = performance.now()
  const result = await work()
  const ms = performance.now() - started
  const rss = process.memoryUsage().rss
  if (rss > peakRssBytes) peakRssBytes = rss
  measurements.push({ phase, label, ms, rssMb: Math.round(rss / 1024 / 1024) })
  return result
}

export function peakRssMb (): number {
  return Math.round(peakRssBytes / 1024 / 1024)
}

export function slowest (limit = 15): Measurement[] {
  return measurements.toSorted((a, b) => b.ms - a.ms).slice(0, limit)
}

export function totalMs (): number {
  return measurements.reduce((sum, m) => sum + m.ms, 0)
}

export function measurementCount (): number {
  return measurements.length
}

/**
 * Every SQL statement `work` caused, captured through the `debug` option.
 *
 * `debug: true` makes the library `console.log` each statement, so a database
 * opened with it doubles as an instrument - which is how the compiled-SQL
 * ceilings below get measured without adding an API for it. The db passed in
 * MUST have been opened with `{ debug: true }` or this reports nothing.
 */
export async function captureSql <T>(work: () => Promise<T> | T): Promise<{ result: T, statements: string[] }> {
  const statements: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'string') statements.push(args[0])
    else original(...args)
  }
  try {
    return { result: await work(), statements }
  } finally {
    console.log = original
  }
}

export function longest (statements: string[]): string {
  return statements.reduce((longestSoFar, sql) => sql.length > longestSoFar.length ? sql : longestSoFar, '')
}

/** The report printed once, after every phase has run. */
export function printReport (extra: Array<[string, string | number]>): void {
  const rows = slowest()
  const width = Math.max(...rows.map(r => `${r.phase} / ${r.label}`.length))
  console.log('\n  stress report')
  console.log(`  ${'-'.repeat(width + 22)}`)
  for (const [label, value] of extra) console.log(`  ${label.padEnd(width)}  ${String(value)}`)
  console.log(`  ${'-'.repeat(width + 22)}`)
  console.log(`  slowest of ${measurementCount()} measured operations:`)
  for (const row of rows) {
    console.log(`  ${`${row.phase} / ${row.label}`.padEnd(width)}  ${row.ms.toFixed(1).padStart(9)} ms  ${String(row.rssMb).padStart(5)} MB`)
  }
  console.log('')
}
