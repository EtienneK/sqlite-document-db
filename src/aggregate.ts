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
import type { Document, SortSpecification } from './types.js'
import { compileProjection, type ProjectionSpec } from './projection.js'

/** The stages this library implements. Anything else is rejected by name. */
const SUPPORTED_STAGES = [
  '$match', '$sort', '$limit', '$skip', '$count', '$group', '$project', '$unwind', '$addFields',
  '$set', '$lookup'
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
  if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
    throw Error(`each pipeline stage must be a document; but got: ${stage === null ? 'null' : typeof stage}`)
  }
  const entries = Object.entries(stage)
  if (entries.length !== 1) {
    throw Error(`each pipeline stage must contain exactly one operator; but got ${entries.length}: ${JSON.stringify(Object.keys(stage))}`)
  }
  const [name, value] = entries[0]!
  if (!SUPPORTED_STAGES.includes(name)) {
    throw Error(name.startsWith('$')
      ? `unsupported aggregation stage: ${name} (supported: ${SUPPORTED_STAGES.join(', ')})`
      : `a pipeline stage name must start with '$'; but got: ${name}`)
  }
  return [name, value]
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
 * Reads a dotted path out of a document.
 *
 * Known divergence: MongoDB MAPS a path over an array of embedded documents,
 * so `'$instock.qty'` yields an array of quantities; here it yields undefined
 * and the path has to be reached through `$unwind` first. The collection-level
 * sort compiled to SQL does not map either, so at least the two agree - and
 * under `strict` the case raises instead of quietly reading as missing.
 */
function pathValue (doc: Document, path: string, strict = false): unknown {
  let node: any = doc
  for (const segment of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object' || node instanceof Date) return undefined
    if (strict && Array.isArray(node)) {
      throw Error(
        `strict: the field path '$${path}' runs through an array, which MongoDB would map over ` +
        'and this library reads as missing - use $unwind first'
      )
    }
    node = node[segment]
  }
  return node
}

/**
 * Evaluates an aggregation expression against one document.
 *
 * The expression language here is deliberately small: a `'$field'` path
 * reference, a literal, `{ $literal: <value> }`, and documents/arrays of
 * those. The arithmetic, string and conditional operators (`$add`, `$concat`,
 * `$cond`, ...) are NOT implemented, and an unknown `$`-key is an error rather
 * than something quietly treated as a field name - the same stance the query
 * compiler takes on unknown operators.
 */
export function evaluateExpression (expression: unknown, doc: Document, strict = false): unknown {
  if (typeof expression === 'string') {
    if (!expression.startsWith('$')) return expression
    if (expression.startsWith('$$')) {
      throw Error(`aggregation variables are not supported: ${expression}`)
    }
    return pathValue(doc, expression.slice(1), strict)
  }

  if (expression === null || typeof expression !== 'object' || expression instanceof Date) return expression
  if (Array.isArray(expression)) return expression.map(element => evaluateExpression(element, doc, strict))

  const entries = Object.entries(expression as Document)
  const operator = entries.find(([key]) => key.startsWith('$'))
  if (operator !== undefined) {
    if (operator[0] === '$literal' && entries.length === 1) return operator[1]
    throw Error(`unsupported aggregation expression operator: ${operator[0]} (only field paths, literals and $literal are supported)`)
  }

  const result: Document = {}
  for (const [key, value] of entries) {
    const evaluated = evaluateExpression(value, doc, strict)
    if (evaluated !== undefined) result[key] = evaluated
  }
  return result
}

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
    const existing = node[segment]
    node[segment] = (existing === null || typeof existing !== 'object' || Array.isArray(existing) || existing instanceof Date)
      ? {}
      : { ...(existing as Document) }
    node = node[segment] as Document
  }
  node[segments[segments.length - 1]!] = value
  return root
}

/** Writes `value` at a dotted path of a document nothing else holds a reference to. */
function setPath (doc: Document, field: string, value: unknown): void {
  const segments = field.split('.')
  let node = doc
  for (const segment of segments.slice(0, -1)) {
    const existing = node[segment]
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) node[segment] = {}
    node = node[segment] as Document
  }
  node[segments[segments.length - 1]!] = value
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

interface Accumulator {
  step: (doc: Document) => void
  value: () => unknown
}

type AccumulatorFactory = () => Accumulator

const ACCUMULATORS = ['$sum', '$avg', '$min', '$max', '$first', '$last', '$push', '$addToSet', '$count']

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

  switch (name) {
    case '$count':
      return () => {
        let count = 0
        return { step: () => { count++ }, value: () => count }
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
 * Reads every document of another collection matching a filter - what
 * `$lookup` joins against. Supplied by the caller (Collection.aggregate)
 * because this module has no way to reach a sibling collection.
 */
export type ForeignReader = (collection: string, filter: Document) => Promise<Document[]>

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
  const { from, localField, foreignField, as: asField, ...rest } = value as Record<string, unknown>
  const unknown = Object.keys(rest)[0]
  if (unknown !== undefined) {
    throw Error(unknown === 'pipeline' || unknown === 'let'
      ? `the ${unknown} form of $lookup is not supported (use localField/foreignField)`
      : `unrecognized option to $lookup: ${unknown}`)
  }
  for (const [name, option] of [['from', from], ['localField', localField], ['foreignField', foreignField], ['as', asField]]) {
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
    const matches = await readForeign(from as string, { [foreign]: { $in: keys } })

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
    // $addFields / $set only ever ADD - every value is an expression.
    const fields = Object.entries(spec)
    return async function * (input) {
      for await (const doc of input) {
        let result: Document = { ...doc }
        for (const [field, expression] of fields) {
          const evaluated = evaluateExpression(expression, doc, strict)
          if (evaluated !== undefined) result = setPathImmutable(result, field, evaluated)
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
      inclusions[field] = 1
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
    for (const field of exclusions) excludeSpec[field] = 0
    if (idExplicit) excludeSpec._id = keepId ? 1 : 0
    project = Object.keys(excludeSpec).length === 0 ? (doc: any) => doc : compileProjection(excludeSpec)
  } else if (Object.keys(inclusions).length === 0) {
    // Nothing to include but the computed fields: the base document is `_id`
    // alone, which no include/exclude spec can express.
    project = keepId
      ? (doc: any) => ('_id' in doc ? { _id: doc._id } : {})
      : () => ({})
  } else {
    project = compileProjection({ ...inclusions, _id: keepId ? 1 : 0 })
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
