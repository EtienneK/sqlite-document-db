/**
 * A narrow aggregation pipeline (BACKLOG item 16).
 *
 * The design decision worth knowing is where each stage RUNS. A leading run of
 * `$match` / `$sort` / `$skip` / `$limit` is pushed down into SQLite, compiled
 * by exactly the same code `find()` uses - so `$match` at the head of a
 * pipeline is index-eligible, which is the whole reason to have written the
 * query compiler. Every stage after that point runs in JavaScript over the
 * documents streaming out of that query.
 *
 * That split is deliberate rather than provisional. Compiling `$group` to SQL
 * would mean re-implementing BSON comparison order inside `GROUP BY` and the
 * accumulators, for a stage that is nearly always fed a few thousand rows at
 * most; running it in JS reuses src/bson-order.ts, which the SQL side is
 * already checked against. `splitPipeline` reports the boundary so callers can
 * see it (`explainPipeline`), rather than leaving it to guesswork.
 *
 * The stages here are a SUBSET, and unsupported ones are an error rather than
 * a silent no-op - see "Missing Features" in the README for the list.
 */

import { compareBson, equalsBson } from './bson-order.js'
import { encodeValue } from './ejson.js'
import { assertPositiveN, evaluateExpression, pathValue, substituteVariables } from './expression.js'
import { compileProjection, type ProjectionSpec } from './projection.js'
import { ownField, setField } from './safe-object.js'
import type { Document, SortSpecification } from './types.js'

/** The stages this library implements. Anything else is rejected by name. */
const SUPPORTED_STAGES = [
  '$match', '$sort', '$limit', '$skip', '$count', '$group', '$project', '$unwind', '$addFields',
  '$set', '$unset', '$sortByCount', '$lookup'
]

/** Stages that can be pushed into SQL, in the order SQL applies them. */
const PUSHABLE_STAGES = new Set(['$match', '$sort', '$skip', '$limit'])

export interface PipelineSplit {
  /** The filter for the SQL query - the leading `$match` stages, ANDed. */
  filter: Document
  sort?: SortSpecification
  skip?: number
  limit?: number
  /** Stages that could not be pushed down, run in order over the SQL results. */
  jsStages: Document[]
  /** How many leading stages were pushed into SQLite. For explainPipeline(). */
  pushedDown: number
}

/**
 * Splits a pipeline into the part SQLite can run and the part that cannot.
 *
 * The pushdown stops at the first stage that would change what the remaining
 * SQL clauses mean. `$match` only merges while no ordering or window has been
 * applied; `$skip` only while no `$limit` has been (MongoDB's `$limit` then
 * `$skip` takes n and then drops m, which is not what `LIMIT n OFFSET m`
 * does). Everything from that point on runs in JavaScript, including further
 * `$match` stages - correct, just not index-assisted.
 */
export function splitPipeline (pipeline: Document[]): PipelineSplit {
  const matches: Document[] = []
  let sort: SortSpecification | undefined
  let skip: number | undefined
  let limit: number | undefined
  let index = 0

  for (; index < pipeline.length; index++) {
    const [name, value] = stageEntry(pipeline[index]!)
    if (!PUSHABLE_STAGES.has(name)) break

    if (name === '$match') {
      if (sort !== undefined || skip !== undefined || limit !== undefined) break
      matches.push(value as Document)
    } else if (name === '$sort') {
      if (sort !== undefined || skip !== undefined || limit !== undefined) break
      sort = assertSortSpec(value)
    } else if (name === '$skip') {
      if (skip !== undefined || limit !== undefined) break
      skip = assertCount('$skip', value)
    } else {
      if (limit !== undefined) break
      limit = assertCount('$limit', value)
      if (limit === 0) break // MongoDB rejects $limit: 0; find() reads it as "no limit"
    }
  }

  const filter = matches.length === 0 ? {} : (matches.length === 1 ? matches[0]! : { $and: matches })
  const jsStages = pipeline.slice(index)
  for (const stage of jsStages) stageEntry(stage) // validate the rest up front

  return {
    filter,
    ...(sort === undefined ? {} : { sort }),
    ...(skip === undefined ? {} : { skip }),
    ...(limit === undefined ? {} : { limit }),
    jsStages,
    pushedDown: index
  }
}

/** The single `{ $stage: value }` entry a pipeline stage must be. */
function stageEntry (stage: unknown): [string, unknown] {
  const [name, value] = singleStageEntry(stage)
  if (!SUPPORTED_STAGES.includes(name)) {
    throw Error(name.startsWith('$')
      ? `unsupported aggregation stage: ${name} (supported: ${SUPPORTED_STAGES.join(', ')})`
      : `a pipeline stage name must start with '$'; but got: ${name}`)
  }
  return [name, value]
}

/** The shape check alone - shared with the update-pipeline entry, whose allow-list differs. */
function singleStageEntry (stage: unknown): [string, unknown] {
  if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
    throw Error(`each pipeline stage must be a document; but got: ${stage === null ? 'null' : typeof stage}`)
  }
  const entries = Object.entries(stage)
  if (entries.length !== 1) {
    throw Error(`each pipeline stage must contain exactly one operator; but got ${entries.length}: ${JSON.stringify(Object.keys(stage))}`)
  }
  return entries[0]!
}

