/**
 * MongoDB update documents, compiled to a SQL expression computing a row's new
 * `data` value (BACKLOG item 4).
 *
 * Everything here builds ONE expression that the caller drops into a single
 * UPDATE, rather than reading documents into JavaScript, changing them and
 * writing them back. That is what keeps `updateMany` a single statement over
 * an indexed scan instead of N round trips - and it is why the array operators
 * look the way they do: rebuilding an array means a scalar subquery over
 * `json_each`, not a loop.
 *
 * Two rules the operators below all follow:
 *
 * 1. **Every operator reads `data`, the ORIGINAL column, for its own input** -
 *    never the partially-built expression. That is safe only because
 *    `assertNoConflictingPaths` rejects any update whose operators touch the
 *    same path (or a path and its ancestor), so no operator can depend on
 *    another's output. `$inc` has always worked this way.
 * 2. **Anything that can fail is checked BEFORE the UPDATE runs**, as a guard
 *    (see `UpdateGuard`) the caller evaluates in a separate SELECT. A guard
 *    inside the statement is not portable: on Node 22.13 an exception thrown
 *    from a `db.function()` callback is swallowed and the call yields NULL, so
 *    `json_set` wrote null over the value it was meant to protect.
 */

import { compareBson, equalsBson } from './bson-order.js'
import type { Document } from './types.js'
import {
  bindJson, bindRaw, bsonRankSql, bsonValueSql, createBindings, elementCriterionSql,
  toJson1PathString, type QueryFilterDocument, type SqlParams
} from './query.js'

/** The loose shape the compiler works with; the public API narrows to `UpdateFilter`. */
type AnyUpdate = Record<string, any>

/**
 * Every update operator, in the order they are applied to the expression.
 *
 * Order is not load-bearing for correctness (conflicting paths are rejected),
 * but it is fixed so the generated SQL is stable and comparable across runs.
 * `$setOnInsert` contributes no SQL at all - it only shapes the document an
 * upsert INSERTS - but it still takes part in conflict detection.
 */
export const UPDATE_OPERATORS = [
  '$rename', '$inc', '$mul', '$min', '$max', '$unset', '$set', '$setOnInsert',
  '$push', '$addToSet', '$pop', '$pull', '$pullAll'
] as const

/** Operators whose operand is a `{ field: value }` map (all of them, currently). */
const FIELD_MAP_OPERATORS = new Set<string>(UPDATE_OPERATORS)

/**
 * A precondition checked before the UPDATE, in one SELECT over the rows it
 * would touch. `test` is SQL over `data`; `message` is built in JS and never
 * reaches SQL - the statement only ever yields a guard's INDEX.
 */
export interface UpdateGuard {
  test: string
  message: string
}

export interface UpdateExpression {
  /** SQL computing the row's new `data` value. */
  sql: string
  params: SqlParams
  guards: UpdateGuard[]
  /**
   * SQL yielding the INDEX into `guards` of the first precondition this row
   * violates, or NULL when the update can apply. Callers must run it BEFORE
   * the update (see Collection.assertUpdateApplies).
   */
  guardSql?: string
}

/**
 * Rejects field paths an update must never touch.
 *
 * An empty path is the dangerous one: `toJson1PathString([''])` is `'$'`, the
 * document ROOT, so `{ $set: { '': 1 } }` used to replace the whole document
 * with the number 1. `_id` is immutable in MongoDB, and letting `$unset` remove
 * it (or `$inc` overwrite it) leaves an unaddressable document behind.
 */
function assertUpdatableField (operator: string, field: string, allowId = false): void {
  if (field === '') throw Error(`${operator} requires a non-empty field name`)
  if (allowId) return
  if (field === '_id' || field.startsWith('_id.')) {
    throw Error(`Performing an update on the path '${field}' would modify the immutable field '_id'`)
  }
}

/**
 * The `{ field: value }` map an update operator applies, validated.
 *
 * `allowId` is for `$setOnInsert`, whose fields only ever land in a document
 * being created - nothing immutable is being changed there.
 */
