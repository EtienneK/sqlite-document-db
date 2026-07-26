import { encodeValue } from './ejson.js'
import { assertKnownExpressionOperators } from './expression.js'

export type QueryFilterDocument = Record<string, any>

/** The named parameters accompanying a compiled SQL fragment. */
export type SqlParams = Record<string, string | number | null>

/**
 * Mutable named-parameter registry shared by every context of one compilation.
 *
 * The prefix keeps independently-compiled fragments from colliding when they
 * end up in ONE statement: an UPDATE carries its filter's `p0...` and its
 * update expression's `u0...` side by side (see src/update.ts).
 */
export interface SqlBindings {
  n: number
  values: SqlParams
  prefix: string
}

/** A fresh parameter registry. `prefix` names the parameters it hands out. */
export function createBindings (prefix = 'p'): SqlBindings {
  return { n: 0, values: {}, prefix }
}

/**
 * Compilation context threaded through the converter.
 *
 * `col` is the SQL source holding the document ('data' for collection tables,
 * 'valueJson' inside $elemMatch subqueries). `table` is the collection table
 * when the expression is being built for a top-level statement - it enables
 * the indexable rowid-union form of implicit array matching (see
 * withElementMatch). Nested contexts have no table and fall back to a flat OR,
 * but always share the top-level context's `bindings`.
 */
interface SqlContext {
  col: string
  table?: string
  bindings: SqlBindings
  /** How many array levels of a dotted path have already been expanded. */
  arrayPathDepth?: number
  /** $elemMatch nesting level, which keeps each level's column alias unique. */
  elemMatchDepth?: number
  /** Reject constructs whose answer is known to differ from MongoDB's. */
  strict?: boolean
}

