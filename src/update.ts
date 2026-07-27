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
 *    inside the statement - a CASE calling a registered SQL function that
 *    throws - is not portable: a driver may have no user-defined functions at
 *    all (DR-3), and on Node 22 (a floor this package once had) the exception
 *    was SWALLOWED into NULL, so `json_set` wrote null over the value the
 *    guard existed to protect. Checking first also means a refusal leaves
 *    every row untouched, not just the offending one.
 */

import { compareBson, equalsBson } from './bson-order.js'
import { encodeValue } from './ejson.js'
import { ownField, setField } from './safe-object.js'
import type { Document } from './types.js'
import {
  bindJson, bindRaw, bsonRankSql, bsonValueSql, createBindings, elementCriterionSql,
  firstMatchingElementSql, quoteIdentifier, toJson1PathString,
  type QueryFilterDocument, type SqlBindings, type SqlParams
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
  '$rename', '$inc', '$mul', '$bit', '$min', '$max', '$unset', '$set', '$currentDate', '$setOnInsert',
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

/** What compiling an update needs beyond the update document itself. */
export interface UpdateCompileOptions {
  /** The filter the update runs with. `$` writes to the element it matched. */
  filter?: QueryFilterDocument
  /** The `arrayFilters` option, naming the elements `$[<identifier>]` selects. */
  arrayFilters?: Document[]
}

export interface UpdateExpression {
  /** SQL computing the row's new `data` value. */
  sql: string
  params: SqlParams
  guards: UpdateGuard[]
  /**
   * Parameters for `guardSql`, kept SEPARATE from `params`.
   *
   * A positional guard carries the criterion it selects elements with, so
   * guards are no longer parameterless SQL - and `node:sqlite` rejects a
   * statement given a named parameter it does not use, in either direction. One
   * registry per statement is the only shape that binds exactly.
   */
  guardParams: SqlParams
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

/** One path an update writes to. See `updatedPaths`. */
export interface UpdatedPath {
  path: string
  /**
   * True for the operators that can EXTEND an array at the end (`$push`,
   * `$addToSet`), which MongoDB reports one appended index at a time.
   */
  appends: boolean
}

/** The operators MongoDB reports by appended index rather than by whole array. */
const APPENDING_OPERATORS = new Set(['$push', '$addToSet'])

/**
 * Every document path an update WRITES TO - what a change event's
 * `updateDescription` names (BACKLOG item 27).
 *
 * Taken from the update SPEC rather than from a diff of the before and after
 * documents, because the spec is what MongoDB reports and a diff cannot
 * reproduce it. Verified against the server: `$set: { a: { b: 1, c: 2 } }` over
 * an existing `a` names `'a'` and NOT `'a.b'`/`'a.c'`, which is exactly the
 * answer a minimal diff would get wrong. The VALUES are read out of the new
 * document afterwards (`updateDescriptionFor` in src/change-stream.ts), so a
 * path missing there is a removal - which is what makes `$unset` and a
 * `$rename`'s source fall out of one rule instead of a case each.
 *
 * Two things the oracle settled, both pinned in test/change-streams.spec.ts:
 *
 * - **`$push` and `$addToSet` name the appended INDEX** (`'tags.1'`), where
 *   `$pop` and `$pull` name the whole rebuilt array - even a 40-element one, so
 *   this is not a size heuristic. `appends` is what carries that distinction;
 *   the append is only reported per-index when the new array actually extends
 *   the old one, which is why `$push` with `$position`, `$sort` or `$slice`
 *   comes back whole.
 * - **A path written THROUGH a positional operator is reported as the array**:
 *   `'grades.$[e].score'` becomes `'grades'`. MongoDB names the concrete
 *   element it hit (`'grades.1.score'`), which is not knowable until the
 *   statement has run - `strict` refuses that case rather than quietly
 *   reporting the wider path.
 */
export function updatedPaths (update: AnyUpdate): UpdatedPath[] {
  const paths: UpdatedPath[] = []
  for (const [operator, field] of updateTargets(update)) {
    // $setOnInsert shapes the document an upsert INSERTS and never modifies an
    // existing one, so it is not part of any update event.
    if (operator === '$setOnInsert') continue
    const segments = field.split('.')
    const at = segments.findIndex(segment => POSITIONAL_SEGMENT.test(segment))
    const path = at === -1 ? field : segments.slice(0, at).join('.')
    if (paths.some(seen => seen.path === path)) continue
    paths.push({ path, appends: at === -1 && APPENDING_OPERATORS.has(operator) })
  }
  return paths
}

/** True when an update writes through `$`, `$[]` or `$[<identifier>]`. See `updatedPaths`. */
export function writesThroughPositional (update: AnyUpdate): boolean {
  return updateTargets(update).some(
    ([, field]) => field.split('.').some(segment => POSITIONAL_SEGMENT.test(segment))
  )
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

/**
 * True where the value at `path` exists but is not a number - $inc/$mul's error
 * case. Written over (source, path) rather than a field name so the same test
 * serves a document column and one wrapped array element.
 */
function nonNumericAt (source: string, path: string): string {
  return `(json_type(${source}, ${path}) IS NOT NULL AND json_type(${source}, ${path}) NOT IN ('integer','real'))`
}

/**
 * True where the value at `path` exists but is not a whole number - `$bit`'s
 * error case. MongoDB refuses a `$bit` on a double as firmly as on a string,
 * because a double has no bits to speak of.
 */
function nonIntegerAt (source: string, path: string): string {
  return `(json_type(${source}, ${path}) IS NOT NULL AND json_type(${source}, ${path}) != 'integer')`
}

/**
 * One `$bit` operand: `{ and: <int>, or: <int>, xor: <int> }`, at least one,
 * applied in the order they are written.
 *
 * The masks bind as decimal STRINGS and are `CAST` to INTEGER on the way in -
 * the same trick the `$bits*` QUERY operators use, and for the same reason: bit
 * 62 is already past `Number.MAX_SAFE_INTEGER`, so a bound JS number would
 * quietly lose precision. `BigInt.asIntN` is what makes bit 63 the sign bit
 * rather than a value SQLite would clamp.
 */
function bitOperations (field: string, operand: unknown): Array<[string, string]> {
  if (operand === null || typeof operand !== 'object' || Array.isArray(operand) || operand instanceof Date) {
    throw Error(`The $bit modifier is not compatible with a ${operand === null ? 'null' : typeof operand} (field ${field})`)
  }
  const entries = Object.entries(operand as Document)
  if (entries.length === 0) throw Error(`You must pass in at least one bitwise operation to $bit (field ${field})`)
  return entries.map(([operation, value]) => {
    if (!['and', 'or', 'xor'].includes(operation)) {
      throw Error(`The $bit modifier only supports 'and', 'or', and 'xor', not '${operation}'`)
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw Error(`The $bit modifier field must be an Integer(32/64 bit); a '${typeof value}' is not supported here: {${operation}: ${String(value)}}`)
    }
    if (!Number.isSafeInteger(value)) {
      throw Error(`The $bit modifier's operand cannot be represented exactly: {${operation}: ${String(value)}}`)
    }
    return [operation, BigInt.asIntN(64, BigInt(value)).toString()]
  })
}

/**
 * The `$currentDate` type specification: `true` (or any boolean - the server
 * accepts one) or `{ $type: 'date' }`.
 *
 * `{ $type: 'timestamp' }` is refused rather than answered with a Date: a BSON
 * Timestamp is one of the types this library's storage layer cannot hold (see
 * src/ejson.ts), and silently substituting a different type is the failure mode
 * the whole library avoids.
 */
function assertCurrentDateSpec (field: string, spec: unknown): void {
  if (typeof spec === 'boolean') return
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw Error(`${String(spec)} is not valid type for $currentDate. Please use a boolean ('true') or a $type expression ({$type: 'date'}) (field ${field})`)
  }
  const entries = Object.entries(spec as Document)
  if (entries.length !== 1 || entries[0]![0] !== '$type') {
    throw Error(`Unrecognized $currentDate option: ${Object.keys(spec as Document)[0] ?? ''} (field ${field})`)
  }
  const type = entries[0]![1]
  if (type === 'timestamp') {
    throw Error(
      "$currentDate: { $type: 'timestamp' } is not supported: a BSON Timestamp is not one of the types " +
      "this library can store. Use { $type: 'date' }, which is what almost every caller means"
    )
  }
  if (type !== 'date') throw Error(`The '$type' string field is required to be 'date' or 'timestamp' (field ${field})`)
}

/**
 * The `.$date` sub-path of an already-quoted JSON path literal.
 *
 * Appending inside the literal rather than rebuilding it from the field name:
 * a positional write's path is `'$.f.score'`, which no field name spells.
 */
function datePathOf (path: string): string {
  return `${path.slice(0, -1)}.$date'`
}

/** True for a row whose `field` exists but is not an array - the array operators' error case. */
function nonArrayAt (field: string): string {
  const path = toJson1PathString([field])
  return `(json_type(data, ${path}) IS NOT NULL AND json_type(data, ${path}) != 'array')`
}

/**
 * Guards rejecting a write whose dotted path runs THROUGH a value that cannot be
 * traversed. MongoDB errors ("cannot use the part … to traverse the element")
 * and leaves the document untouched; SQLite's `json_set`/`json_insert` silently
 * NO-OP on such a path, which drops the write - and for `$rename`, whose
 * `json_remove` still fires, DESTROYS the source while never creating the
 * target. Each ancestor that exists must be an object, except that an ancestor
 * reached by an array INDEX may also be an array.
 *
 * `when` restricts the check to rows where a further condition holds - `$rename`
 * passes "the source exists", because renaming a missing field is a no-op that
 * must not raise however the target path looks.
 */
function traversalGuards (field: string, when?: string): UpdateGuard[] {
  const segments = field.split('.')
  const result: UpdateGuard[] = []
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i)
    const type = `json_type(data, ${toJson1PathString(prefix)})`
    const blocked = /^\d+$/.test(segments[i]!)
      ? `${type} IS NOT NULL AND ${type} NOT IN ('object','array')`
      : `${type} IS NOT NULL AND ${type} != 'object'`
    result.push({
      test: when === undefined ? `(${blocked})` : `(${when} AND (${blocked}))`,
      message: `Cannot create field '${segments[i]}' in element {${prefix.join('.')}: <not an object>} (field ${field})`
    })
  }
  return result
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
// The positional operators: $, $[] and $[<identifier>]
// ---------------------------------------------------------------------------

/** A path segment that selects array elements rather than naming a field. */
const POSITIONAL_SEGMENT = /^\$(?:\[(.*)\])?$/
const ARRAY_FILTER_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9]*$/

