import { encodeValue } from '../ejson.js'

export type QueryFilterDocument = Record<string, any>

/** The named parameters accompanying a compiled SQL fragment. */
export type SqlParams = Record<string, string | number | null>

/** Mutable named-parameter registry shared by every context of one compilation. */
interface Bindings {
  n: number
  values: SqlParams
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
  bindings: Bindings
}

function stringEscape (str: string): string {
  return str.replace(/'/g, '\'\'')
}

function stringEscape2 (str: string): string {
  return str.replace(/"/g, '""')
}

// Only PATHS are ever rendered as string literals. Values go through
// bindValue - if you are about to quote() a user-supplied value, stop.
function quote (str: string): string {
  return "'" + stringEscape(str) + "'"
}

function quote2 (data: string): string {
  return '"' + stringEscape2(data) + '"'
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
  const name = `p${ctx.bindings.n++}`
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
 * Encodes a JS value exactly as the storage layer does, registers it under
 * `name`, and returns the SQL fragment referencing it. For the update
 * operators in src/index.ts: $set values must be encoded by the same code
 * that encodes query values and stored documents. Always json()-wrapped so
 * json_set stores real JSON types (a bound bare 1 would store the number 1
 * where `true` was meant).
 */
export function bindValueAsJson (params: SqlParams, name: string, value: any): string {
  params[name] = JSON.stringify(encodeValue(value))
  return `json(:${name})`
}

// Exported so createIndex() builds index paths with the SAME code that builds
// query paths - if these ever diverge, indexes silently stop matching queries.
// Paths stay string LITERALS deliberately: SQLite only matches an expression
// index whose indexed expression is textually identical, so a bound
// json_extract(data, :path) would never use an index.
export function toJson1PathString (pathArr: string[]): string {
  const firstDot = (pathArr.length === 1 && pathArr[0] === '') ? '' : '.'
  return quote(`$${firstDot}${pathArr.join('.').replace(/\.(\d+)/g, '[$1]')}`)
}

function toJson1Extract (col: string, pathArr: string[]): string {
  if (pathArr === undefined || pathArr.length === 0) return quote2(col)
  return `json_extract(${quote2(col)}, ${toJson1PathString(pathArr)})`
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
  $size: null
}
const OPS_KEYS = Object.keys(OPS)

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
  const extract = toJson1Extract(ctx.col, [field])
  // Leading bracket-range predicate: JSON arrays extract as text starting
  // with '[', so `>= '[' AND < '\'` selects exactly the array-valued rows
  // USING THE SAME expression index the scalar arm uses (numbers sort before
  // text, objects start with '{'). Strings that happen to start with '[' slip
  // into the range; the json_type check filters them back out.
  return `(${extract} >= '[' AND ${extract} < '\\' AND json_type(${quote2(ctx.col)}, ${path}) = 'array' AND EXISTS (SELECT 1 FROM json_each(${quote2(ctx.col)}, ${path}) WHERE ${elemPred}))`
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
function withElementMatch (ctx: SqlContext, scalarPred: string, elemArm: string): string {
  if (ctx.table === undefined) return `(${scalarPred} OR ${elemArm})`
  return `rowid IN (SELECT rowid FROM ${ctx.table} WHERE ${scalarPred} UNION ALL SELECT rowid FROM ${ctx.table} WHERE ${elemArm})`
}

function convertOp (ctx: SqlContext, field: string, op: string, value: any): string {
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
        throw Error(`$${op} expects value to be of type: number | string | boolean | object | null; but got: ${typeof value}`)
      }
      // Dates are stored as {"$date": "<ISO>"} (see src/ejson.ts), so date
      // comparisons target the wrapped string one level down. ISO-8601 UTC
      // strings order lexicographically, which makes range operators work.
      const isDate = value instanceof Date
      const extractField = isDate ? `${field}.$date` : field
      const extractValue = isDate ? value.toISOString() : (value as string | number | boolean | object | null)
      const elemValue = isDate ? `json_extract(value, '$.$date')` : 'value'
      const boundValue = bindValue(ctx, extractValue)

      if (op === '$ne') {
        // MongoDB's $ne is the complement of the whole $eq match: it excludes
        // documents whose field equals the value AND documents whose array
        // field contains it, keeping everything else including missing fields.
        const eqScalar = `${toJson1Extract(ctx.col, [extractField])} is ${boundValue}`
        const eqElem = `${elemValue} is ${boundValue}`
        return `NOT (${withElementMatch(ctx, eqScalar, elementMatch(ctx, field, eqElem))})`
      }

      // Range operators need type bracketing, like MongoDB's: a number query
      // must not match strings/arrays/objects. Without this, SQLite's type
      // ordering (numbers < text) makes `extract > 25` true for EVERY array
      // or object field, since those extract as text ('[...', '{...').
      let scalarTypeGuard = ''
      let elemTypeGuard = ''
      if (op !== '$eq' && !isDate) {
        if (typeof value === 'number') {
          scalarTypeGuard = ` AND json_type(${quote2(ctx.col)}, ${toJson1PathString([field])}) IN ('integer','real')`
          elemTypeGuard = " AND json_each.type IN ('integer','real')"
        } else if (typeof value === 'string') {
          scalarTypeGuard = ` AND json_type(${quote2(ctx.col)}, ${toJson1PathString([field])}) = 'text'`
          elemTypeGuard = " AND json_each.type = 'text'"
        }
      }

      // Have to put this in for $not operator, otherwise $not doesn't work for null/undefined fields
      const notNull = op === '$eq' ? '' : `AND ${toJson1Extract(ctx.col, [extractField])} IS NOT NULL`
      const scalarPred = `${toJson1Extract(ctx.col, [extractField])} ${OPS[op]} ${boundValue} ${notNull}${scalarTypeGuard}`
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
      const list = `(${value.map(element => bindValue(ctx, element)).join(',')})`
      const scalarNull = value.includes(null) ? ` OR ${toJson1Extract(ctx.col, [field])} IS NULL` : ''
      const elemNull = value.includes(null) ? ' OR value IS NULL' : ''
      const scalarPred = `${toJson1Extract(ctx.col, [field])} IN ${list}${scalarNull}`
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
      if (!Array.isArray(value)) throw Error(`$${op} expects value to be of type: array; but got: ${typeof value}`)
      return `${op === '$nor' ? 'NOT' : ''} ((${value
        .map(q => convert(ctx, q))
        .join(`) ${OPS[op]} (`)}))`
    }
    case '$not': {
      if (Array.isArray(value) || typeof value !== 'object') throw Error(`$${op} expects value to be of type: non-array-object; but got: ${typeof value}`)
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
      const scalarPred = `json_type(${quote2(ctx.col)}, ${toJson1PathString([field])}) = 'text' AND mdb_regexp(${pattern}, ${flags}, ${toJson1Extract(ctx.col, [field])})`
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
      const scalarPred = `json_type(${quote2(ctx.col)}, ${toJson1PathString([field])}) IN ('integer','real') AND CAST(${toJson1Extract(ctx.col, [field])} AS INTEGER) % ${boundDivisor} = ${boundRemainder}`
      const elemPred = `json_each.type IN ('integer','real') AND CAST(value AS INTEGER) % ${boundDivisor} = ${boundRemainder}`
      return withElementMatch(ctx, scalarPred, elementMatch(ctx, field, elemPred))
    }
    // ---------------------- Element Query Operators ----------------------
    case '$type': {
      const aliases = (Array.isArray(value) ? value : [value]).map(resolveTypeAlias)
      if (aliases.length === 0) throw Error('$type must match at least one type')
      const typeExpr = `json_type(${quote2(ctx.col)}, ${toJson1PathString([field])})`
      const valueExpr = toJson1Extract(ctx.col, [field])
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
      return `select count(*) ${value ? '>' : '='} 0 from json_each(${quote2(ctx.col)}, ${toJson1PathString([field])})`
    }
    // ---------------------- Array Query Operators ----------------------
    case '$all': {
      if (!Array.isArray(value)) throw Error(`$all expects value to be of type: array; but got: ${typeof value}`)
      return `(select count(*) from json_each(${toJson1Extract(ctx.col, [field])}) where value in (select value from json_each(${bindValue(ctx, value)}))) = ${bindValue(ctx, new Set(value).size)}`
    }
    case '$elemMatch': {
      if (Array.isArray(value) || typeof value !== 'object' || value === null) throw Error(`$${op} expects value to be of type: non-array-object; but got: ${typeof value}`)
      // Each array element is re-wrapped as { "f": <element> } so the normal
      // field-path machinery can address it. An operator key ($gte, $lt, ...)
      // constrains the element itself, so it targets "f"; any other key is a
      // field path *inside* the element, so it targets "f.<key>". $regex and
      // its companion $options must stay together in one criterion.
      const regexPair: Record<string, unknown> = {}
      const $and: QueryFilterDocument[] = []
      for (const [key, criterion] of Object.entries(value)) {
        if (key === '$regex' || key === '$options') {
          regexPair[key] = criterion
          continue
        }
        $and.push(OPS_KEYS.includes(key)
          ? { f: { [key]: criterion } }
          : { [`f.${key}`]: criterion })
      }
      if (Object.keys(regexPair).length > 0) $and.push({ f: regexPair })
      // json_each takes (document, path), NOT the extracted value: a scalar
      // string field extracts to bare text, which json_each rejects as
      // malformed JSON. The 2-arg form is always safe, and the json_type
      // guard excludes the single self-row json_each yields for scalars
      // ($elemMatch only ever matches actual arrays, like MongoDB). The
      // element is re-wrapped with json_quote, not json(): a string element's
      // value is bare text - also malformed JSON - while json_quote encodes
      // scalars and passes objects/arrays through via the JSON subtype.
      return `json_type(${quote2(ctx.col)}, ${toJson1PathString([field])}) = 'array' AND EXISTS (select json_object('f', json_quote(value)) as valueJson from json_each(${quote2(ctx.col)}, ${toJson1PathString([field])}) where (${convert({ col: 'valueJson', bindings: ctx.bindings }, { $and })}))`
    }
    case '$size': {
      if (typeof value !== 'number') throw Error(`$size expects value to be of type: number; but got: ${typeof value}`)
      return `json_array_length(${quote2(ctx.col)}, ${toJson1PathString([field])}) = ${bindValue(ctx, value)}`
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
    const opEqualsField = OPS_KEYS.includes(field)
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
      if (valueOrOpKeys.length === 1 && countOps(valueOrOpKeys) === 1) {
        // Expressions in the form: { field: { $operator: value } }, where field is not an operator and value is an object
        op = valueOrOpKeys[0]!
        value = value[op]
      } else if (valueOrOpKeys.length > 1 && countOps(valueOrOpKeys) === valueOrOpKeys.length) {
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
export function toSql (columnName: string, query: QueryFilterDocument, table?: string): { sql: string, params: SqlParams } {
  const bindings: Bindings = { n: 0, values: {} }
  const sql = convert({ col: columnName, table, bindings }, query)
  return { sql, params: bindings.values }
}

/**
 * Compiles a MongoDB sort specification ({ field: 1 | -1, ... }) into SQL
 * ORDER BY terms that follow MongoDB's BSON type comparison order:
 *
 *   null/missing < numbers < strings < objects < arrays < booleans < dates
 *
 * SQLite's own ordering (NULL < numbers < text, booleans as 0/1 integers,
 * our wrapped dates as object text) disagrees with all of the exotic cases,
 * so each key sorts by a type-rank CASE first and the value second. Date
 * wrappers ({"$date": ISO}) rank as dates and compare by their ISO string,
 * which orders chronologically.
 *
 * Known divergence: MongoDB sorts an ARRAY field by its smallest (asc) /
 * largest (desc) element; here arrays rank as a group and compare as text.
 */
export function toSortSql (columnName: string, sort: Record<string, number>): string {
  const entries = Object.entries(sort)
  if (entries.length === 0) throw Error('sort specification must contain at least one field')

  const terms: string[] = []
  for (const [field, direction] of entries) {
    if (direction !== 1 && direction !== -1) {
      throw Error(`unsupported sort direction for field ${field}: ${String(direction)} (only 1 and -1 are supported)`)
    }
    const path = toJson1PathString([field])
    const datePath = toJson1PathString([`${field}.$date`])
    const type = `json_type(${quote2(columnName)}, ${path})`
    const dateValue = `json_extract(${quote2(columnName)}, ${datePath})`
    const rank = `CASE WHEN ${type} IS NULL OR ${type} = 'null' THEN 0 ` +
      `WHEN ${type} IN ('integer','real') THEN 1 ` +
      `WHEN ${type} = 'text' THEN 2 ` +
      `WHEN ${type} = 'object' AND ${dateValue} IS NOT NULL THEN 6 ` +
      `WHEN ${type} = 'object' THEN 3 ` +
      `WHEN ${type} = 'array' THEN 4 ` +
      'ELSE 5 END' // 'true'/'false'
    const value = `CASE WHEN ${type} = 'object' AND ${dateValue} IS NOT NULL THEN ${dateValue} ` +
      `ELSE json_extract(${quote2(columnName)}, ${path}) END`
    const dir = direction === 1 ? 'ASC' : 'DESC'
    terms.push(`${rank} ${dir}`, `${value} ${dir}`)
  }
  return terms.join(', ')
}