function updateOperand (operator: string, value: unknown, allowId = false): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(`Modifiers operate on fields but ${operator} was given type: ${value === null ? 'null' : typeof value}`)
  }
  const entries = Object.entries(value)
  for (const [field] of entries) assertUpdatableField(operator, field, allowId)
  return entries
}

/** The target of a `$rename`, validated. MongoDB rejects a rename onto itself. */
function renameTarget (from: string, to: unknown): string {
  if (typeof to !== 'string') throw Error(`The 'to' field for $rename must be a string: ${from}`)
  assertUpdatableField('$rename', to)
  if (to === from) throw Error(`The source and target field for $rename must differ: ${from}`)
  if (to.startsWith(`${from}.`) || from.startsWith(`${to}.`)) {
    throw Error(`The source and target field for $rename must not be on the same path: ${from}: "${to}"`)
  }
  return to
}

/** Every path an update touches, as (operator, field) pairs in application order. */
function updateTargets (update: AnyUpdate): Array<[string, string]> {
  const targets: Array<[string, string]> = []
  for (const operator of UPDATE_OPERATORS) {
    const operand = update[operator]
    if (operand == null) continue
    for (const [field, value] of updateOperand(operator, operand, operator === '$setOnInsert')) {
      targets.push([operator, field])
      // A rename touches BOTH ends, so both have to take part in conflict
      // detection - $rename: { a: 'b' } clashes with $set: { b: 1 }.
      if (operator === '$rename') targets.push([operator, renameTarget(field, value)])
    }
  }
  return targets
}

/**
 * Rejects an update whose operators target the same path twice, or a path and
 * one of its ancestors - MongoDB's "would create a conflict at" error. Every
 * operator reads the ORIGINAL `data` column, so a conflicting update would
 * otherwise produce a result that silently depends on the order they happen to
 * be applied in.
 */
function assertNoConflictingPaths (update: AnyUpdate): void {
  const seen: string[] = []
  for (const [, field] of updateTargets(update)) {
    const clash = seen.find(other => other === field || field.startsWith(`${other}.`) || other.startsWith(`${field}.`))
    if (clash !== undefined) {
      throw Error(`Updating the path '${field}' would create a conflict at '${clash}'`)
    }
    seen.push(field)
  }
}

/**
 * For a dotted field like 'a.b.c', wraps `expr` in json_insert calls creating
 * '$.a' and '$.a.b' as empty objects when missing - MongoDB creates missing
 * parents on $set/$inc, but SQLite's json_set only creates the leaf.
 * json_insert is a no-op when the path already exists, so present parents
 * (of any type) are left untouched.
 */
function ensureParents (expr: string, field: string): string {
  const segments = field.split('.')
  for (let i = 1; i < segments.length; i++) {
    const parent = segments.slice(0, i).join('.')
    expr = `json_insert(${expr}, ${toJson1PathString([parent])}, json('{}'))`
  }
  return expr
}

/** True for a row whose `field` exists but is not a number - $inc/$mul's error case. */
function nonNumericAt (field: string): string {
  const path = toJson1PathString([field])
  return `(json_type(data, ${path}) IS NOT NULL AND json_type(data, ${path}) NOT IN ('integer','real'))`
}

/** True for a row whose `field` exists but is not an array - the array operators' error case. */
function nonArrayAt (field: string): string {
  const path = toJson1PathString([field])
  return `(json_type(data, ${path}) IS NOT NULL AND json_type(data, ${path}) != 'array')`
}

/**
 * The array stored at `field`, or an EMPTY array when the field is missing, as
 * a JSON-subtyped value the array builders below can feed to `json_each`.
 *
 * The CASE is not decoration: `json_quote(NULL)` is the JSON value `null`, not
 * SQL NULL, so the obvious `COALESCE(json_quote(json_extract(...)), json_array())`
 * never fires its fallback and every array operator saw `null` instead of `[]`.
 */