/**
 * A field path that reaches THROUGH an array, split at the positional segment.
 *
 * `'grades.$[e].score'` becomes `{ array: 'grades', identifier: 'e',
 * suffix: 'score' }`. An empty suffix means the operator targets the element
 * itself (`'tags.$'`).
 */
interface PositionalTarget {
  array: string
  /** `undefined` for `$` (the element the QUERY matched). */
  identifier?: string
  /** True for `$[]`, which selects every element. */
  all: boolean
  suffix: string
}

/** Field operators that can write through a positional segment. */
const POSITIONAL_CAPABLE = new Set(['$set', '$unset', '$inc', '$mul', '$min', '$max', '$bit', '$currentDate'])

function parsePositional (operator: string, field: string): PositionalTarget | undefined {
  const segments = field.split('.')
  const at = segments.findIndex(segment => POSITIONAL_SEGMENT.test(segment))
  if (at === -1) return undefined

  if (!POSITIONAL_CAPABLE.has(operator)) {
    throw Error(
      `the positional operators ($, $[] and $[<identifier>]) are not supported in ${operator} ` +
      `(only in ${[...POSITIONAL_CAPABLE].join(', ')}): ${field}`
    )
  }
  if (at === 0) throw Error(`a positional operator needs an array to index into: ${field}`)
  const rest = segments.slice(at + 1)
  if (rest.some(segment => POSITIONAL_SEGMENT.test(segment))) {
    throw Error(`only one positional operator is supported per path: ${field}`)
  }

  const inside = POSITIONAL_SEGMENT.exec(segments[at]!)![1]
  const target: PositionalTarget = {
    array: segments.slice(0, at).join('.'),
    all: inside === '',
    suffix: rest.join('.')
  }
  if (inside !== undefined && inside !== '') {
    if (!ARRAY_FILTER_IDENTIFIER.test(inside)) {
      throw Error(`an arrayFilters identifier must be alphanumeric and start with a letter: $[${inside}]`)
    }
    target.identifier = inside
  }
  return target
}