// Only PATHS are ever rendered as string literals. Values go through
// bindValue - if you are about to quoteLiteral() a user-supplied value, stop.
function quoteLiteral (str: string): string {
  return "'" + str.replace(/'/g, "''") + "'"
}

/**
 * Quotes a SQL identifier (table, column). Exported because table and index
 * names are interpolated in src/index.ts too, and one escaping routine for the
 * whole project is one place to get it right.
 */
export function quoteIdentifier (name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

/**
 * Registers a user-supplied value as a named parameter and returns the SQL
 * fragment referencing it (BACKLOG item 9: values are bound, never
 * interpolated). Named - not positional - parameters, because compiled
 * fragments get reused: the same token can appear in both arms of the
 * implicit-array union, or twice in an UPDATE's `SET x WHERE x != ...`, and
 * SQLite binds it once regardless of how often it occurs.
 *
 * Booleans bind as 1/0 (SQLite cannot bind a boolean, and json_extract
 * yields 1/0 for JSON true/false anyway). Objects, arrays and Dates are
 * encoded exactly as the storage layer encodes them (see src/ejson.ts) so
 * comparisons against stored values line up byte for byte.
 */
function bindValue (ctx: SqlContext, value: any): string {
  if (value === undefined) throw Error('cannot use undefined as a query value; use null instead')
  const name = `${ctx.bindings.prefix}${ctx.bindings.n++}`
  if (typeof value === 'boolean') {
    ctx.bindings.values[name] = value ? 1 : 0
    return `:${name}`
  }
  if (typeof value === 'string' || typeof value === 'number' || value === null) {
    ctx.bindings.values[name] = value
    return `:${name}`
  }
  ctx.bindings.values[name] = JSON.stringify(encodeValue(value))
  return `json(:${name})`
}

/**
 * Encodes a JS value exactly as the storage layer does and returns the SQL
 * fragment referencing it. For the update operators in src/update.ts: written
 * values must be encoded by the same code that encodes query values and stored
 * documents. Always json()-wrapped so json_set stores real JSON types (a bound
 * bare 1 would store the number 1 where `true` was meant).
 */
export function bindJson (bindings: SqlBindings, value: any): string {
  const name = `${bindings.prefix}${bindings.n++}`
  bindings.values[name] = JSON.stringify(encodeValue(value))
  return `json(:${name})`
}

/**
 * Binds a primitive as itself rather than as JSON. Only for values compared
 * against what `json_extract` yields - which is a SQL scalar, not JSON text
 * (see the $min/$max ordering comparison in src/update.ts).
 */
export function bindRaw (bindings: SqlBindings, value: string | number | null): string {
  const name = `${bindings.prefix}${bindings.n++}`
  bindings.values[name] = value
  return `:${name}`
}

// Exported so createIndex() builds index paths with the SAME code that builds
// query paths - if these ever diverge, indexes silently stop matching queries.
// Paths stay string LITERALS deliberately: SQLite only matches an expression
// index whose indexed expression is textually identical, so a bound
// json_extract(data, :path) would never use an index.
//
// `suffix` appends an array subscript ('[#]', '[0]', '[#-1]') for the array
// update operators. It is never user data - only one of those three literals.
export function toJson1PathString (pathArr: string[], suffix = ''): string {
  const firstDot = (pathArr.length === 1 && pathArr[0] === '') ? '' : '.'
  return quoteLiteral(`$${firstDot}${pathArr.join('.').replace(/\.(\d+)/g, '[$1]')}${suffix}`)
}

function toJson1Extract (col: string, pathArr: string[]): string {
  if (pathArr === undefined || pathArr.length === 0) return quoteIdentifier(col)
  return `json_extract(${quoteIdentifier(col)}, ${toJson1PathString(pathArr)})`
}

/** `json_extract(<col>, '$.<field>')` - the value stored at one field path. */
function extract (ctx: SqlContext, field: string): string {
  return toJson1Extract(ctx.col, [field])
}

/** `json_type(<col>, '$.<field>')` - NULL when the path is absent. */
function jsonType (ctx: SqlContext, field: string): string {
  return `json_type(${quoteIdentifier(ctx.col)}, ${toJson1PathString([field])})`
}

const OPS = {
  // Comparison Query Operators
  $eq: 'is',
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
  $ne: 'is not',
  $in: 'IN',
  $nin: 'NOT IN',
  // Logical Query Operators
  $and: 'AND',
  $or: 'OR',
  $not: 'NOT',
  $nor: 'OR',
  // Element Query Operators
  $exists: null,
  $type: null,
  // Evaluation Query Operators
  $regex: null,
  $options: null,
  $mod: null,
  // Array Query Operators
  $all: null,
  $elemMatch: null,
  $size: null,
  // Bitwise Query Operators
  $bitsAllSet: null,
  $bitsAnySet: null,
  $bitsAllClear: null,
  $bitsAnyClear: null
}
const OPS_KEYS = Object.keys(OPS)

/**
 * The only operators MongoDB accepts as a KEY of a filter document (as opposed
 * to a key of a field's criterion object). `{ $gt: 5 }` or `{ $not: {...} }` at
 * that position is "unknown top level operator" on the server - and here it was
 * worse than an error: `$not` recursed into itself until the stack blew.
 *
 * `$expr` belongs here and NOT in `OPS`: it takes an aggregation expression
 * rather than a field criterion, so `{ qty: { $expr: ... } }` has to stay the
 * error it is on the server.
 */
const TOP_LEVEL_OPS_KEYS = new Set(['$and', '$or', '$nor', '$expr'])

/**
 * Filter-document operators that are DECIDED against rather than merely absent,
 * each with the reason and the thing to reach for instead. A caller who writes
 * one of these is asking a real question, and "unknown top level operator" does
 * not answer it.
 */
const REFUSED_TOP_LEVEL_OPS: Record<string, string> = {
  $text: '$text is not supported: it needs a stemming full-text index, and SQLite\'s FTS5 stemmer ' +
    'does not agree with MongoDB\'s, so the two would return different documents for the same query ' +
    '- which is the one thing this library will not do quietly. Use $regex for substring matching, ' +
    'or build an FTS5 table of your own through db.sql, where the tokenizer is your choice',
  $where: '$where is not supported, and will not be: it executes arbitrary JavaScript against every ' +
    'document. Use $expr, which covers the same comparisons without running code'
}

/**
 * Normalizes $regex input (a RegExp or a pattern string, optionally with a
 * separate $options string) to a single RegExp, validating the pattern and
 * flags in the process. MongoDB's 'x' (extended) option has no JavaScript
 * equivalent and is rejected; 'g'/'y' are stateful in JavaScript (test()
 * advances lastIndex, skipping rows) and are stripped.
 */
function toRegExp (pattern: unknown, options?: unknown): RegExp {
  let source: string
  let flags: string
  if (pattern instanceof RegExp) {
    source = pattern.source
    flags = pattern.flags
  } else if (typeof pattern === 'string') {
    source = pattern
    flags = ''
  } else {
    throw Error('$regex has to be a string or a RegExp')
  }
  if (options !== undefined) {
    if (typeof options !== 'string') throw Error('$options has to be a string')
    if (flags !== '' && options !== '') throw Error('options set in both $regex and $options')
    flags = options
  }
  if (flags.includes('x')) throw Error('$options flag "x" (extended) is not supported')
  return new RegExp(source, flags.replace(/[gy]/g, ''))
}

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

// BSON type codes -> name aliases, per https://www.mongodb.com/docs/manual/reference/operator/query/type/
const TYPE_ALIAS_BY_CODE: Record<number, string> = {
  1: 'double', 2: 'string', 3: 'object', 4: 'array', 5: 'binData', 6: 'undefined', 7: 'objectId', 8: 'bool', 9: 'date', 10: 'null', 11: 'regex', 12: 'dbPointer', 13: 'javascript', 14: 'symbol', 15: 'javascriptWithScope', 16: 'int', 17: 'timestamp', 18: 'long', 19: 'decimal', '-1': 'minKey', 127: 'maxKey'
}

// Valid aliases for types the storage layer cannot hold (rejected at write
// time, see src/ejson.ts) - $type accepts them but they can never match.
const UNSTORABLE_TYPE_ALIASES = new Set(['binData', 'undefined', 'objectId', 'regex', 'dbPointer', 'javascript', 'symbol', 'javascriptWithScope', 'timestamp', 'long', 'decimal', 'minKey', 'maxKey'])

/**
 * One $type alias as a predicate over SQLite's JSON type system.
 *
 * `typeExpr`/`valueExpr`/`dateExpr` are SQL expressions for json_type of the
 * value, the value itself, and its `.$date` sub-path (NULL when not a date
 * wrapper). Number aliases follow the driver's serialization rule - an
 * integral JS number becomes int32 when it fits, double otherwise - so 'int'
 * is bracketed to the int32 range and out-of-range integers count as doubles.
 * 'long' can never match: the driver only produces it for BigInt/Long, which
 * the storage layer rejects.
 */
function typePredicate (typeExpr: string, valueExpr: string, dateExpr: string, alias: string): string {
  switch (alias) {
    case 'double': return `(${typeExpr} = 'real' OR (${typeExpr} = 'integer' AND (${valueExpr} < ${INT32_MIN} OR ${valueExpr} > ${INT32_MAX})))`
    case 'string': return `${typeExpr} = 'text'`
    case 'object': return `(${typeExpr} = 'object' AND ${dateExpr} IS NULL)`
    case 'array': return `${typeExpr} = 'array'`
    case 'bool': return `${typeExpr} IN ('true','false')`
    case 'date': return `${dateExpr} IS NOT NULL`
    case 'null': return `${typeExpr} = 'null'`
    case 'int': return `(${typeExpr} = 'integer' AND ${valueExpr} >= ${INT32_MIN} AND ${valueExpr} <= ${INT32_MAX})`
    case 'number': return `${typeExpr} IN ('integer','real')`
    default:
      if (UNSTORABLE_TYPE_ALIASES.has(alias)) return 'FALSE'
      throw Error(`Unknown type name alias: ${alias}`)
  }
}

function resolveTypeAlias (value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    const alias = TYPE_ALIAS_BY_CODE[value]
    if (alias === undefined) throw Error(`Invalid numerical type code: ${String(value)}`)
    return alias
  }
  throw Error('type must be represented as a number or a string')
}

function countOps (keys: string[]): number {
  return keys.filter(k => OPS_KEYS.includes(k)).length
}

/**
 * MongoDB's implicit array matching: `{ tags: 'B' }` matches a document whose
 * `tags` IS 'B' or whose `tags` is an ARRAY containing 'B' - and the same rule
 * applies to the comparison operators and $in/$nin.
 *
 * `elemPred` is a predicate over json_each's `value` column. The json_type
 * guard restricts iteration to actual arrays: json_each would otherwise yield
 * a row for a scalar (double-matching it) or iterate an object's values
 * (matching things MongoDB does not).
 */
function elementMatch (ctx: SqlContext, field: string, elemPred: string): string {
  const path = toJson1PathString([field])
  const fieldValue = extract(ctx, field)
  // Leading bracket-range predicate: JSON arrays extract as text starting
  // with '[', so `>= '[' AND < '\'` selects exactly the array-valued rows
  // USING THE SAME expression index the scalar arm uses (numbers sort before
  // text, objects start with '{'). Strings that happen to start with '[' slip
  // into the range; the json_type check filters them back out.
  return `(${fieldValue} >= '[' AND ${fieldValue} < '\\' AND ${jsonType(ctx, field)} = 'array' AND EXISTS (SELECT 1 FROM json_each(${quoteIdentifier(ctx.col)}, ${path}) WHERE ${elemPred}))`
}

/**
 * Combines the scalar predicate with the array-element arm.
 *
 * At the top level this compiles to `rowid IN (SELECT ... UNION ALL SELECT ...)`
 * rather than a flat OR: SQLite never applies its OR-optimization to
 * expression indexes (measured - even `a = 1 OR b = 2` over two indexed
 * expressions scans), but each UNION ALL arm plans independently, so both the
 * scalar arm and the array arm's bracket-range predicate can use the field's
 * expression index (measured: 0.45ms vs 9ms scan on 20k rows). UNION ALL, not
 * UNION: `IN` deduplicates anyway and the dedup sort blocked arm indexing.
 * The rowid set also sidesteps three-valued logic: a row is either in it or
 * not, so `NOT (...)` behaves exactly like MongoDB's complement semantics.
 */
function withElementMatch (ctx: SqlContext, scalarPred: string, ...elemArms: string[]): string {
  const arms = [scalarPred, ...elemArms]
  if (arms.length === 1) return `(${arms[0]!})`
  if (ctx.table === undefined) return `(${arms.join(' OR ')})`
  return `rowid IN (${arms.map(arm => `SELECT rowid FROM ${ctx.table} WHERE ${arm}`).join(' UNION ALL ')})`
}

/**
 * MongoDB descends into arrays at EVERY level of a dotted path, not just the
 * last: `{ 'instock.qty': 5 }` matches a document whose `instock` is an array
 * of documents one of which has `qty: 5`. `json_extract(data,'$.instock.qty')`
 * is NULL for that document, so the plain path alone finds nothing.
 *
 * Each split of the path contributes one arm, expressed as `$elemMatch` on the
 * prefix - which already means "some element of this array matches" and is
 * already tested. `{ 'a.b.c': X }` therefore also tries
 * `{ a: { $elemMatch: { 'b.c': X } } }` and `{ 'a.b': { $elemMatch: { c: X } } }`.
 *
 * The arms join through withElementMatch, so this stays a rowid union rather
 * than a flat OR and the plain arm remains index-eligible - a dotted path over
 * an indexed field must not lose its index just because an array MIGHT be
 * there.
 *
 * Arms expand again, once, so a path can cross TWO array levels
 * (`a: [{ b: [{ c: 9 }] }]`). It must be bounded: $elemMatch re-wraps its
 * element as `{ f: ... }`, so the inner path is `f.b.c` and splitting it at
 * `f` regenerates the same shape forever. MAX_ARRAY_PATH_DEPTH is what stops
 * that; deeper nesting than this needs an explicit $elemMatch.
 */
function arrayPathArms (ctx: SqlContext, field: string, op: string, value: any): string[] {
  const segments = field.split('.')
  const criterion = op === '$eq' ? value : { [op]: value }
  const inner: SqlContext = { ...ctx, arrayPathDepth: (ctx.arrayPathDepth ?? 0) + 1 }
  const arms: string[] = []
  for (let i = 1; i < segments.length; i++) {
    // A numeric segment is an array INDEX, which addresses one element rather
    // than asking for any of them - json_extract already handles it.
    if (/^\d+$/.test(segments[i]!)) continue
    arms.push(convertOp(inner, segments.slice(0, i).join('.'), '$elemMatch', {
      [segments.slice(i).join('.')]: criterion
    }))
  }
  return arms
}

/**
 * How many array levels a dotted path may cross. Two covers
 * `a: [{ b: [{ c: 1 }] }]`; the bound exists because the expansion is
 * self-similar and would otherwise not terminate (see arrayPathArms).
 */
const MAX_ARRAY_PATH_DEPTH = 2

/**
 * One array element, re-wrapped as `{ "f": <element> }` so the ordinary
 * field-path machinery can address it.
 *
 * json_quote, not json(): a string element's `value` is bare text, which
 * json() rejects as malformed JSON, while json_quote encodes scalars and
 * passes objects and arrays through via the JSON subtype.
 */
const ELEMENT_WRAPPER = "json_object('f', json_quote(value))"

/**
 * Compiles a per-element criterion into a predicate over a column holding
 * `ELEMENT_WRAPPER` - the shape `$elemMatch` and `$pull` (src/update.ts) both
 * need, which is why it lives here rather than inside the `$elemMatch` case.
 *
 * An operator key (`$gte`, `$lt`, ...) constrains the ELEMENT itself, so it
 * targets `f`; any other key is a field path *inside* the element and targets
 * `f.<key>`. Getting that distinction wrong made `$elemMatch` compare every
 * element against the whole criterion object. `$regex` and its companion
 * `$options` must stay together in one criterion rather than being split into
 * two ANDed terms.
 *
 * An empty criterion matches every element that is a document or an array -
 * verified against MongoDB, which returns nothing for `[1]` and matches `[{}]`,
 * `[{a:1}]` and `[[1]]`. (A stored Date is an 'object' to SQLite but a scalar
 * to MongoDB, so the wrapper is excluded.)
 */
export function elementCriterionSql (
  alias: string, criterion: QueryFilterDocument, bindings: SqlBindings,
  depths: { arrayPathDepth?: number, elemMatchDepth?: number } = {}
): string {
  const regexPair: Record<string, unknown> = {}
  const $and: QueryFilterDocument[] = []
  for (const [key, value] of Object.entries(criterion)) {
    if (key === '$regex' || key === '$options') {
      regexPair[key] = value
      continue
    }
    $and.push(OPS_KEYS.includes(key) ? { f: { [key]: value } } : { [`f.${key}`]: value })
  }
  if (Object.keys(regexPair).length > 0) $and.push({ f: regexPair })

  if ($and.length === 0) {
    return "(json_each.type = 'array' OR (json_each.type = 'object' AND json_extract(json_each.value, '$.$date') IS NULL))"
  }
  return convert({ col: alias, bindings, ...depths }, { $and })
}

/** Operators that address a field's VALUE, and so follow the array-path rule. */
const ARRAY_PATH_OPS = new Set([
  '$eq', '$gt', '$gte', '$lt', '$lte', '$in', '$regex', '$mod', '$type', '$exists', '$size', '$all', '$elemMatch',
  '$bitsAllSet', '$bitsAnySet', '$bitsAllClear', '$bitsAnyClear'
])

/**
 * The bitmask a `$bits*` operator tests with, as a SIGNED 64-bit decimal string.
 *
 * A string, because that is the only way to get an exact 64-bit integer through
 * a bound parameter: bit 62 is already past `Number.MAX_SAFE_INTEGER`, so a JS
 * number would silently lose precision on the way in. SQLite parses the decimal
 * text back into an exact INTEGER on the other side of `CAST`.
 *
 * Both of MongoDB's spellings are accepted: a bitmask number, or an array of
 * bit POSITIONS. BinData is the third, and cannot be stored here at all.
 */
function bitMaskLiteral (op: string, value: unknown): string {
  let mask: bigint
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw Error(`${op} takes a non-negative whole number bitmask, or an array of bit positions; but got: ${value}`)
    }
    mask = BigInt(value)
  } else if (Array.isArray(value)) {
    mask = 0n
    for (const position of value) {
      if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > 63) {
        throw Error(`${op} bit positions must be whole numbers from 0 to 63; but got: ${String(position)}`)
      }
      mask |= 1n << BigInt(position)
    }
  } else {
    throw Error(`${op} takes a bitmask number or an array of bit positions; but got: ${typeof value}`)
  }
  // SQLite's INTEGER is signed, so bit 63 is the sign bit - asIntN gives the
  // value SQLite will actually hold rather than one it would clamp.
  return BigInt.asIntN(64, mask).toString()
}