function arrayAt (field: string): string {
  const path = toJson1PathString([field])
  return `CASE WHEN json_type(data, ${path}) IS NULL THEN json_array() ELSE json_quote(json_extract(data, ${path})) END`
}

/**
 * Restores the JSON type a value loses on its way out of a subquery.
 *
 * Two separate losses, both of which silently corrupted rebuilt arrays:
 *
 * - `json_each.value` carries the JSON subtype that tells `json_group_array` to
 *   embed an object or array as JSON rather than as a string, and that subtype
 *   does NOT survive being selected through a nested SELECT - a rebuilt array
 *   came back as `["{\"x\":1}"]`. Re-applying `json()` on the strength of the
 *   carried `type` column puts it back.
 * - A boolean element decodes to the INTEGER 1 or 0 (its type column is
 *   'true'/'false'), so `[true]` rebuilt as `[1]`.
 *
 * Everything else passes through untouched: `json()` rejects the bare text a
 * string element decodes to, and a JSON null arrives as SQL NULL, which
 * `json_group_array` already renders as null.
 */
function restoreJson (valueExpr: string, typeExpr: string): string {
  return `CASE WHEN ${typeExpr} IN ('object','array') THEN json(${valueExpr}) ` +
    `WHEN ${typeExpr} = 'true' THEN json('true') ` +
    `WHEN ${typeExpr} = 'false' THEN json('false') ` +
    `ELSE ${valueExpr} END`
}

/** `json_group_array` over a rebuilt element stream, preserving JSON types. */
function groupArray (inner: string): string {
  return `(SELECT json_group_array(${restoreJson('v', 't')}) FROM (${inner}))`
}

// ---------------------------------------------------------------------------
// $push and its modifiers
// ---------------------------------------------------------------------------

/** The `$each`/`$slice`/`$sort` spec a `$push` or `$addToSet` operand may carry. */
interface EachSpec {
  values: unknown[]
  slice?: number
  sort?: 1 | -1 | Record<string, number>
}

/**
 * Normalizes a `$push`/`$addToSet` operand to a list of values plus modifiers.
 *
 * A bare value pushes exactly itself, even when it is an object - MongoDB only
 * reads `$each` and friends when `$each` is present, so `{ $push: { a: { b: 1 } } }`
 * pushes the document `{ b: 1 }`.
 */
function eachSpec (operator: string, field: string, operand: unknown): EachSpec {
  const isSpec = operand !== null && typeof operand === 'object' && !Array.isArray(operand) &&
    !(operand instanceof Date) && '$each' in (operand as object)
  if (!isSpec) {
    const stray = operand !== null && typeof operand === 'object' && !Array.isArray(operand) && !(operand instanceof Date)
      ? Object.keys(operand as object).find(key => key.startsWith('$'))
      : undefined
    if (stray !== undefined) throw Error(`Unrecognized clause in ${operator}: ${stray} (did you mean $each?)`)
    return { values: [operand] }
  }

  const spec = operand as Record<string, unknown>
  const values = spec.$each
  if (!Array.isArray(values)) throw Error(`The argument to $each in ${operator} must be an array: ${field}`)

  const known = new Set(['$each', '$slice', '$sort', '$position'])
  for (const key of Object.keys(spec)) {
    if (key === '$position') {
      // Inserting mid-array needs a rebuild that renumbers around the insert
      // point; nothing else here needs one, so it is rejected rather than
      // half-implemented. See "Missing Features" in the README.
      throw Error(`$position is not supported in ${operator} (only $each, $slice and $sort are)`)
    }
    if (!known.has(key)) throw Error(`Unrecognized clause in ${operator}: ${key}`)
  }

  const result: EachSpec = { values }
  if (spec.$slice !== undefined) {
    if (typeof spec.$slice !== 'number' || !Number.isInteger(spec.$slice)) {
      throw Error(`The value for $slice in ${operator} must be an integer: ${field}`)
    }
    result.slice = spec.$slice
  }
  if (spec.$sort !== undefined) {
    const sort = spec.$sort
    if (sort === 1 || sort === -1) {
      result.sort = sort
    } else if (sort !== null && typeof sort === 'object' && !Array.isArray(sort)) {
      for (const [key, direction] of Object.entries(sort)) {
        if (direction !== 1 && direction !== -1) {
          throw Error(`The $sort element value must be either 1 or -1: ${key}`)
        }
      }
      result.sort = sort as Record<string, number>
    } else {
      throw Error(`The $sort is invalid: use 1/-1 to sort the whole element, or {field:1/-1} to sort by a field`)
    }
    if (operator === '$addToSet') throw Error('$sort is only supported in $push')
  }
  if (result.slice !== undefined && operator === '$addToSet') throw Error('$slice is only supported in $push')
  return result
}