function assertSortSpec (value: unknown): SortSpecification {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('$sort requires a document of { field: 1 | -1 }')
  }
  const spec = value as Record<string, unknown>
  if (Object.keys(spec).length === 0) throw Error('$sort requires at least one field')
  for (const [field, direction] of Object.entries(spec)) {
    if (direction !== 1 && direction !== -1) {
      throw Error(`unsupported sort direction for field ${field}: ${String(direction)} (only 1 and -1 are supported)`)
    }
  }
  return spec as Record<string, 1 | -1>
}

function assertCount (stage: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw Error(`${stage} requires a non-negative whole number; but got: ${String(value)}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/**
 * Returns a copy of `doc` with `value` written at a dotted path.
 *
 * Copy-on-write along the path, rather than an in-place write into a
 * `{ ...doc }` shallow copy: a shallow copy still SHARES its nested objects, so
 * `$unwind` emitting several documents from one source would have written each
 * element into the same nested object and every emitted document would have
 * ended up holding the last one.
 */
function setPathImmutable (doc: Document, field: string, value: unknown): Document {
  const segments = field.split('.')
  const root: Document = { ...doc }
  let node = root
  for (const segment of segments.slice(0, -1)) {
    const existing = ownField(node, segment)
    const child: Document = (existing === null || typeof existing !== 'object' || Array.isArray(existing) || existing instanceof Date)
      ? {}
      : { ...(existing as Document) }
    setField(node, segment, child)
    node = child
  }
  setField(node, segments[segments.length - 1]!, value)
  return root
}

/**
 * Returns a copy of `doc` with the field at a dotted path REMOVED - what
 * `$addFields`/`$set` do when the expression evaluates to missing (`$$REMOVE`,
 * or a path that resolves to nothing), which the server treats as removal
 * rather than as "leave the old value alone" (measured; the old behaviour here
 * kept it). Copy-on-write like setPathImmutable, and for the same reason.
 */
function deletePathImmutable (doc: Document, field: string): Document {
  const segments = field.split('.')
  const root: Document = { ...doc }
  let node = root
  for (const segment of segments.slice(0, -1)) {
    const existing = ownField(node, segment)
    // A missing or non-document parent means there is nothing to remove.
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing) || existing instanceof Date) {
      return root
    }
    const child: Document = { ...(existing as Document) }
    setField(node, segment, child)
    node = child
  }
  delete node[segments[segments.length - 1]!]
  return root
}

/** Writes `value` at a dotted path of a document nothing else holds a reference to. */
function setPath (doc: Document, field: string, value: unknown): void {
  const segments = field.split('.')
  let node = doc
  for (const segment of segments.slice(0, -1)) {
    const existing = ownField(node, segment)
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      const child: Document = {}
      setField(node, segment, child)
      node = child
    } else {
      node = existing as Document
    }
  }
  setField(node, segments[segments.length - 1]!, value)
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

interface Accumulator {
  step: (doc: Document) => void
  value: () => unknown
}

type AccumulatorFactory = () => Accumulator

const ACCUMULATORS = [
  '$sum', '$avg', '$min', '$max', '$first', '$last', '$push', '$addToSet', '$count',
  '$stdDevPop', '$stdDevSamp', '$mergeObjects',
  '$firstN', '$lastN', '$maxN', '$minN', '$top', '$topN', '$bottom', '$bottomN'
]

/** The N-family accumulators, which all take `{ n, input }`. */
const N_ACCUMULATORS = new Set(['$firstN', '$lastN', '$maxN', '$minN'])

/** The positional accumulators, which all take `{ sortBy, output }` and sometimes `n`. */
const POSITION_ACCUMULATORS = new Set(['$top', '$topN', '$bottom', '$bottomN'])

/**
 * The `{ n, input }` an N-family accumulator takes.
 *
 * `n` is evaluated ONCE, against an empty document, so it must be a constant.
 * MongoDB additionally allows an expression over the group key; that would mean
 * building the accumulator after the key is known, which the factory shape here
 * does not do - and a `n` naming a field raises rather than answering.
 */
function nSpec (name: string, argument: unknown): { n: number, input: unknown } {
  if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) {
    throw Error(`${name} requires a document with 'n' and 'input'`)
  }
  const { n, input, ...rest } = argument as Document
  const unknown = Object.keys(rest)[0]
  if (unknown !== undefined) throw Error(`unrecognized option to ${name}: ${unknown}`)
  if (input === undefined) throw Error(`${name} requires 'input'`)
  return { n: assertPositiveN(name, evaluateExpression(n, {})), input }
}

/** The `{ sortBy, output, n? }` a `$top`/`$bottom` accumulator takes. */
function positionSpec (name: string, argument: unknown): { n: number, sortBy: Array<[string, 1 | -1]>, output: unknown } {
  if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) {
    throw Error(`${name} requires a document with 'sortBy' and 'output'`)
  }
  const { n, sortBy, output, ...rest } = argument as Document
  const unknown = Object.keys(rest)[0]
  if (unknown !== undefined) throw Error(`unrecognized option to ${name}: ${unknown}`)
  if (output === undefined) throw Error(`${name} requires 'output'`)
  const single = name === '$top' || name === '$bottom'
  if (single && n !== undefined) throw Error(`${name} does not take an 'n'; use ${name}N`)
  return {
    n: single ? 1 : assertPositiveN(name, evaluateExpression(n, {})),
    sortBy: Object.entries(assertSortSpec(sortBy)) as Array<[string, 1 | -1]>,
    output
  }
}

/** Orders documents by a `$sort`-shaped specification, in BSON order. */
function bySortSpec (sortBy: Array<[string, 1 | -1]>, strict: boolean): (a: Document, b: Document) => number {
  return (a, b) => {
    for (const [field, direction] of sortBy) {
      const comparison = compareBson(pathValue(a, field, strict), pathValue(b, field, strict))
      if (comparison !== 0) return direction === 1 ? comparison : -comparison
    }
    return 0
  }
}

/**
 * `$stdDevPop` / `$stdDevSamp`, by Welford's method.
 *
 * Non-numeric and missing values are ignored, as they are for `$sum` and
 * `$avg`. The population form of a single value is 0; the sample form needs
 * two, and is null below that - both verified against the server.
 */
function standardDeviation (argument: unknown, strict: boolean, sample: boolean): AccumulatorFactory {
  return () => {
    let count = 0
    let mean = 0
    let sumOfSquares = 0
    return {
      step: doc => {
        const value = evaluateExpression(argument, doc, strict)
        if (typeof value !== 'number' || !Number.isFinite(value)) return
        count++
        const delta = value - mean
        mean += delta / count
        sumOfSquares += delta * (value - mean)
      },
      value: () => {
        if (count === 0 || (sample && count < 2)) return null
        return Math.sqrt(sumOfSquares / (sample ? count - 1 : count))
      }
    }
  }
}

function accumulatorFor (field: string, spec: unknown, strict: boolean): AccumulatorFactory {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw Error(`the value of the '${field}' field in $group must be an accumulator, e.g. { $sum: 1 }`)
  }
  const entries = Object.entries(spec as Document)
  if (entries.length !== 1 || !entries[0]![0].startsWith('$')) {
    throw Error(`the value of the '${field}' field in $group must be an accumulator, e.g. { $sum: 1 }`)
  }
  const [name, argument] = entries[0]!
  if (!ACCUMULATORS.includes(name)) {
    throw Error(`unsupported accumulator: ${name} (supported: ${ACCUMULATORS.join(', ')})`)
  }

  if (N_ACCUMULATORS.has(name)) {
    const { n, input } = nSpec(name, argument)
    return () => {
      const values: unknown[] = []
      return {
        step: doc => {
          const value = evaluateExpression(input, doc, strict)
          // $maxN/$minN SKIP null and missing; $firstN/$lastN count a missing
          // field as null and keep it. Verified against the server.
          if ((name === '$maxN' || name === '$minN') && (value === undefined || value === null)) return
          values.push(value ?? null)
          // $firstN never needs more than n, and $lastN never needs the ones
          // that have already fallen off the end.
          if (name === '$firstN' && values.length > n) values.pop()
          if (name === '$lastN' && values.length > n) values.shift()
        },
        value: () => {
          if (name === '$firstN' || name === '$lastN') return values
          const ordered = values.toSorted(name === '$maxN' ? (a, b) => compareBson(b, a) : compareBson)
          return ordered.slice(0, n)
        }
      }
    }
  }

  if (POSITION_ACCUMULATORS.has(name)) {
    const { n, sortBy, output } = positionSpec(name, argument)
    const compare = bySortSpec(sortBy, strict)
    const fromTop = name === '$top' || name === '$topN'
    return () => {
      // (sort key, output) pairs rather than whole documents: the output
      // expression is evaluated as each document goes past, so nothing has to
      // hold on to the source documents once the group has been read.
      const rows: Array<{ keys: Document, value: unknown }> = []
      return {
        step: doc => {
          const keys: Document = {}
          for (const [sortField] of sortBy) setPath(keys, sortField, pathValue(doc, sortField, strict))
          rows.push({ keys, value: evaluateExpression(output, doc, strict) ?? null })
        },
        value: () => {
          // A stable sort, so documents with equal keys keep the order they
          // arrived in - which is what makes $top deterministic here.
          const ordered = rows.toSorted((a, b) => compare(a.keys, b.keys))
          const taken = fromTop ? ordered.slice(0, n) : ordered.slice(Math.max(ordered.length - n, 0))
          const values = taken.map(row => row.value)
          return name === '$top' || name === '$bottom' ? (values[0] ?? null) : values
        }
      }
    }
  }

  switch (name) {
    case '$count':
      return () => {
        let count = 0
        return { step: () => { count++ }, value: () => count }
      }
    case '$stdDevPop':
      return standardDeviation(argument, strict, false)
    case '$stdDevSamp':
      return standardDeviation(argument, strict, true)
    case '$mergeObjects':
      return () => {
        const merged: Document = {}
        return {
          step: doc => {
            const value = evaluateExpression(argument, doc, strict)
            if (value === undefined || value === null) return
            if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
              throw Error('$mergeObjects only supports objects')
            }
            Object.assign(merged, value)
          },
          value: () => merged
        }
      }
    case '$sum':
      return () => {
        let total = 0
        // Non-numeric values are ignored, as MongoDB ignores them, so
        // { $sum: '$qty' } over documents missing `qty` is 0 rather than NaN.
        return {
          step: doc => { const v = evaluateExpression(argument, doc, strict); if (typeof v === 'number') total += v },
          value: () => total
        }
      }
    case '$avg':
      return () => {
        let total = 0
        let count = 0
        return {
          step: doc => { const v = evaluateExpression(argument, doc, strict); if (typeof v === 'number') { total += v; count++ } },
          value: () => count === 0 ? null : total / count
        }
      }
    case '$min':
    case '$max':
      return () => {
        let best: unknown
        let seen = false
        const wanted = name === '$min' ? -1 : 1
        return {
          step: doc => {
            const v = evaluateExpression(argument, doc, strict)
            if (v === undefined) return // a missing field is skipped, not compared
            if (!seen || Math.sign(compareBson(v, best)) === wanted) { best = v; seen = true }
          },
          value: () => seen ? best : null
        }
      }
    case '$first':
    case '$last':
      return () => {
        let held: unknown
        let seen = false
        return {
          step: doc => {
            if (name === '$first' && seen) return
            held = evaluateExpression(argument, doc, strict)
            seen = true
          },
          value: () => seen && held !== undefined ? held : null
        }
      }
    case '$push':
      return () => {
        const values: unknown[] = []
        return {
          step: doc => { const v = evaluateExpression(argument, doc, strict); if (v !== undefined) values.push(v) },
          value: () => values
        }
      }
    default: { // $addToSet
      return () => {
        const values: unknown[] = []
        return {
          step: doc => {
            const v = evaluateExpression(argument, doc, strict)
            if (v === undefined || values.some(existing => equalsBson(existing, v))) return
            values.push(v)
          },
          value: () => values
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** One compiled JS stage: documents in, documents out. */
type Stage = (input: AsyncIterable<Document>) => AsyncIterable<Document>

/**
 * Runs a filter over a batch of documents that are no longer rows in the
 * collection - what a `$match` AFTER a `$group` needs. Supplied by the caller
 * (see Collection.matchBatch) rather than implemented here.
 */
export type BatchMatcher = (filter: Document, docs: Document[]) => Document[]

/**
 * Runs a pipeline against another collection and returns every result - what
 * `$lookup` joins against. Supplied by the caller (Collection.aggregate)
 * because this module has no way to reach a sibling collection. It is a whole
 * PIPELINE, not a filter: the classic `$lookup` sends `[{ $match: ... }]`
 * (which the pushdown compiles to exactly the `find()` it always was), and the
 * `let`+`pipeline` form sends its substituted sub-pipeline, so one hook - and
 * one execution path, `aggregate()` itself - serves both.
 */
export type ForeignReader = (collection: string, pipeline: Document[]) => Promise<Document[]>

/**
 * Compiles the stages that did not get pushed into SQL.
 *
 * `$project`, `$addFields`, `$unwind`, `$skip` and `$limit` stream: they yield
 * each document as they see it, so a pipeline that only reshapes rows never
 * holds the whole result in memory. `$group`, `$sort`, `$count` and a
 * mid-pipeline `$match` are blocking and materialise, as they do on the server.
 */
export function compileStages (
  stages: Document[], matchBatch: BatchMatcher, readForeign: ForeignReader, strict = false
): Stage[] {
  return stages.map(stage => {
    const [name, value] = stageEntry(stage)
    switch (name) {
      case '$match': {
        // Deliberately NOT a JavaScript re-implementation of the filter
        // language. A second matcher would be a second set of semantics to
        // keep in step with the SQL one, and the whole value of this library
        // is that there is exactly one. The batch goes back through SQLite.
        const filter = value as Document
        return async function * (input) {
          const docs: Document[] = []
          for await (const doc of input) docs.push(doc)
          yield * matchBatch(filter, docs)
        }
      }
      case '$limit': {
        const count = assertCount('$limit', value)
        return async function * (input) {
          if (count === 0) return
          let seen = 0
          for await (const doc of input) {
            yield doc
            if (++seen >= count) return
          }
        }
      }
      case '$skip': {
        const count = assertCount('$skip', value)
        return async function * (input) {
          let seen = 0
          for await (const doc of input) {
            if (seen++ < count) continue
            yield doc
          }
        }
      }
      case '$count': {
        if (typeof value !== 'string' || value === '') throw Error('$count requires a non-empty output field name')
        if (value.includes('.') || value.startsWith('$')) throw Error(`$count field name must not contain '.' or start with '$': ${value}`)
        return async function * (input) {
          let count = 0
          for await (const _doc of input) count++
          // MongoDB emits nothing at all when the input is empty.
          if (count > 0) yield { [value]: count }
        }
      }
      case '$sort': {
        const spec = Object.entries(assertSortSpec(value) as Record<string, 1 | -1>)
        return async function * (input) {
          const docs: Document[] = []
          for await (const doc of input) docs.push(doc)
          // Checked BEFORE sorting, not inside the comparator: Array.prototype
          // .sort never calls the comparator for a zero- or one-element list,
          // so a $group that produced a single row slipped straight past it.
          if (strict) {
            for (const [field] of spec) {
              if (!docs.some(doc => Array.isArray(pathValue(doc, field, strict)))) continue
              // The same divergence Collection.assertSortable rejects for a
              // sort that runs in SQL - a $group can put an array here too.
              throw Error(
                `strict: cannot sort by '${field}' - some documents hold an ARRAY there, and MongoDB would ` +
                'order those by their smallest (ascending) or largest (descending) element, which this library does not'
              )
            }
          }
          docs.sort((a, b) => {
            for (const [field, direction] of spec) {
              const comparison = compareBson(pathValue(a, field, strict), pathValue(b, field, strict))
              if (comparison !== 0) return direction === 1 ? comparison : -comparison
            }
            return 0
          })
          yield * docs
        }
      }
      case '$sortByCount': {
        // Exactly `$group` by the expression plus `$sort` by the count,
        // descending - which is how the manual defines it, so it is composed
        // from the two stages rather than reimplemented. MongoDB does not
        // specify the order of groups with EQUAL counts; this one keeps the
        // order they were first seen in.
        const group = compileGroup({ _id: value, count: { $sum: 1 } }, strict)
        return async function * (input) {
          const docs: Document[] = []
          for await (const doc of group(input)) docs.push(doc)
          yield * docs.toSorted((a, b) => compareBson(b.count, a.count))
        }
      }
      case '$unset':
        return compileUnset(value, strict)
      case '$lookup':
        return compileLookup(value, readForeign, strict)
      case '$unwind':
        return compileUnwind(value, strict)
      case '$group':
        return compileGroup(value, strict)
      default: // $project, $addFields, $set
        return compileProject(name, value, strict)
    }
  })
}

/** `$unset` - the alias of a `$project` exclusion, and compiled as one. */
function compileUnset (value: unknown, strict: boolean): Stage {
  const fields = typeof value === 'string' ? [value] : value
  if (!Array.isArray(fields) || fields.length === 0) {
    throw Error('$unset requires a field name or a non-empty array of field names')
  }
  const spec: Document = {}
  for (const unset of fields) {
    if (typeof unset !== 'string' || unset === '') throw Error('$unset field names must be non-empty strings')
    spec[unset] = 0
  }
  return compileProject('$project', spec, strict)
}

/**
 * The stages MongoDB allows in an UPDATE pipeline that this library implements.
 * `$replaceRoot`/`$replaceWith` are the two it allows and this library does
 * not; they are refused as unimplemented rather than as illegal.
 */
const UPDATE_PIPELINE_STAGES = ['$set', '$addFields', '$unset', '$project']
const UPDATE_PIPELINE_UNIMPLEMENTED = new Set(['$replaceRoot', '$replaceWith'])

/** One update-pipeline stage: the shape check, then MongoDB's own allow-list. */
function updateStageEntry (stage: unknown): [string, unknown] {
  const [name, value] = singleStageEntry(stage)
  if (UPDATE_PIPELINE_STAGES.includes(name)) return [name, value]
  if (UPDATE_PIPELINE_UNIMPLEMENTED.has(name)) {
    throw Error(`unsupported update pipeline stage: ${name} (supported: ${UPDATE_PIPELINE_STAGES.join(', ')})`)
  }
  // The server's own message: a $match or $group in an update is ILLEGAL, not
  // unimplemented, and the distinction matters to whoever reads the error.
  throw Error(name.startsWith('$')
    ? `${name} is not allowed to be used within an update`
    : `a pipeline stage name must start with '$'; but got: ${name}`)
}

/**
 * Compiles an aggregation-pipeline UPDATE - `updateOne(filter, [{ $set: ... }])` -
 * into a function from one document to its replacement (BACKLOG item 28).
 *
 * The stages are the SAME compiled stages `aggregate()` runs (`compileProject`,
 * `compileUnset`), fed a one-document stream per row, rather than a second
 * evaluator - the `$expr` precedent: expression semantics exist ONCE, in
 * JavaScript, and a SQL compilation of them would be a second implementation to
 * keep in step. The consequence is the same as `$expr`'s too: the update runs
 * per document in JS, so the caller reads the matched rows and writes the
 * results back (see Collection, which keeps that to one statement each way).
 *
 * Every allowed stage maps one input document to exactly one output document,
 * which is what makes "run the pipeline over a singleton" total: `$match` (the
 * one allowed stage that could drop a document) is not legal in an update.
 */
export function compileUpdatePipeline (pipeline: Document[], strict = false): (doc: Document) => Promise<Document> {
  // The server's rule, and its message: an EMPTY pipeline is refused exactly
  // like an empty update document, not treated as a matching no-op (measured).
  if (pipeline.length === 0) throw Error('update document must contain atomic operators (e.g. [{ $set: { ... } }])')
  const stages = pipeline.map(stage => {
    const [name, value] = updateStageEntry(stage)
    return name === '$unset' ? compileUnset(value, strict) : compileProject(name, value, strict)
  })

  return async doc => {
    let stream: AsyncIterable<Document> = (async function * () { yield doc })()
    for (const stage of stages) stream = stage(stream)
    let result: Document = doc
    for await (const output of stream) result = output
    return result
  }
}

/**
 * `$lookup` - a left outer join against another collection.
 *
 * Only the `localField`/`foreignField` form is implemented; the `let` +
 * `pipeline` form is a different feature and is rejected by name rather than
 * silently ignored.
 *
 * **Batched, not per-document.** The obvious implementation runs one query per
 * input document, which turns a 1000-document pipeline into 1000 statements.
 * This collects every local key first, fetches the matching foreign documents
 * in ONE `$in` query, and indexes them in memory - so the stage costs one query
 * regardless of input size. That is why it materialises its input: it cannot
 * build the key set without seeing all of it, exactly like `$group`.
 *
 * MongoDB's matching rule here is array-aware on BOTH sides: a local ARRAY
 * matches a foreign document whose `foreignField` equals ANY of its elements,
 * and a foreign array matches likewise. Keys are compared by the storage
 * encoding, so a Date matches a Date rather than a look-alike string.
 */
function compileLookup (value: unknown, readForeign: ForeignReader, strict: boolean): Stage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('$lookup requires a document')
  }
  const { from, localField, foreignField, as: asField, let: letSpec, pipeline, ...rest } = value as Record<string, unknown>
  const unknown = Object.keys(rest)[0]
  if (unknown !== undefined) throw Error(`unrecognized option to $lookup: ${unknown}`)
  for (const [name, option] of [['from', from], ['as', asField]]) {
    if (typeof option !== 'string' || option === '') {
      throw Error(`$lookup requires a non-empty string for '${String(name)}'`)
    }
  }

  if (pipeline !== undefined || letSpec !== undefined) {
    if (localField !== undefined || foreignField !== undefined) {
      // MongoDB 4.4+ combines the equality match WITH a pipeline; its
      // array-vs-$eq matching rules are their own project, so the combination
      // is refused as unimplemented rather than approximated.
      throw Error(
        'the combined localField/foreignField + pipeline form of $lookup is not implemented ' +
        '(spell the equality inside the pipeline with $match + $expr)'
      )
    }
    return compilePipelineLookup(from as string, asField as string, letSpec, pipeline, readForeign, strict)
  }

  for (const [name, option] of [['localField', localField], ['foreignField', foreignField]]) {
    if (typeof option !== 'string' || option === '') {
      throw Error(`$lookup requires a non-empty string for '${String(name)}'`)
    }
  }

  const local = localField as string
  const foreign = foreignField as string
  const target = asField as string

  return async function * (input) {
    const docs: Document[] = []
    for await (const doc of input) docs.push(doc)
    if (docs.length === 0) return

    // One key per distinct local value, arrays flattened one level - which is
    // what makes `{ skus: ['a','b'] }` join to both 'a' and 'b'.
    const keys: unknown[] = []
    const seen = new Set<string>()
    for (const doc of docs) {
      const localValue = pathValue(doc, local, strict)
      for (const key of Array.isArray(localValue) ? localValue : [localValue]) {
        const encoded = groupKey(key)
        if (seen.has(encoded)) continue
        seen.add(encoded)
        keys.push(key)
      }
    }

    // $in over the foreign field. It follows the implicit-array rule already,
    // so a foreign document whose field is an ARRAY containing the key matches.
    // As a leading $match it compiles to exactly the find() it always was.
    const matches = await readForeign(from as string, [{ $match: { [foreign]: { $in: keys } } }])

    const byKey = new Map<string, Document[]>()
    for (const match of matches) {
      const foreignValue = pathValue(match, foreign)
      for (const key of Array.isArray(foreignValue) ? foreignValue : [foreignValue]) {
        const encoded = groupKey(key)
        const bucket = byKey.get(encoded)
        if (bucket === undefined) byKey.set(encoded, [match])
        else bucket.push(match)
      }
    }

    for (const doc of docs) {
      const localValue = pathValue(doc, local, strict)
      const joined: Document[] = []
      const added = new Set<Document>()
      for (const key of Array.isArray(localValue) ? localValue : [localValue]) {
        for (const match of byKey.get(groupKey(key)) ?? []) {
          // A local array whose elements hit the same foreign document must
          // not include it twice.
          if (added.has(match)) continue
          added.add(match)
          joined.push(match)
        }
      }
      // Always an array, empty when nothing matched - $lookup is a LEFT join.
      yield setPathImmutable(doc, target, joined)
    }
  }
}

/**
 * `$lookup`'s `let` + `pipeline` form - the correlated subquery (BACKLOG
 * item 16, priority 1 after pipeline updates).
 *
 * Per input document: evaluate the `let` expressions, SUBSTITUTE every
 * `$$variable` reference in the sub-pipeline with its value as a `$literal`
 * (`substituteVariables` in src/expression.ts, which owns the scoping rules),
 * and run the now-variable-free pipeline as an ordinary aggregation on the
 * foreign collection. That is the whole design: the sub-pipeline gets
 * `aggregate()`'s own machinery - the `$match` pushdown (so a correlated
 * equality is INDEX-eligible on the foreign table), `$expr` through
 * `mdb_expr`, nested `$lookup`s - rather than a second execution path.
 *
 * The correlation makes this per-document work, so identical executions are
 * MEMOIZED on the variable VALUES (the only thing that varies): an
 * uncorrelated pipeline costs ONE foreign query however many input documents,
 * and repeated keys are deduplicated. Two escapes keep the memo honest: a
 * pipeline containing `$rand`/`$sampleRate` is never memoized (two executions
 * legitimately differ), and a variable value the storage encoder cannot render
 * (a `$literal` RegExp) skips the cache rather than failing the key.
 */
function compilePipelineLookup (
  from: string, target: string, letSpec: unknown, pipeline: unknown,
  readForeign: ForeignReader, strict: boolean
): Stage {
  if (letSpec !== undefined && (letSpec === null || typeof letSpec !== 'object' || Array.isArray(letSpec))) {
    throw Error('the let option to $lookup must be a document of { name: <expression> }')
  }
  if (!Array.isArray(pipeline)) {
    throw Error("the pipeline form of $lookup requires 'pipeline' to be an array of stages")
  }
  splitPipeline(pipeline) // surfaces a malformed sub-pipeline eagerly, as aggregate() itself would
  const letEntries = Object.entries((letSpec ?? {}) as Document)
  for (const [name] of letEntries) {
    if (name === '' || name.startsWith('$')) throw Error(`invalid $lookup let variable name: '${name}'`)
  }
  const cacheable = !/"\$(?:rand|sampleRate)"/.test(JSON.stringify(pipeline))

  return async function * (input) {
    const cache = new Map<string, Document[]>()
    for await (const doc of input) {
      const vars: Record<string, unknown> = Object.create(null)
      for (const [name, expression] of letEntries) vars[name] = evaluateExpression(expression, doc, strict)
      const substituted = pipeline.map(stage => substituteStageVariables(stage, vars))
      const key = cacheable ? varsKey(vars) : null
      let joined = key === null ? undefined : cache.get(key)
      if (joined === undefined) {
        joined = await readForeign(from, substituted)
        if (key !== null) cache.set(key, joined)
      }
      yield setPathImmutable(doc, target, joined)
    }
  }
}

/**
 * The memo key for one sub-pipeline execution: the variable VALUES, which are
 * the only thing substitution lets vary between input documents. Through the
 * storage encoder so a Date keys as its wrapper rather than colliding with the
 * string that looks like it - the `groupKey` reasoning.
 */
function varsKey (vars: Record<string, unknown>): string | null {
  try {
    return JSON.stringify(encodeValue(vars)) ?? 'missing'
  } catch {
    // A value the storage encoder cannot render. Correctness costs a query.
    return null
  }
}

/**
 * One sub-pipeline stage with the outer `let` variables substituted in - the
 * stage-shaped half of `substituteVariables`, here because it has to know
 * WHERE expressions live in each stage. The `$match` rule is the load-bearing
 * one: a `$match` is QUERY syntax, where `'$$var'` is a literal string except
 * inside `$expr` - substituting elsewhere would rewrite values the server
 * compares verbatim.
 */
function substituteStageVariables (stage: Document, vars: Record<string, unknown>): Document {
  const [name, value] = singleStageEntry(stage)
  switch (name) {
    case '$match':
      return { $match: substituteMatchVariables(value, vars) as Document }
    case '$project':
    case '$addFields':
    case '$set':
    case '$group':
    case '$sortByCount':
      return { [name]: substituteVariables(value, vars) }
    case '$lookup': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return stage
      const spec = { ...(value as Document) }
      // An inner `let` VALUE evaluates in the outer scope; the inner PIPELINE
      // sees the outer variables minus the ones the inner `let` shadows. The
      // still-unresolved inner references substitute when THIS lookup runs,
      // one level down - the recursion is the ordinary aggregate() one.
      if (spec.let !== null && typeof spec.let === 'object' && !Array.isArray(spec.let)) {
        spec.let = substituteVariables(spec.let, vars)
      }
      if (Array.isArray(spec.pipeline)) {
        const remaining: Record<string, unknown> = Object.create(null)
        const shadowed = spec.let !== null && typeof spec.let === 'object' ? Object.keys(spec.let as Document) : []
        for (const [outer, outerValue] of Object.entries(vars)) {
          if (!shadowed.includes(outer)) remaining[outer] = outerValue
        }
        spec.pipeline = (spec.pipeline as Document[]).map(inner => substituteStageVariables(inner, remaining))
      }
      return { $lookup: spec }
    }
    default:
      // $sort, $limit, $skip, $count, $unwind, $unset: no expression positions.
      return stage
  }
}

/** A `$match`'s filter document: only `$expr` holds expressions; `$and`/`$or`/`$nor` recurse. */
function substituteMatchVariables (filter: unknown, vars: Record<string, unknown>): unknown {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) return filter
  const result: Document = {}
  for (const [key, value] of Object.entries(filter as Document)) {
    if (key === '$expr') {
      setField(result, key, substituteVariables(value, vars))
    } else if ((key === '$and' || key === '$or' || key === '$nor') && Array.isArray(value)) {
      setField(result, key, value.map(term => substituteMatchVariables(term, vars)))
    } else {
      setField(result, key, value)
    }
  }
  return result
}

function compileUnwind (value: unknown, strict: boolean): Stage {
  const spec = typeof value === 'string' ? { path: value } : value
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw Error("$unwind requires a field path string or a document with a 'path'")
  }
  const { path, preserveNullAndEmptyArrays, includeArrayIndex, ...rest } = spec as Record<string, unknown>
  const unknown = Object.keys(rest)[0]
  if (unknown !== undefined) throw Error(`unrecognized option to $unwind: ${unknown}`)
  if (typeof path !== 'string' || !path.startsWith('$') || path === '$') {
    throw Error(`the path option to $unwind must be a field path starting with '$'; but got: ${String(path)}`)
  }
  if (includeArrayIndex !== undefined && (typeof includeArrayIndex !== 'string' || includeArrayIndex === '')) {
    throw Error('the includeArrayIndex option to $unwind must be a non-empty string')
  }
  const field = path.slice(1)
  const preserve = preserveNullAndEmptyArrays === true
  const indexField = includeArrayIndex as string | undefined

  return async function * (input) {
    for await (const doc of input) {
      const unwound = pathValue(doc, field, strict)
      if (Array.isArray(unwound)) {
        // An empty array contributes NOTHING unless asked to be preserved -
        // the one case where $unwind drops a document outright.
        if (unwound.length === 0 && preserve) yield withUnwound(doc, field, undefined, indexField, null)
        for (let index = 0; index < unwound.length; index++) {
          yield withUnwound(doc, field, unwound[index], indexField, index)
        }
        continue
      }
      // A non-array is treated as a one-element array; missing and null are
      // dropped unless preserved.
      if (unwound === undefined || unwound === null) {
        if (preserve) yield withUnwound(doc, field, unwound, indexField, null)
        continue
      }
      yield withUnwound(doc, field, unwound, indexField, null)
    }
  }
}

function withUnwound (doc: Document, field: string, value: unknown, indexField: string | undefined, index: number | null): Document {
  let result = setPathImmutable(doc, field, value)
  if (value === undefined) deletePath(result, field)
  if (indexField !== undefined) result = setPathImmutable(result, indexField, index)
  return result
}

/** Removes a dotted path. Only ever called on a document just copied by setPathImmutable. */
function deletePath (doc: Document, field: string): void {
  const segments = field.split('.')
  let node: any = doc
  for (const segment of segments.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return
    node = node[segment]
  }
  if (node !== null && typeof node === 'object') delete node[segments[segments.length - 1]!]
}

function compileGroup (value: unknown, strict: boolean): Stage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('$group requires a document with an _id')
  }
  const spec = value as Document
  if (!('_id' in spec)) throw Error("a $group specification must include an '_id'")
  const idExpression = spec._id
  const accumulators = Object.entries(spec)
    .filter(([field]) => field !== '_id')
    .map(([field, accumulator]) => [field, accumulatorFor(field, accumulator, strict)] as const)

  return async function * (input) {
    // Insertion-ordered, so groups come out in the order they were first seen.
    // MongoDB does NOT specify $group's output order - callers who care must
    // add a $sort, and the specs here do.
    const groups = new Map<string, { id: unknown, accumulators: Array<[string, Accumulator]> }>()
    for await (const doc of input) {
      const id = evaluateExpression(idExpression, doc, strict) ?? null
      const key = groupKey(id)
      let group = groups.get(key)
      if (group === undefined) {
        group = { id, accumulators: accumulators.map(([field, factory]) => [field, factory()] as [string, Accumulator]) }
        groups.set(key, group)
      }
      for (const [, accumulator] of group.accumulators) accumulator.step(doc)
    }
    for (const group of groups.values()) {
      const result: Document = { _id: group.id }
      for (const [field, accumulator] of group.accumulators) setPath(result, field, accumulator.value())
      yield result
    }
  }
}

/**
 * A group's identity as a string.
 *
 * Runs through the storage encoder first so a Date becomes its wrapper rather
 * than a value JSON.stringify would render the same as a plain string - two
 * documents grouped by a Date field must land in one group, and a Date must
 * not collide with the ISO string that looks like it.
 */
function groupKey (id: unknown): string {
  return JSON.stringify(encodeValue(id) ?? null)
}

function compileProject (stage: string, value: unknown, strict: boolean): Stage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(`${stage} requires a document`)
  }
  const spec = value as Document
  if (Object.keys(spec).length === 0) throw Error(`${stage} requires at least one field`)

  if (stage !== '$project') {
    // $addFields / $set: every value is an expression. One that evaluates to
    // missing REMOVES the field - that is what makes `$$REMOVE` (and a path
    // that resolves to nothing) drop an existing value, per the server.
    const fields = Object.entries(spec)
    return async function * (input) {
      for await (const doc of input) {
        let result: Document = { ...doc }
        for (const [field, expression] of fields) {
          const evaluated = evaluateExpression(expression, doc, strict)
          result = evaluated === undefined
            ? deletePathImmutable(result, field)
            : setPathImmutable(result, field, evaluated)
        }
        yield result
      }
    }
  }

  // $project mixes three things: inclusions, exclusions and computed fields.
  // The first two are exactly find()'s projection and are handed to the same
  // compiler; computed fields are overlaid on its result.
  const inclusions: ProjectionSpec = {}
  const exclusions: string[] = []
  const computed: Array<[string, unknown]> = []
  let keepId = true
  let idExplicit = false
  for (const [field, entry] of Object.entries(spec)) {
    if (typeof entry !== 'number' && typeof entry !== 'boolean') {
      computed.push([field, entry])
    } else if (field === '_id') {
      keepId = Boolean(entry)
      idExplicit = true
    } else if (entry) {
      setField(inclusions, field, 1)
    } else {
      exclusions.push(field)
    }
  }

  // A computed field is an INCLUSION - `{ $project: { who: '$cust', _id: 0 } }`
  // yields just `who`, so it cannot be routed through the exclusion path the
  // lone `_id: 0` would otherwise select.
  const include = Object.keys(inclusions).length > 0 || computed.length > 0
  if (include && exclusions.length > 0) {
    throw Error('Cannot do inclusion and exclusion in the same projection (except for _id)')
  }

  let project: (doc: any) => any
  if (!include) {
    const excludeSpec: ProjectionSpec = {}
    for (const field of exclusions) setField(excludeSpec, field, 0)
    if (idExplicit) excludeSpec._id = keepId ? 1 : 0
    // An aggregation $project never carries the $-operators (it has expressions
    // instead), so this compiled projection never has probes to resolve.
    project = Object.keys(excludeSpec).length === 0 ? (doc: any) => doc : compileProjection(excludeSpec).project
  } else if (Object.keys(inclusions).length === 0) {
    // Nothing to include but the computed fields: the base document is `_id`
    // alone, which no include/exclude spec can express.
    project = keepId
      ? (doc: any) => ('_id' in doc ? { _id: doc._id } : {})
      : () => ({})
  } else {
    project = compileProjection({ ...inclusions, _id: keepId ? 1 : 0 }).project
  }

  return async function * (input) {
    for await (const doc of input) {
      let result = project(doc)
      for (const [field, expression] of computed) {
        const evaluated = evaluateExpression(expression, doc, strict)
        if (evaluated !== undefined) result = setPathImmutable(result, field, evaluated)
      }
      yield result
    }
  }
}