/** The comparison each `$bits*` operator makes against `<value> & <mask>`. */
function bitPredicate (op: string, valueExpr: string, maskExpr: string): string {
  const masked = `(CAST(${valueExpr} AS INTEGER) & ${maskExpr})`
  switch (op) {
    case '$bitsAllSet': return `${masked} = ${maskExpr}`
    case '$bitsAnySet': return `${masked} != 0`
    case '$bitsAllClear': return `${masked} = 0`
    default: return `${masked} != ${maskExpr}` // $bitsAnyClear
  }
}

function convertOp (ctx: SqlContext, field: string, op: string, value: any): string {
  if (ctx.strict === true && field.includes('.') && ARRAY_PATH_OPS.has(op)) {
    // Only MAX_ARRAY_PATH_DEPTH array levels are expanded, so a longer path
    // matches strictly fewer documents than MongoDB would if the extra levels
    // turn out to hold arrays. Nothing here can tell whether they do.
    const crossings = field.split('.').slice(1).filter(segment => !/^\d+$/.test(segment)).length
    if (crossings > MAX_ARRAY_PATH_DEPTH) {
      throw Error(
        `strict: the path '${field}' could cross more than ${MAX_ARRAY_PATH_DEPTH} array levels, ` +
        'which this library does not expand - rewrite it with an explicit $elemMatch'
      )
    }
  }

  // A dotted path may cross an array at any level (see arrayPathArms). The
  // negative operators are deliberately absent from ARRAY_PATH_OPS: they are
  // the complement of their positive twin and already delegate to it, so
  // expanding them here would OR arms into a negation and invert the meaning.
  if ((ctx.arrayPathDepth ?? 0) < MAX_ARRAY_PATH_DEPTH && field.includes('.') && ARRAY_PATH_OPS.has(op)) {
    const arms = arrayPathArms(ctx, field, op, value)
    if (arms.length > 0) {
      const plain = convertOp({ ...ctx, arrayPathDepth: MAX_ARRAY_PATH_DEPTH }, field, op, value)
      return withElementMatch(ctx, plain, ...arms)
    }
  }

  switch (op) {
    // ---------------------- Comparison Query Operators ----------------------
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
    case '$ne':
    case '$eq': {
      if (value instanceof RegExp) {
        // MongoDB distinguishes these: { field: /re/ } pattern-matches (and
        // reaches convertOp as $regex, not $eq), while an EXPLICIT $eq against
        // a regex only matches stored regex values - which cannot exist here.
        // The other comparison operators reject regex arguments, as MongoDB does.
        if (op === '$eq') return 'FALSE'
        throw Error(`Can't have RegEx as arg to ${op}`)
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'object' && typeof value !== 'boolean') {
        throw Error(`${op} expects value to be of type: number | string | boolean | object | null; but got: ${typeof value}`)
      }
      // MongoDB's $ne is the exact complement of the whole $eq match: it
      // excludes documents whose field equals the value AND documents whose
      // array field contains it, keeping everything else including missing
      // fields. Delegating rather than rebuilding that predicate also gives
      // $ne the dotted-array-path expansion for free. This has to happen
      // BEFORE any bindValue call below, or the parameter allocated here is
      // orphaned and SQLite rejects the statement with "unknown parameter".
      if (op === '$ne') return `NOT (${convertOp(ctx, field, '$eq', value)})`

      // Dates are stored as {"$date": "<ISO>"} (see src/ejson.ts), so date
      // comparisons target the wrapped string one level down. ISO-8601 UTC
      // strings order lexicographically, which makes range operators work.
      const isDate = value instanceof Date
      const extractField = isDate ? `${field}.$date` : field
      const extractValue = isDate ? value.toISOString() : (value as string | number | boolean | object | null)
      const elemValue = isDate ? `json_extract(value, '$.$date')` : 'value'
      const boundValue = bindValue(ctx, extractValue)


      // Range operators need type bracketing, like MongoDB's: a number query
      // must not match strings/arrays/objects. Without this, SQLite's type
      // ordering (numbers < text) makes `extract > 25` true for EVERY array
      // or object field, since those extract as text ('[...', '{...').
      let scalarTypeGuard = ''
      let elemTypeGuard = ''
      if (op !== '$eq' && !isDate) {
        if (typeof value === 'number') {
          scalarTypeGuard = ` AND ${jsonType(ctx, field)} IN ('integer','real')`
          elemTypeGuard = " AND json_each.type IN ('integer','real')"
        } else if (typeof value === 'string') {
          scalarTypeGuard = ` AND ${jsonType(ctx, field)} = 'text'`
          elemTypeGuard = " AND json_each.type = 'text'"
        }
      }

      // Have to put this in for $not operator, otherwise $not doesn't work for null/undefined fields
      const notNull = op === '$eq' ? '' : `AND ${extract(ctx, extractField)} IS NOT NULL`
      const scalarPred = `${extract(ctx, extractField)} ${OPS[op]} ${boundValue} ${notNull}${scalarTypeGuard}`
      const elemPred = `${elemValue} ${OPS[op]} ${boundValue}${elemTypeGuard}`
      return withElementMatch(ctx, scalarPred, elementMatch(ctx, field, elemPred))
    }
    case '$in': {
      if (!Array.isArray(value)) throw Error(`$in expects value to be of type: array; but got: ${typeof value}`)
      // A Date in the list needs a different extract path than the scalar
      // values, and a RegExp means "or matches this pattern" - neither fits
      // the SQL list form, so rewrite as an OR of per-value queries, which is
      // what $in means anyway.
      if (value.some(element => element instanceof Date || element instanceof RegExp)) {
        return convert(ctx, { $or: value.map(element => ({ [field]: element })) })
      }
      if (value.length === 0) return 'FALSE' // $in on an empty list matches nothing
      const list = `(${value.map(element => bindValue(ctx, element)).join(',')})`
      const scalarNull = value.includes(null) ? ` OR ${extract(ctx, field)} IS NULL` : ''
      const elemNull = value.includes(null) ? ' OR value IS NULL' : ''
      const scalarPred = `${extract(ctx, field)} IN ${list}${scalarNull}`
      const elemPred = `value IN ${list}${elemNull}`
      return withElementMatch(ctx, scalarPred, elementMatch(ctx, field, elemPred))
    }
    case '$nin': {
      if (!Array.isArray(value)) throw Error(`$nin expects value to be of type: array; but got: ${typeof value}`)
      // $nin is the exact complement of $in (matching missing fields too),
      // which NOT over the union/flat form gives us directly.
      if (value.some(element => element instanceof Date || element instanceof RegExp)) {
        return convert(ctx, { $nor: value.map(element => ({ [field]: element })) })
      }
      return `NOT (${convertOp(ctx, field, '$in', value)})`
    }
    // ---------------------- Logical Query Operators ----------------------
    case '$nor':
    case '$or':
    case '$and': {
      if (!Array.isArray(value)) throw Error(`${op} expects value to be of type: array; but got: ${typeof value}`)
      // MongoDB rejects an empty list; without this the join below emits `(())`.
      if (value.length === 0) throw Error(`${op} expects a non-empty array`)
      return `${op === '$nor' ? 'NOT' : ''} ((${value
        .map(q => convert(ctx, q))
        .join(`) ${OPS[op]} (`)}))`
    }
    case '$not': {
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        throw Error(`${op} expects value to be of type: non-array-object; but got: ${typeof value}`)
      }
      return `${OPS[op]}(${convert(ctx, { [field]: value })})`
    }
    // ---------------------- Evaluation Query Operators ----------------------
    case '$regex': {
      const regex = toRegExp(value)
      const pattern = bindValue(ctx, regex.source)
      const flags = bindValue(ctx, regex.flags)
      // mdb_regexp is the JS-backed SQL function Db.fromUrl registers on the
      // connection. The 'text' guards keep objects/arrays/numbers away from
      // it: json_extract renders compound values as JSON text, which MongoDB
      // would never regex-match.
      const scalarPred = `${jsonType(ctx, field)} = 'text' AND mdb_regexp(${pattern}, ${flags}, ${extract(ctx, field)})`
      const elemPred = `json_each.type = 'text' AND mdb_regexp(${pattern}, ${flags}, value)`
      return withElementMatch(ctx, scalarPred, elementMatch(ctx, field, elemPred))
    }
    case '$mod': {
      if (!Array.isArray(value)) throw Error('malformed mod, needs to be an array')
      if (value.length < 2) throw Error('malformed mod, not enough elements')
      if (value.length > 2) throw Error('malformed mod, too many elements')
      const [rawDivisor, rawRemainder] = value
      if (typeof rawDivisor !== 'number' || typeof rawRemainder !== 'number' || !Number.isFinite(rawDivisor) || !Number.isFinite(rawRemainder)) {
        throw Error('malformed mod, divisor and remainder must be finite numbers')
      }
      // MongoDB truncates decimal divisor/remainder arguments AND decimal
      // field values toward zero; SQLite's CAST and % do the same.
      const divisor = Math.trunc(rawDivisor)
      const remainder = Math.trunc(rawRemainder)
      if (divisor === 0) throw Error('divisor cannot be 0')
      const boundDivisor = bindValue(ctx, divisor)
      const boundRemainder = bindValue(ctx, remainder)
      const scalarPred = `${jsonType(ctx, field)} IN ('integer','real') AND CAST(${extract(ctx, field)} AS INTEGER) % ${boundDivisor} = ${boundRemainder}`
      const elemPred = `json_each.type IN ('integer','real') AND CAST(value AS INTEGER) % ${boundDivisor} = ${boundRemainder}`
      return withElementMatch(ctx, scalarPred, elementMatch(ctx, field, elemPred))
    }
    // ---------------------- Element Query Operators ----------------------
    case '$type': {
      const aliases = (Array.isArray(value) ? value : [value]).map(resolveTypeAlias)
      if (aliases.length === 0) throw Error('$type must match at least one type')
      if (ctx.strict === true) {
        // These compile to FALSE because the storage layer cannot hold such a
        // value - but a real server holding one WOULD match, so "no results"
        // here is an answer, not a fact about the data.
        const unstorable = aliases.find(alias => UNSTORABLE_TYPE_ALIASES.has(alias))
        if (unstorable !== undefined) {
          throw Error(`strict: $type '${unstorable}' can never match, because this library cannot store that type`)
        }
      }
      const typeExpr = jsonType(ctx, field)
      const valueExpr = extract(ctx, field)
      // The document is always well-formed JSON, so the scalar side can
      // extract the .$date sub-path directly. json_each.value is NOT: a text
      // element is a bare string that json_extract rejects as malformed JSON,
      // so the element side must CASE-guard on the element being an object
      // (CASE evaluates strictly in order; AND terms may be reordered).
      const dateExpr = toJson1Extract(ctx.col, [`${field}.$date`])
      const elemDateExpr = "CASE WHEN json_each.type = 'object' THEN json_extract(json_each.value, '$.$date') END"
      const scalarPred = `(${aliases.map(alias => typePredicate(typeExpr, valueExpr, dateExpr, alias)).join(' OR ')})`
      const elemPred = `(${aliases.map(alias => typePredicate('json_each.type', 'json_each.value', elemDateExpr, alias)).join(' OR ')})`
      return withElementMatch(ctx, scalarPred, elementMatch(ctx, field, elemPred))
    }
    case '$exists': {
      if (typeof value !== 'boolean') throw Error(`$exists expects value to be of type: boolean; but got: ${typeof value}`)
      // json_type is NULL for an absent path and non-NULL for every present
      // one - including JSON null, which MongoDB also counts as existing.
      // (The previous json_each form counted ROWS, so an empty array or
      // empty object reported as not existing, and it could not be indexed.)
      return `${jsonType(ctx, field)} IS ${value ? 'NOT NULL' : 'NULL'}`
    }
    // ---------------------- Array Query Operators ----------------------
    case '$all': {
      if (!Array.isArray(value)) throw Error(`$all expects value to be of type: array; but got: ${typeof value}`)
      if (value.length === 0) return 'FALSE' // MongoDB: $all: [] matches nothing
      // $all is defined as an $and of the values, each matched with the
      // ordinary implicit-array semantics. Delegating gets Dates, regexes and
      // $elemMatch criteria for free, keeps the query index-eligible, and
      // avoids feeding json_each an EXTRACTED value - which raised "malformed
      // JSON" as soon as any row held a bare string at that path.
      return convert(ctx, { $and: value.map(element => ({ [field]: element })) })
    }
    case '$elemMatch': {
      if (Array.isArray(value) || typeof value !== 'object' || value === null) throw Error(`${op} expects value to be of type: non-array-object; but got: ${typeof value}`)
      // json_each takes (document, path), NOT the extracted value: a scalar
      // string field extracts to bare text, which json_each rejects as
      // malformed JSON. The 2-arg form is always safe, and the json_type
      // guard excludes the single self-row json_each yields for scalars
      // ($elemMatch only ever matches actual arrays, like MongoDB).
      // The alias is numbered per nesting level. It used to be plain
      // `valueJson` at every level, so a nested $elemMatch shadowed its
      // parent's alias and matched nothing at all - silently.
      const depth = (ctx.elemMatchDepth ?? 0) + 1
      const alias = `valueJson${depth}`
      const elemPred = elementCriterionSql(alias, value as QueryFilterDocument, ctx.bindings, {
        arrayPathDepth: ctx.arrayPathDepth, elemMatchDepth: depth
      })
      return `(${jsonType(ctx, field)} = 'array' AND EXISTS (select ${ELEMENT_WRAPPER} as ${alias} from json_each(${quoteIdentifier(ctx.col)}, ${toJson1PathString([field])}) where (${elemPred})))`
    }
    // ---------------------- Bitwise Query Operators ----------------------
    case '$bitsAllSet':
    case '$bitsAnySet':
    case '$bitsAllClear':
    case '$bitsAnyClear': {
      const mask = `CAST(${bindValue(ctx, bitMaskLiteral(op, value))} AS INTEGER)`
      // Only whole numbers are testable. A value with a fractional part has no
      // bits to speak of and never matches, which is MongoDB's rule too - and
      // the guard also keeps text and JSON arrays away from the & operator,
      // where SQLite would helpfully coerce them to 0.
      const scalarPred = `${jsonType(ctx, field)} = 'integer' AND ${bitPredicate(op, extract(ctx, field), mask)}`
      const elemPred = `json_each.type = 'integer' AND ${bitPredicate(op, 'value', mask)}`
      return withElementMatch(ctx, scalarPred, elementMatch(ctx, field, elemPred))
    }
    // ---------------------- $expr ----------------------
    case '$expr': {
      // $expr is evaluated in JavaScript, one document at a time, through a
      // registered SQL function - the same shape $regex uses. The alternative
      // was compiling the expression language to SQL, which would be a SECOND
      // implementation of every rule in src/expression.ts (missing vs null,
      // type errors, half-to-even rounding) and would drift from the first.
      //
      // Two consequences, both documented in the README: it cannot use an
      // index, and it needs a driver with user-defined functions.
      if ((ctx.elemMatchDepth ?? 0) > 0) throw Error('$expr is not allowed inside $elemMatch')
      assertKnownExpressionOperators(value)
      // Through the storage encoder, so a Date in the expression survives the
      // trip and comes back as a Date rather than as a string.
      const expression = bindValue(ctx, JSON.stringify(encodeValue(value)))
      return `mdb_expr(${expression}, ${quoteIdentifier(ctx.col)}) = 1`
    }
    case '$size': {
      // MongoDB requires a non-negative whole number, and only ever matches
      // arrays - json_array_length answers 0 for a scalar, so without the type
      // guard `$size: 0` matched every non-array (and every missing) field.
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw Error(`$size expects value to be a non-negative whole number; but got: ${String(value)}`)
      }
      return `(${jsonType(ctx, field)} = 'array' AND json_array_length(${quoteIdentifier(ctx.col)}, ${toJson1PathString([field])}) = ${bindValue(ctx, value)})`
    }
  }

  throw Error('could not convert to SQL string - invalid op: ' + op)
}