/**
 * Guards a per-field read of an element: `json_type(value, path)` raises
 * "malformed JSON" for the bare text a string element decodes to.
 */
function objectGuard (expr: string): string {
  return `CASE WHEN json_each.type = 'object' THEN ${expr} END`
}

/**
 * ORDER BY terms for `$push: { $sort }`, over the columns `json_each` exposes
 * for one element.
 *
 * `$sort: 1` orders the elements themselves; `$sort: { f: 1 }` orders by a
 * field inside each element. Both go through the same BSON rank/value pair the
 * collection-level sort uses, so an array sorted here and a collection sorted
 * by `find().sort()` agree. The `type = 'object'` guards exist because
 * `json_type(value, path)` raises "malformed JSON" for the bare text a string
 * element decodes to.
 */
function elementSortTerms (sort: 1 | -1 | Record<string, number>): string {
  if (sort === 1 || sort === -1) {
    const dateExpr = "CASE WHEN json_each.type = 'object' THEN json_extract(json_each.value, '$.$date') END"
    const dir = sort === 1 ? 'ASC' : 'DESC'
    return `${bsonRankSql('json_each.type', dateExpr)} ${dir}, ` +
      `${bsonValueSql('json_each.type', 'json_each.value', dateExpr)} ${dir}`
  }

  const terms: string[] = []
  for (const [field, direction] of Object.entries(sort)) {
    const typeExpr = objectGuard(`json_type(json_each.value, ${toJson1PathString([field])})`)
    const valueExpr = objectGuard(`json_extract(json_each.value, ${toJson1PathString([field])})`)
    const dateExpr = objectGuard(`json_extract(json_each.value, ${toJson1PathString([`${field}.$date`])})`)
    const dir = direction === 1 ? 'ASC' : 'DESC'
    terms.push(`${bsonRankSql(typeExpr, dateExpr)} ${dir}`, `${bsonValueSql(typeExpr, valueExpr, dateExpr)} ${dir}`)
  }
  return terms.join(', ')
}