/**
 * The criterion an `arrayFilters` entry states about one identifier.
 *
 * `[{ 'e.score': { $lt: 50 } }]` for `$[e]` becomes `{ score: { $lt: 50 } }` -
 * the same per-element shape `$elemMatch` takes, so it compiles through the
 * same `elementCriterionSql` everything else does. An entry may also name the
 * element itself (`{ e: { $gt: 3 } }`), for an array of scalars.
 */
function arrayFilterCriterion (identifier: string, arrayFilters: Document[], used: Set<number>): QueryFilterDocument {
  const matches: number[] = []
  arrayFilters.forEach((entry, index) => {
    if (identifiersIn(entry).has(identifier)) matches.push(index)
  })
  if (matches.length === 0) {
    throw Error(`No array filter found for identifier '${identifier}' in path`)
  }
  if (matches.length > 1) {
    throw Error(`Found multiple array filters with the same top-level field name '${identifier}'`)
  }
  const index = matches[0]!
  used.add(index)

  const criterion: QueryFilterDocument = {}
  // `$and` is flattened rather than kept: a criterion document already MEANS a
  // conjunction, so `{ $and: [{ 'e.a': 1 }, { 'e.b': 2 }] }` and
  // `{ 'e.a': 1, 'e.b': 2 }` are the same condition. `$or` and `$nor` have no
  // such spelling and are refused rather than half-applied.
  const collect = (entry: Document): void => {
    for (const [key, value] of Object.entries(entry)) {
      if (key === '$and' && Array.isArray(value)) {
        for (const branch of value) collect(branch as Document)
        continue
      }
      if (key.startsWith('$')) {
        throw Error(`${key} is not supported inside arrayFilters (identifier '${identifier}')`)
      }
      const path = key === identifier ? '' : key.slice(identifier.length + 1)
      const condition = path === '' ? (isCriterionDocument(value) ? value : { $eq: value }) : { [path]: value }
      for (const [conditionKey, conditionValue] of Object.entries(condition)) {
        if (conditionKey in criterion) {
          throw Error(`arrayFilters for '${identifier}' constrain '${conditionKey}' more than once`)
        }
        criterion[conditionKey] = conditionValue
      }
    }
  }
  collect(arrayFilters[index]!)
  return criterion
}