function convert (ctx: SqlContext, query: QueryFilterDocument): string {
  const entries = Object.entries(query)

  if (entries.length === 0) return 'TRUE'

  const [field, valueOrOp] = entries[0]!
  let value = valueOrOp
  if (entries.length === 1) {
    // A $-prefixed KEY here is a top-level operator, and only the logical ones
    // are legal there. Anything else is a typo the server would reject, so
    // reject it too rather than searching for a field literally called '$gt'.
    if (field.startsWith('$') && !TOP_LEVEL_OPS_KEYS.has(field)) {
      const refused = REFUSED_TOP_LEVEL_OPS[field]
      if (refused !== undefined) throw Error(refused)
      throw Error(`unknown top level operator: ${field} (expected a field name, or one of ${[...TOP_LEVEL_OPS_KEYS].join(', ')})`)
    }
    const opEqualsField = TOP_LEVEL_OPS_KEYS.has(field)
    let op = opEqualsField ? field : '$eq'

    // A bare RegExp value pattern-matches: { field: /re/ } is MongoDB's
    // implicit form of { field: { $regex: /re/ } }. (An explicit $eq against
    // a regex does NOT pattern-match - convertOp handles that.)
    if (!opEqualsField && valueOrOp instanceof RegExp) {
      return convertOp(ctx, field, '$regex', valueOrOp)
    }

    if (!opEqualsField && typeof valueOrOp === 'object' && valueOrOp !== null) {
      // $options is $regex's companion key, not an operator of its own - the
      // pair must reach convertOp as ONE $regex, not be split into two ANDed
      // criteria by the multi-operator branch below.
      if ('$options' in valueOrOp && !('$regex' in valueOrOp)) throw Error('$options needs a $regex')
      if ('$regex' in valueOrOp) {
        const { $regex, $options, ...rest } = valueOrOp
        const regexSql = convertOp(ctx, field, '$regex', toRegExp($regex, $options))
        if (Object.keys(rest).length === 0) return regexSql
        return `(${regexSql}) AND (${convert(ctx, { [field]: rest })})`
      }
      const valueOrOpKeys = Object.keys(valueOrOp)
      // A criterion object either matches the whole value ({ size: { h: 8 } })
      // or applies operators to it - never both. MongoDB decides by whether it
      // sees $-prefixed keys, and errors on any it does not recognise; without
      // that check a typo like { qty: { $gtt: 5 } } silently became an equality
      // match against the object `{ $gtt: 5 }` and quietly returned nothing.
      const unknownOp = valueOrOpKeys.find(key => key.startsWith('$') && !OPS_KEYS.includes(key))
      if (unknownOp !== undefined) throw Error(`unknown operator: ${unknownOp}`)
      const opCount = countOps(valueOrOpKeys)
      if (opCount > 0 && opCount !== valueOrOpKeys.length) {
        const plainKey = valueOrOpKeys.find(key => !OPS_KEYS.includes(key))!
        throw Error(`unknown operator: ${plainKey} (operators cannot be mixed with plain fields in one criterion)`)
      }
      if (valueOrOpKeys.length === 1 && opCount === 1) {
        // Expressions in the form: { field: { $operator: value } }, where field is not an operator and value is an object
        op = valueOrOpKeys[0]!
        value = value[op]
      } else if (valueOrOpKeys.length > 1 && opCount === valueOrOpKeys.length) {
        // Expressions in the form: { field: { $operator1: value, $operator2: value } }
        return `(${valueOrOpKeys.map(opKey => ({ [field]: { [opKey]: value[opKey] } }))
          .map(q => convert(ctx, q))
          .join(') AND (')})`
      }
    }

    // Expressions in the form: { field: { $operator: value } } OR { field: value }, where field could be an operator
    return convertOp(ctx, field, op, value)
  }

  // Expressions in the form: { field1: value1, field2: value2 }
  return `(${entries.map(([key, entryValue]) => ({ [key]: entryValue }))
    .map(q => convert(ctx, q))
    .join(') AND (')})`
}