/** Applies `$sort` then `$slice` to an array expression, in MongoDB's order. */
function applyEachModifiers (arrayExpr: string, spec: EachSpec): string {
  let expr = arrayExpr
  if (spec.sort !== undefined) {
    expr = groupArray(`SELECT json_each.value AS v, json_each.type AS t FROM json_each(${expr}) ORDER BY ${elementSortTerms(spec.sort)}`)
  }
  if (spec.slice !== undefined) {
    // A positive $slice keeps the FIRST n elements, a negative one the LAST n,
    // and 0 empties the array. `key` is json_each's element index.
    const n = spec.slice
    expr = n >= 0
      ? groupArray(`SELECT json_each.value AS v, json_each.type AS t FROM json_each(${expr}) WHERE json_each.key < ${n}`)
      : groupArray(`SELECT json_each.value AS v, json_each.type AS t FROM json_each(${expr}) WHERE json_each.key >= json_array_length(${expr}) - ${-n}`)
  }
  return expr
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Compiles a MongoDB update document into a SQL expression computing the new
 * value of the `data` column, plus its named parameters and preconditions.
 *
 * Update parameters are prefixed 'u' so they merge with a filter's 'p'-prefixed
 * parameters in one statement without collisions.
 */
export function buildUpdateExpression (update: AnyUpdate): UpdateExpression {
  const keys = Object.keys(update)
  if (keys.length === 0) throw Error('update document must contain atomic operators (e.g. { $set: { ... } })')
  for (const key of keys) {
    if (!FIELD_MAP_OPERATORS.has(key)) {
      throw Error(key.startsWith('$')
        ? `unsupported update operator: ${key} (supported: ${UPDATE_OPERATORS.join(', ')})`
        : 'update document requires atomic operators (e.g. { $set: { ... } })')
    }
  }

  assertNoConflictingPaths(update)

  const bindings = createBindings('u')
  const guards: UpdateGuard[] = []
  let expr = 'data'
  let pullAlias = 0

  const operand = (operator: string): Array<[string, unknown]> =>
    update[operator] == null ? [] : updateOperand(operator, update[operator], operator === '$setOnInsert')

  // --- $rename ------------------------------------------------------------
  for (const [field, to] of operand('$rename')) {
    const target = renameTarget(field, to)
    const from = toJson1PathString([field])
    // A rename whose SOURCE is missing is a no-op in MongoDB - and has to be
    // written as one, because json_extract of a missing path is SQL NULL and
    // json_quote turns that into the JSON value `null`, which would set the
    // target to null rather than leaving it alone.
    const moved = `json_remove(json_set(${ensureParents(expr, target)}, ${toJson1PathString([target])}, json_quote(json_extract(data, ${from}))), ${from})`
    expr = `CASE WHEN json_type(data, ${from}) IS NULL THEN ${expr} ELSE ${moved} END`
  }

  // --- $inc / $mul --------------------------------------------------------
  for (const [operator, arithmetic] of [['$inc', '+'], ['$mul', '*']] as const) {
    for (const [field, amount] of operand(operator)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw Error(`${operator} requires a finite number for field ${field}; but got: ${String(amount)}`)
      }
      const path = toJson1PathString([field])
      // A missing field starts from 0 in both cases: MongoDB counts $inc up
      // from zero, and creates a $mul target as zero (which then stays zero).
      const current = `COALESCE(json_extract(data, ${path}), 0)`
      expr = `json_set(${ensureParents(expr, field)}, ${path}, ${current} ${arithmetic} ${bindRaw(bindings, amount)})`
      // A present-but-non-numeric field is an error in MongoDB, and was silent
      // data loss here (SQLite reads 'hello' + 1 as 1).
      guards.push({ test: nonNumericAt(field), message: `Cannot apply ${operator} to a value of non-numeric type (field ${field})` })
    }
  }

  // --- $min / $max --------------------------------------------------------
  for (const [operator, takeWhen] of [['$min', '>'], ['$max', '<']] as const) {
    for (const [field, value] of operand(operator)) {
      const path = toJson1PathString([field])
      const datePath = toJson1PathString([`${field}.$date`])
      const typeExpr = `json_type(data, ${path})`
      const dateExpr = `json_extract(data, ${datePath})`
      const rank = bsonRankSql(typeExpr, dateExpr)
      const current = bsonValueSql(typeExpr, `json_extract(data, ${path})`, dateExpr)
      const [candidateRank, candidateValue] = comparableValue(value)
      const replacement = bindJson(bindings, value)
      // Row values let the (rank, value) pair compare in one shot, which is
      // what makes this follow BSON order rather than SQLite's.
      expr = `json_set(${ensureParents(expr, field)}, ${path}, CASE ` +
        `WHEN ${typeExpr} IS NULL THEN ${replacement} ` +
        `WHEN (${rank}, ${current}) ${takeWhen} (${bindRaw(bindings, candidateRank)}, ${bindRaw(bindings, candidateValue)}) THEN ${replacement} ` +
        `ELSE json_quote(json_extract(data, ${path})) END)`
    }
  }

  // --- $unset -------------------------------------------------------------
  const unsetPaths = operand('$unset').map(([field]) => toJson1PathString([field]))
  if (unsetPaths.length > 0) expr = `json_remove(${expr}, ${unsetPaths.join(', ')})`

  // --- $set ---------------------------------------------------------------
  for (const [field, value] of operand('$set')) {
    expr = `json_set(${ensureParents(expr, field)}, ${toJson1PathString([field])}, ${bindJson(bindings, value)})`
  }

  // $setOnInsert contributes no SQL - it only shapes the document an upsert
  // inserts - but its operand is validated above by updateTargets.

  // --- $push --------------------------------------------------------------
  for (const [field, pushed] of operand('$push')) {
    const spec = eachSpec('$push', field, pushed)
    // The whole $each list is bound as ONE json array and appended with a
    // UNION ALL, rather than as a json_insert per value. The obvious chain
    // nests one call per element, and SQLite's parser gives up at a few
    // hundred: `$push: { a: { $each: [...900 items] } }` failed with
    // "Recursion limit". This form is flat however long the list is.
    const appended = `SELECT json_each.value AS v, json_each.type AS t FROM json_each(${bindJson(bindings, spec.values)})`
    const array = groupArray(
      `SELECT json_each.value AS v, json_each.type AS t FROM json_each(${arrayAt(field)}) UNION ALL ${appended}`
    )
    expr = `json_set(${ensureParents(expr, field)}, ${toJson1PathString([field])}, ${applyEachModifiers(array, spec)})`
    guards.push({ test: nonArrayAt(field), message: `Cannot apply $push to a non-array value (field ${field})` })
  }

  // --- $addToSet ----------------------------------------------------------
  for (const [field, added] of operand('$addToSet')) {
    const spec = eachSpec('$addToSet', field, added)
    // Deduplicated HERE, against BSON equality, so each candidate only has to
    // be checked against the ORIGINAL array. Checking against the array as it
    // grows would mean nesting the whole expression once per value, which is
    // exponential in the size of $each.
    const candidates: unknown[] = []
    for (const value of spec.values) {
      if (!candidates.some(existing => equalsBson(existing, value))) candidates.push(value)
    }
    const array = arrayAt(field)
    const bound = bindJson(bindings, candidates)
    expr = `json_set(${ensureParents(expr, field)}, ${toJson1PathString([field])}, ${groupArray(
      `SELECT json_each.value AS v, json_each.type AS t FROM json_each(${array}) ` +
      'UNION ALL ' +
      // `e.type = c.type` is what keeps the comparison typed: a boolean element
      // decodes to the integer 1, so without it `$addToSet: { a: 1 }` would
      // find an existing `true` and decide the value was already there.
      `SELECT c.value, c.type FROM json_each(${bound}) c WHERE NOT EXISTS (SELECT 1 FROM json_each(${array}) e WHERE e.value IS c.value AND e.type = c.type)`
    )})`
    guards.push({ test: nonArrayAt(field), message: `Cannot apply $addToSet to a non-array value (field ${field})` })
  }

  // --- $pop ---------------------------------------------------------------
  for (const [field, direction] of operand('$pop')) {
    if (direction !== 1 && direction !== -1) {
      throw Error(`$pop expects 1 (last element) or -1 (first element) for field ${field}; but got: ${String(direction)}`)
    }
    // json_remove on a path that does not exist is a no-op, so both a missing
    // field and an empty array fall out correctly without a guard: '$.a[0]'
    // and '$.a[#-1]' address nothing when the array is empty.
    expr = `json_remove(${expr}, ${toJson1PathString([field], direction === 1 ? '[#-1]' : '[0]')})`
    guards.push({ test: nonArrayAt(field), message: `Cannot apply $pop to a non-array value (field ${field})` })
  }

  // --- $pull / $pullAll ---------------------------------------------------
  for (const [operator, toCriterion] of [
    ['$pull', (value: unknown) => pullCriterion(value)],
    ['$pullAll', (value: unknown) => {
      if (!Array.isArray(value)) throw Error('$pullAll requires an array argument')
      // $pullAll removes by exact equality against a list, which is what $in
      // already means over an element.
      return { $in: value }
    }]
  ] as const) {
    for (const [field, value] of operand(operator)) {
      const alias = `pullJson${pullAlias++}`
      const predicate = elementCriterionSql(alias, toCriterion(value), bindings)
      // json_replace, not json_set: a $pull against a MISSING field is a no-op
      // in MongoDB, and json_replace only writes where the path already exists.
      // The alias is referenced from the WHERE of the same SELECT that computes
      // it, which SQLite allows - the same shape $elemMatch compiles to.
      expr = `json_replace(${expr}, ${toJson1PathString([field])}, ${groupArray(
        `SELECT json_each.value AS v, json_each.type AS t, json_object('f', json_quote(json_each.value)) AS ${alias} ` +
        `FROM json_each(${arrayAt(field)}) WHERE NOT (${predicate})`
      )})`
      guards.push({ test: nonArrayAt(field), message: `Cannot apply ${operator} to a non-array value (field ${field})` })
    }
  }

  const guardSql = guards.length === 0
    ? undefined
    : `CASE ${guards.map((guard, index) => `WHEN ${guard.test} THEN ${index}`).join(' ')} END`

  return { sql: expr, params: bindings.values, guards, ...(guardSql === undefined ? {} : { guardSql }) }
}