/** The identifiers an arrayFilters entry constrains, looking through `$and`. */
function identifiersIn (entry: Document): Set<string> {
  const found = new Set<string>()
  const visit = (node: Document): void => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$and' && Array.isArray(value)) for (const branch of value) visit(branch as Document)
      else if (!key.startsWith('$')) found.add(key.split('.')[0]!)
    }
  }
  visit(entry)
  return found
}

function assertArrayFilters (arrayFilters: unknown): asserts arrayFilters is Document[] {
  if (!Array.isArray(arrayFilters)) throw Error('arrayFilters must be an array of documents')
  for (const entry of arrayFilters) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw Error('each arrayFilters entry must be a document')
    }
    const identifiers = identifiersIn(entry as Document)
    if (identifiers.size !== 1) {
      throw Error(
        'each arrayFilters entry must constrain exactly one identifier; but got: ' +
        JSON.stringify([...identifiers])
      )
    }
  }
}

function isCriterionDocument (value: unknown): value is QueryFilterDocument {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) &&
    Object.keys(value).some(key => key.startsWith('$'))
}

/**
 * The element stream a positional rebuild reads.
 *
 * Each element is carried three ways: its index (`ek`), its raw value and type
 * (`ev`/`et`, for the elements left alone), and wrapped as `{ "f": <element> }`
 * under `alias` - the same wrapper `$elemMatch` and `$pull` use, which is what
 * lets an ordinary field path address the element itself (`$.f`) or a field
 * inside it (`$.f.score`).
 *
 * It is a DERIVED table rather than a plain FROM, because the alias has to be
 * referenceable from the SELECT list above it; SQLite resolves a result alias
 * in WHERE, but not in a sibling result column.
 */
function elementSource (arrayField: string, alias: string): string {
  return 'SELECT json_each.key AS ek, json_each.value AS ev, json_each.type AS et, ' +
    `json_object('f', json_quote(json_each.value)) AS ${alias} FROM json_each(${arrayAt(arrayField)})`
}

/** The array at `arrayField`, rebuilt with `written` applied to the selected elements. */
function rebuildElements (arrayField: string, alias: string, selected: string, written: string): string {
  return `(SELECT json_group_array(${restoreJson('v', 't')}) FROM (` +
    `SELECT CASE WHEN ${selected} THEN json_extract(${written}, '$.f') ELSE ev END AS v, ` +
    `CASE WHEN ${selected} THEN json_type(${written}, '$.f') ELSE et END AS t ` +
    `FROM (${elementSource(arrayField, alias)})))`
}

// ---------------------------------------------------------------------------
// $push and its modifiers
// ---------------------------------------------------------------------------

/** The `$each`/`$slice`/`$sort`/`$position` spec a `$push` or `$addToSet` operand may carry. */
interface EachSpec {
  values: unknown[]
  slice?: number
  sort?: 1 | -1 | Record<string, number>
  position?: number
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
    if (!known.has(key)) throw Error(`Unrecognized clause in ${operator}: ${key}`)
  }

  const result: EachSpec = { values }
  if (spec.$position !== undefined) {
    if (operator === '$addToSet') throw Error('$position is only supported in $push')
    if (typeof spec.$position !== 'number' || !Number.isInteger(spec.$position)) {
      throw Error(`The value for $position in ${operator} must be an integer: ${field}`)
    }
    result.position = spec.$position
  }
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
    const binExpr = "CASE WHEN json_each.type = 'object' THEN json_extract(json_each.value, '$.$binary') END"
    const dir = sort === 1 ? 'ASC' : 'DESC'
    return `${bsonRankSql('json_each.type', dateExpr, binExpr)} ${dir}, ` +
      `${bsonValueSql('json_each.type', 'json_each.value', dateExpr)} ${dir}`
  }

  const terms: string[] = []
  for (const [field, direction] of Object.entries(sort)) {
    const typeExpr = objectGuard(`json_type(json_each.value, ${toJson1PathString([field])})`)
    const valueExpr = objectGuard(`json_extract(json_each.value, ${toJson1PathString([field])})`)
    const dateExpr = objectGuard(`json_extract(json_each.value, ${toJson1PathString([`${field}.$date`])})`)
    const binExpr = objectGuard(`json_extract(json_each.value, ${toJson1PathString([`${field}.$binary`])})`)
    const dir = direction === 1 ? 'ASC' : 'DESC'
    terms.push(`${bsonRankSql(typeExpr, dateExpr, binExpr)} ${dir}`, `${bsonValueSql(typeExpr, valueExpr, dateExpr)} ${dir}`)
  }
  return terms.join(', ')
}