/**
 * Compiles a MongoDB filter document to a SQL boolean expression over
 * `columnName`, plus the named parameters (:p0, :p1, ...) it references.
 * User-supplied values are always bound, never interpolated; field paths
 * stay literals (see toJson1PathString). Pass `table` (the collection's
 * table name) for top-level statements so implicit array matching can
 * compile to its indexable form.
 */
export interface CompileOptions {
  /**
   * The collection's table name, for top-level statements. It enables the
   * indexable rowid-union form of implicit array matching.
   */
  table?: string
  /** Share a parameter registry with another fragment in the same statement. */
  bindings?: SqlBindings
  /** Reject constructs whose answer is known to differ from MongoDB's. */
  strict?: boolean
}

export function toSql (
  columnName: string, query: QueryFilterDocument, options: CompileOptions = {}
): { sql: string, params: SqlParams } {
  const bindings = options.bindings ?? createBindings()
  const sql = convert({ col: columnName, table: options.table, bindings, strict: options.strict }, query)
  return { sql, params: bindings.values }
}

/**
 * MongoDB's BSON type ordering, as a SQL rank:
 *
 *   null/missing < numbers < strings < objects < arrays < booleans < dates
 *
 * SQLite's own ordering (NULL < numbers < text, booleans as 0/1 integers, our
 * wrapped dates as object text) disagrees with all of the exotic cases, so
 * every ordered comparison ranks by type first and compares values second.
 *
 * `typeExpr` is a json_type expression and `dateExpr` extracts the value's
 * `.$date` sub-path (NULL when it is not a stored Date). Kept in one place
 * because sorting, `$push: { $sort }` and `$min`/`$max` must all agree - and
 * src/bson-order.ts is the JS twin, which must agree with them too.
 */