/**
 * A `$pull` argument as a per-element criterion.
 *
 * A plain document is a QUERY run against each element (`{ score: 8 }` pulls
 * every element whose `score` is 8, not only elements equal to that document),
 * which is exactly `$elemMatch`'s rule. Everything else - a scalar, an array,
 * a Date - is an equality, and a RegExp is a pattern match.
 */
function pullCriterion (value: unknown): QueryFilterDocument {
  if (value instanceof RegExp) return { $regex: value }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return { $eq: value }
  }
  return value as QueryFilterDocument
}

/**
 * The (rank, value) pair a JS value compares as, matching what
 * `bsonRankSql`/`bsonValueSql` compute for a stored one. Used by `$min`/`$max`,
 * whose comparison happens in SQL against a value supplied in JavaScript.
 */
function comparableValue (value: unknown): [number, string | number | null] {
  if (value === null || value === undefined) return [0, null]
  if (typeof value === 'number') return [1, value]
  if (typeof value === 'string') return [2, value]
  if (value instanceof Date) return [6, value.toISOString()]
  if (Array.isArray(value)) return [4, JSON.stringify(value)]
  if (typeof value === 'boolean') return [5, value ? 1 : 0]
  return [3, JSON.stringify(value)]
}

// ---------------------------------------------------------------------------
// The document an upsert inserts
// ---------------------------------------------------------------------------