/**
 * One of the three runs a `$position` insert stitches together, tagged with its
 * group so the whole thing can be ordered explicitly - UNION ALL alone does not
 * promise an order, and here the order IS the feature.
 */
function positionRun (source: string, group: number, where = ''): string {
  return `SELECT json_each.value AS v, json_each.type AS t, ${group} AS g, json_each.key AS k ` +
    `FROM json_each(${source})${where}`
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
    //
    // **The negative arm must not name `expr` twice.** It used to read
    // `WHERE json_each.key >= json_array_length(${expr}) - n`, which made
    // SQLite recompute the WHOLE array expression - including the `$sort`
    // rebuild above, when there is one - once per ELEMENT: `$slice: -n` was
    // quadratic in the array's length, and the documented capped-list idiom
    // (`$each` + `$sort` + `$slice`) was the slowest thing in the library.
    // Measured at 6,000 elements: 9.4s, or 34s with $sort, against 7ms for the
    // same push without $slice. Taking the last n as "ORDER BY key DESC LIMIT
    // n, then put them back in order" evaluates the array exactly once.
    const n = spec.slice
    expr = n >= 0
      ? groupArray(`SELECT json_each.value AS v, json_each.type AS t FROM json_each(${expr}) WHERE json_each.key < ${n}`)
      : groupArray(
          'SELECT v, t FROM (' +
          `SELECT json_each.value AS v, json_each.type AS t, json_each.key AS k FROM json_each(${expr}) ` +
          `ORDER BY json_each.key DESC LIMIT ${-n}` +
          ') ORDER BY k ASC'
        )
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
/**
 * How one field operator changes a value.
 *
 * `target` is the document being written into, `source` the one being read
 * from, and `path` the JSON path within them. Splitting the two is what lets
 * the SAME writer serve an ordinary field and a positional one: normally
 * `target` is the expression built so far and `source` is `data` (rule 1 - an
 * operator always reads the original column), while inside a positional rebuild
 * both are one wrapped element and the path is the suffix under `$.f`.
 */
type FieldWriter = (target: string, source: string, path: string) => string

/** What a positional write needs from the surrounding compilation. */
interface PositionalContext {
  bindings: SqlBindings
  /** A registry of its own, because guards are a separate statement. */
  guardBindings: SqlBindings
  /** The filter the update ran with - `$` matches the element this selected. */
  filter: QueryFilterDocument
  arrayFilters: Document[]
  usedArrayFilters: Set<number>
  nextAlias: () => string
  guards: UpdateGuard[]
}

/**
 * Applies one field operator, through a positional segment when the path has
 * one.
 *
 * Without a positional segment this is exactly what the operators did before:
 * one `json_set`/`json_remove` at a literal path. With one, the array is
 * rebuilt element by element and the writer is applied to those the segment
 * selects - `$` to the single element the query matched (its index comes from
 * `firstMatchingElementSql`, the same probe the `$` PROJECTION operator uses),
 * `$[]` to all of them, `$[e]` to those matching an `arrayFilters` entry.
 */
function applyFieldWrite (
  expr: string, operator: string, field: string, writer: FieldWriter, ctx: PositionalContext,
  guard?: { test: (source: string, path: string) => string, message: string }
): string {
  const target = parsePositional(operator, field)

  if (target === undefined) {
    // $unset through a non-traversable parent is a no-op in MongoDB, not an
    // error - every other field operator raises rather than silently dropping
    // the write, which is what a bare json_set would do here.
    if (operator !== '$unset') ctx.guards.push(...traversalGuards(field))
    if (guard !== undefined) {
      ctx.guards.push({ test: guard.test('data', toJson1PathString([field])), message: guard.message })
    }
    return writer(ensureParents(expr, field), 'data', toJson1PathString([field]))
  }

  const alias = ctx.nextAlias()
  const wrapped = quoteIdentifier(alias)
  // '$.f' addresses the element itself; '$.f.<suffix>' a field inside it.
  const elementPath = toJson1PathString([target.suffix === '' ? 'f' : `f.${target.suffix}`])

  // Built once per registry: the expression's parameters go to the UPDATE, the
  // guards' to the SELECT that checks them.
  const selectedWith = (into: SqlBindings): string => {
    if (target.all) return '1'
    if (target.identifier !== undefined) {
      return elementCriterionSql(alias, arrayFilterCriterion(target.identifier, ctx.arrayFilters, ctx.usedArrayFilters), into)
    }
    const criterion = positionalCriterion(ctx.filter, target.array, field)
    return `ek = (${firstMatchingElementSql('data', target.array, criterion, into)})`
  }
  const selected = selectedWith(ctx.bindings)

  if (target.identifier === undefined && !target.all) {
    // `$` writes to the element the QUERY matched. MongoDB fails an update
    // whose query matched no element, and so does this.
    const criterion = positionalCriterion(ctx.filter, target.array, field)
    ctx.guards.push({
      test: `(${firstMatchingElementSql('data', target.array, criterion, ctx.guardBindings)}) IS NULL`,
      message: `The positional operator did not find the match needed from the query (path '${field}')`
    })
  }

  if (guard !== undefined) {
    // Only the SELECTED elements have to satisfy it - guarding the whole array
    // would refuse updates whose targets are perfectly fine.
    ctx.guards.push({
      test: `EXISTS (SELECT 1 FROM (${elementSource(target.array, alias)}) WHERE (${selectedWith(ctx.guardBindings)}) AND ` +
        `(${guard.test(wrapped, elementPath)}))`,
      message: guard.message
    })
  }

  return `json_replace(${expr}, ${toJson1PathString([target.array])}, ` +
    `${rebuildElements(target.array, alias, selected, writer(wrapped, wrapped, elementPath))})`
}

/**
 * The condition the filter places on the array a `$` write targets.
 *
 * Same rule as the `$` PROJECTION operator (src/projection.ts): `$and` is
 * traversed because it is a conjunction, `$or` is not because no single branch
 * is the one that matched.
 */
function positionalCriterion (filter: QueryFilterDocument, array: string, field: string): QueryFilterDocument {
  const criterion: QueryFilterDocument = {}
  let found = false

  const visit = (node: QueryFilterDocument): void => {
    for (const [key, value] of Object.entries(node ?? {})) {
      if (key === '$and' && Array.isArray(value)) {
        for (const branch of value) visit(branch as QueryFilterDocument)
      } else if (key === array) {
        found = true
        if (value instanceof RegExp) criterion.$regex = value
        else if (isCriterionDocument(value)) Object.assign(criterion, value.$elemMatch ?? value)
        else criterion.$eq = value
      } else if (key.startsWith(`${array}.`)) {
        found = true
        criterion[key.slice(array.length + 1)] = value
      }
    }
  }
  visit(filter)

  if (!found) {
    throw Error(
      `The positional operator did not find the match needed from the query: '${field}' - ` +
      `the filter says nothing about '${array}'`
    )
  }
  return criterion
}

/**
 * The write-back a PIPELINE update uses: one statement however many rows, over
 * a single bound JSON array of `{ r: rowid, d: <new document> }` entries named
 * `:updates` (BACKLOG item 28).
 *
 * A pipeline update evaluates in JavaScript (see `compileUpdatePipeline` in
 * src/aggregate.ts for why), so the new documents exist before any write. The
 * obvious write-back - one UPDATE per row - is N round trips under driver-seam
 * rule 3; this is one. `d` is embedded as REAL nested JSON, not a string, so
 * `json_extract` hands back its text without a second layer of escaping, and
 * `table` is the quoted table name because the correlated `rowid` must name the
 * OUTER table - `json_each` is a virtual table with no rowid of its own.
 */
export function pipelineWritebackSql (table: string): { setSql: string, whereSql: string } {
  return {
    setSql: `(SELECT json_extract(u.value, '$.d') FROM json_each(:updates) AS u WHERE json_extract(u.value, '$.r') = ${table}.rowid)`,
    whereSql: `rowid IN (SELECT json_extract(u.value, '$.r') FROM json_each(:updates) AS u)`
  }
}

export function buildUpdateExpression (update: AnyUpdate, options: UpdateCompileOptions = {}): UpdateExpression {
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
  const guardBindings = createBindings('g')
  const guards: UpdateGuard[] = []
  let expr = 'data'
  let pullAlias = 0
  let elementAlias = 0

  const arrayFilters = options.arrayFilters ?? []
  assertArrayFilters(arrayFilters)
  const positional: PositionalContext = {
    bindings,
    guardBindings,
    filter: options.filter ?? {},
    arrayFilters,
    usedArrayFilters: new Set<number>(),
    nextAlias: () => `elemJson${elementAlias++}`,
    guards
  }

  const operand = (operator: string): Array<[string, unknown]> =>
    update[operator] == null ? [] : updateOperand(operator, update[operator], operator === '$setOnInsert')

  // --- $rename ------------------------------------------------------------
  for (const [field, to] of operand('$rename')) {
    parsePositional('$rename', field) // rejects a positional path with a clear message
    const target = renameTarget(field, to)
    const from = toJson1PathString([field])
    // The target's parents must be traversable, or `json_set` no-ops while the
    // `json_remove` below still fires - which used to DESTROY the source and
    // report success. Only checked when the source exists (a rename of a missing
    // field is a no-op MongoDB does not raise on).
    guards.push(...traversalGuards(target, `json_type(data, ${from}) IS NOT NULL`))
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
      const bound = bindRaw(bindings, amount)
      expr = applyFieldWrite(expr, operator, field, (target, source, path) =>
        // A missing field starts from 0 in both cases: MongoDB counts $inc up
        // from zero, and creates a $mul target as zero (which then stays zero).
        `json_set(${target}, ${path}, COALESCE(json_extract(${source}, ${path}), 0) ${arithmetic} ${bound})`
      , positional, {
        // A present-but-non-numeric field is an error in MongoDB, and was
        // silent data loss here (SQLite reads 'hello' + 1 as 1).
        test: nonNumericAt,
        message: `Cannot apply ${operator} to a value of non-numeric type (field ${field})`
      })
    }
  }

  // --- $bit ---------------------------------------------------------------
  for (const [field, bits] of operand('$bit')) {
    const operations = bitOperations(field, bits)
    expr = applyFieldWrite(expr, '$bit', field, (target, source, path) => {
      // A missing field starts from 0, so `$bit: { x: { or: 4 } }` creates it
      // as 4 - which is what the server does.
      let value = `COALESCE(json_extract(${source}, ${path}), 0)`
      for (const [operation, mask] of operations) {
        const bound = `CAST(${bindRaw(bindings, mask)} AS INTEGER)`
        // SQLite has no XOR operator, so it is spelled out of the two it does
        // have. The identity holds in two's complement and cannot overflow:
        // every bit of (a & b) is already a bit of (a | b).
        value = operation === 'and'
          ? `(${value} & ${bound})`
          : operation === 'or' ? `(${value} | ${bound})` : `((${value} | ${bound}) & ~(${value} & ${bound}))`
      }
      return `json_set(${target}, ${path}, ${value})`
    }, positional, {
      test: nonIntegerAt,
      message: `Cannot apply $bit to a value of non-integral type (field ${field})`
    })
  }

  // --- $min / $max --------------------------------------------------------
  for (const [operator, takeWhen] of [['$min', '>'], ['$max', '<']] as const) {
    for (const [field, value] of operand(operator)) {
      const [candidateRank, candidateValue] = comparableValue(value)
      const replacement = bindJson(bindings, value)
      const boundRank = bindRaw(bindings, candidateRank)
      const boundValue = bindRaw(bindings, candidateValue)
      expr = applyFieldWrite(expr, operator, field, (target, source, path) => {
        const datePath = datePathOf(path)
        const typeExpr = `json_type(${source}, ${path})`
        const dateExpr = `json_extract(${source}, ${datePath})`
        const binExpr = `json_extract(${source}, ${path.slice(0, -1)}.$binary')`
        const rank = bsonRankSql(typeExpr, dateExpr, binExpr)
        const current = bsonValueSql(typeExpr, `json_extract(${source}, ${path})`, dateExpr)
        // Row values let the (rank, value) pair compare in one shot, which is
        // what makes this follow BSON order rather than SQLite's.
        return `json_set(${target}, ${path}, CASE ` +
          `WHEN ${typeExpr} IS NULL THEN ${replacement} ` +
          `WHEN (${rank}, ${current}) ${takeWhen} (${boundRank}, ${boundValue}) THEN ${replacement} ` +
          `ELSE json_quote(json_extract(${source}, ${path})) END)`
      }, positional)
    }
  }

  // --- $unset -------------------------------------------------------------
  // The plain paths are removed in ONE json_remove, as they always were; a
  // positional $unset has to go through the rebuild instead.
  const unsetPaths = operand('$unset')
    .filter(([field]) => parsePositional('$unset', field) === undefined)
    .map(([field]) => toJson1PathString([field]))
  if (unsetPaths.length > 0) expr = `json_remove(${expr}, ${unsetPaths.join(', ')})`
  for (const [field] of operand('$unset')) {
    const unsetTarget = parsePositional('$unset', field)
    if (unsetTarget === undefined) continue
    // MongoDB leaves a NULL behind when $unset targets an array element rather
    // than shortening the array. Decided from the parsed target, not from the
    // shape of the path: a field genuinely named 'f' spells the same path.
    const elementItself = unsetTarget.suffix === ''
    expr = applyFieldWrite(expr, '$unset', field, (target, _source, path) =>
      elementItself ? `json_set(${target}, ${path}, json('null'))` : `json_remove(${target}, ${path})`
    , positional)
  }

  // --- $set ---------------------------------------------------------------
  for (const [field, value] of operand('$set')) {
    const bound = bindJson(bindings, value)
    expr = applyFieldWrite(expr, '$set', field, (target, _source, path) =>
      `json_set(${target}, ${path}, ${bound})`
    , positional)
  }

  // --- $currentDate -------------------------------------------------------
  // One timestamp for the whole statement, so every document an `updateMany`
  // touches gets the same instant - which is both cheaper and easier to reason
  // about than one clock read per row.
  const now = new Date()
  for (const [field, spec] of operand('$currentDate')) {
    assertCurrentDateSpec(field, spec)
    const bound = bindJson(bindings, now)
    expr = applyFieldWrite(expr, '$currentDate', field, (target, _source, path) =>
      `json_set(${target}, ${path}, ${bound})`
    , positional)
  }

  // $setOnInsert contributes no SQL - it only shapes the document an upsert
  // inserts - but its operand is validated above by updateTargets.

  // --- $push --------------------------------------------------------------
  for (const [field, pushed] of operand('$push')) {
    parsePositional('$push', field) // rejects a positional path with a clear message
    const spec = eachSpec('$push', field, pushed)
    // The whole $each list is bound as ONE json array and appended with a
    // UNION ALL, rather than as a json_insert per value. The obvious chain
    // nests one call per element, and SQLite's parser gives up at a few
    // hundred: `$push: { a: { $each: [...900 items] } }` failed with
    // "Recursion limit". This form is flat however long the list is.
    const values = bindJson(bindings, spec.values)
    const existing = `SELECT json_each.value AS v, json_each.type AS t FROM json_each(${arrayAt(field)})`
    const appended = `SELECT json_each.value AS v, json_each.type AS t FROM json_each(${values})`

    let array: string
    if (spec.position === undefined) {
      array = groupArray(`${existing} UNION ALL ${appended}`)
    } else {
      // $position inserts mid-array, so the three runs (elements before the
      // insert point, the new values, elements after it) are ordered
      // explicitly. UNION ALL alone does not promise an order, and here the
      // order IS the feature.
      const at = spec.position >= 0
        ? bindRaw(bindings, spec.position)
        // A negative position counts back from the end, clamped at the start.
        : `MAX(json_array_length(${arrayAt(field)}) + ${bindRaw(bindings, spec.position)}, 0)`
      array = groupArray(
        `SELECT v, t FROM (${positionRun(arrayAt(field), 0, ` WHERE json_each.key < ${at}`)} UNION ALL ` +
        `${positionRun(values, 1)} UNION ALL ` +
        `${positionRun(arrayAt(field), 2, ` WHERE json_each.key >= ${at}`)}) ORDER BY g, k`
      )
    }

    expr = `json_set(${ensureParents(expr, field)}, ${toJson1PathString([field])}, ${applyEachModifiers(array, spec)})`
    guards.push(...traversalGuards(field))
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
    guards.push(...traversalGuards(field))
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

  // MongoDB rejects an arrayFilters entry no path uses - it is nearly always a
  // typo in one identifier or the other, and silently ignoring it would leave
  // the update doing something other than what was asked.
  const unused = arrayFilters.findIndex((_entry, index) => !positional.usedArrayFilters.has(index))
  if (unused !== -1) {
    throw Error(
      `The array filter for identifier '${[...identifiersIn(arrayFilters[unused]!)][0] ?? ''}' ` +
      'was not used in the update document'
    )
  }

  const guardSql = guards.length === 0
    ? undefined
    : `CASE ${guards.map((guard, index) => `WHEN ${guard.test} THEN ${index}`).join(' ')} END`

  return {
    sql: expr,
    params: bindings.values,
    guards,
    guardParams: guardBindings.values,
    ...(guardSql === undefined ? {} : { guardSql })
  }
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
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    value instanceof Date || value instanceof Uint8Array) {
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
  if (value instanceof Date) return [7, value.toISOString()]
  // Encoded first, so the wrapper text is what compares - the same text
  // bsonValueSql's ELSE arm reads back out of a stored one.
  if (value instanceof Uint8Array) return [5, JSON.stringify(encodeValue(value))]
  if (Array.isArray(value)) return [4, JSON.stringify(value)]
  if (typeof value === 'boolean') return [6, value ? 1 : 0]
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

/** Reads a dotted path out of a document, or undefined when any level is missing. */
function getPath (doc: Document, field: string): unknown {
  let node: any = doc
  for (const segment of field.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = ownField(node, segment)
  }
  return node
}

/** Removes a dotted path from a document. */
function deletePath (doc: Document, field: string): void {
  const segments = field.split('.')
  let node: any = doc
  for (const segment of segments.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return
    node = ownField(node, segment)
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
  // Every field starts out missing, which $bit reads as 0.
  for (const [field, operand] of Object.entries((update.$bit ?? {}) as Record<string, unknown>)) {
    let value = 0n
    for (const [operation, mask] of bitOperations(field, operand)) {
      const bits = BigInt(mask)
      value = operation === 'and' ? value & bits : operation === 'or' ? value | bits : value ^ bits
    }
    setPath(doc, field, Number(BigInt.asIntN(64, value)))
  }
  const upsertedAt = new Date()
  for (const [field, spec] of Object.entries((update.$currentDate ?? {}) as Record<string, unknown>)) {
    assertCurrentDateSpec(field, spec)
    setPath(doc, field, upsertedAt)
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