export function bsonRankSql (typeExpr: string, dateExpr: string): string {
  return `CASE WHEN ${typeExpr} IS NULL OR ${typeExpr} = 'null' THEN 0 ` +
    `WHEN ${typeExpr} IN ('integer','real') THEN 1 ` +
    `WHEN ${typeExpr} = 'text' THEN 2 ` +
    `WHEN ${typeExpr} = 'object' AND ${dateExpr} IS NOT NULL THEN 6 ` +
    `WHEN ${typeExpr} = 'object' THEN 3 ` +
    `WHEN ${typeExpr} = 'array' THEN 4 ` +
    'ELSE 5 END' // 'true'/'false'
}

/** The value half of a BSON-ordered comparison: a Date compares by its ISO string. */
export function bsonValueSql (typeExpr: string, valueExpr: string, dateExpr: string): string {
  return `CASE WHEN ${typeExpr} = 'object' AND ${dateExpr} IS NOT NULL THEN ${dateExpr} ELSE ${valueExpr} END`
}

/**
 * Compiles a MongoDB sort specification ({ field: 1 | -1, ... }) into SQL
 * ORDER BY terms following MongoDB's BSON type comparison order (see
 * bsonRankSql). Date wrappers ({"$date": ISO}) rank as dates and compare by
 * their ISO string, which orders chronologically.
 *
 * Known divergence: MongoDB sorts an ARRAY field by its smallest (asc) /
 * largest (desc) element; here arrays rank as a group and compare as text.
 * `strict: true` (see assertNoKnownDivergence) rejects such a sort instead.
 */
export function toSortSql (columnName: string, sort: Record<string, number>): string {
  const entries = Object.entries(sort)
  if (entries.length === 0) throw Error('sort specification must contain at least one field')

  const terms: string[] = []
  for (const [field, direction] of entries) {
    if (direction !== 1 && direction !== -1) {
      throw Error(`unsupported sort direction for field ${field}: ${String(direction)} (only 1 and -1 are supported)`)
    }
    const column = quoteIdentifier(columnName)
    const type = `json_type(${column}, ${toJson1PathString([field])})`
    const dateValue = `json_extract(${column}, ${toJson1PathString([`${field}.$date`])})`
    const value = `json_extract(${column}, ${toJson1PathString([field])})`
    const dir = direction === 1 ? 'ASC' : 'DESC'
    terms.push(`${bsonRankSql(type, dateValue)} ${dir}`, `${bsonValueSql(type, value, dateValue)} ${dir}`)
  }
  return terms.join(', ')
}