/**
 * Writes `value` at a dotted path, creating missing parent objects - the JS
 * counterpart of what `ensureParents` + `json_set` do in SQL. Used only when
 * building the document an upsert inserts.
 */
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

/** Reads a dotted path out of a document, or undefined when any level is missing. */
function getPath (doc: Document, field: string): unknown {
  let node: any = doc
  for (const segment of field.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[segment]
  }
  return node
}

/** Removes a dotted path from a document. */
function deletePath (doc: Document, field: string): void {
  const segments = field.split('.')
  let node: any = doc
  for (const segment of segments.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return
    node = node[segment]
  }
  if (node !== null && typeof node === 'object') delete node[segments[segments.length - 1]!]
}

/**
 * Collects the equality conditions a filter pins, the way MongoDB seeds an
 * upsert's new document: `{ a: 1, 'b.c': { $eq: 2 } }` contributes
 * `{ a: 1, b: { c: 2 } }`.
 *
 * Anything that is not an equality contributes NOTHING - a range, `$in`, a
 * regex, `$or`/`$nor`/`$not` - because there is no single value they imply.
 * `$and` is the exception: it is a conjunction, so each of its terms still
 * has to hold.
 */
export function collectEqualities (filter: Record<string, any>, into: Document): void {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const term of value) {
        if (term !== null && typeof term === 'object') collectEqualities(term as Record<string, any>, into)
      }
      continue
    }
    if (key.startsWith('$')) continue
    if (value instanceof RegExp) continue // a pattern, not a value

    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const keys = Object.keys(value)
      if (keys.some(k => k.startsWith('$'))) {
        // An operator criterion. Only an explicit $eq names a value.
        if (keys.length === 1 && keys[0] === '$eq' && !((value as Document).$eq instanceof RegExp)) {
          setPath(into, key, (value as Document).$eq)
        }
        continue
      }
    }
    setPath(into, key, value)
  }
}

/**
 * The document an upsert inserts when nothing matched: the filter's equality
 * conditions, with the update applied over them.
 *
 * This is the one place an update runs in JavaScript rather than SQL, because
 * there is no row to run it against. Operators that only ever REMOVE something
 * ($unset, $pop, $pull, $pullAll) contribute nothing - there is nothing to
 * remove from a document that does not exist yet - and the rest apply to a
 * document where every field starts out missing: `$inc` counts up from 0,
 * `$mul` yields 0, `$min`/`$max` take their argument outright.
 */
export function buildUpsertDocument (filter: Record<string, any>, update: AnyUpdate): Document {
  const doc: Document = {}
  collectEqualities(filter, doc)

  for (const [field, to] of Object.entries((update.$rename ?? {}) as Record<string, string>)) {
    const existing = getPath(doc, field)
    if (existing === undefined) continue
    deletePath(doc, field)
    setPath(doc, to, existing)
  }
  for (const operator of ['$setOnInsert', '$set'] as const) {
    for (const [field, value] of Object.entries((update[operator] ?? {}) as Record<string, unknown>)) {
      setPath(doc, field, value)
    }
  }
  for (const [field, amount] of Object.entries((update.$inc ?? {}) as Record<string, number>)) {
    setPath(doc, field, amount)
  }
  for (const field of Object.keys((update.$mul ?? {}) as Record<string, number>)) {
    setPath(doc, field, 0)
  }
  for (const operator of ['$min', '$max'] as const) {
    for (const [field, value] of Object.entries((update[operator] ?? {}) as Record<string, unknown>)) {
      setPath(doc, field, value)
    }
  }
  for (const operator of ['$push', '$addToSet'] as const) {
    for (const [field, operand] of Object.entries((update[operator] ?? {}) as Record<string, unknown>)) {
      const spec = eachSpec(operator, field, operand)
      const values: unknown[] = []
      for (const value of spec.values) {
        if (operator === '$addToSet' && values.some(existing => equalsBson(existing, value))) continue
        values.push(value)
      }
      setPath(doc, field, applyEachModifiersInJs(values, spec))
    }
  }
  return doc
}

/** `$sort` then `$slice`, applied to the array a `$push` upsert creates. */
function applyEachModifiersInJs (values: unknown[], spec: EachSpec): unknown[] {
  let result = values
  if (spec.sort !== undefined) result = sortElements(result, spec.sort)
  if (spec.slice !== undefined) {
    result = spec.slice >= 0 ? result.slice(0, spec.slice) : result.slice(spec.slice)
  }
  return result
}

/** The JS twin of elementSortTerms, for the upsert path. */
function sortElements (values: unknown[], sort: 1 | -1 | Record<string, number>): unknown[] {
  const entries = sort === 1 || sort === -1 ? [['', sort] as const] : Object.entries(sort)
  return values.toSorted((a, b) => {
    for (const [field, direction] of entries) {
      const left = field === '' ? a : getPath(a as Document, field)
      const right = field === '' ? b : getPath(b as Document, field)
      const comparison = compareBson(left, right)
      if (comparison !== 0) return direction === 1 ? comparison : -comparison
    }
    return 0
  })
}
