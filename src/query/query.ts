import { encodeValue } from '../ejson.js'

export type QueryFilterDocument = Record<string, any>

/**
 * Compilation context threaded through the converter.
 *
 * `col` is the SQL source holding the document ('data' for collection tables,
 * 'valueJson' inside $elemMatch subqueries). `table` is the collection table
 * when the expression is being built for a top-level statement - it enables
 * the indexable rowid-union form of implicit array matching (see
 * withElementMatch). Nested contexts have no table and fall back to a flat OR.
 */
interface SqlContext {
  col: string
  table?: string
}

function stringEscape (str: string): string {
  return str.replace(/'/g, '\'\'')
}

function stringEscape2 (str: string): string {
  return str.replace(/"/g, '""')
}

function quote (data: any): string | number {
  if (typeof data === 'string') return "'" + stringEscape(data) + "'"
  if (typeof data === 'number') return data
  if (data === null) return 'null'
  if (data === true) return 'TRUE'
  if (data === false) return 'FALSE'
  // Objects and arrays are encoded exactly as the storage layer encodes them
  // (Dates wrapped as {"$date": ...}), so exact-match comparisons against
  // stored values line up byte for byte.
  return `json(${quote(JSON.stringify(encodeValue(data)))})`
}

function quote2 (data: string): string {
  return '"' + stringEscape2(data) + '"'
}

/**
 * Renders a JS value as a SQL literal, encoding objects/arrays/Dates exactly
 * as the storage layer does. Exported for the update operators ($set values
 * must be quoted by the same code that quotes query values).
 */
export function toSqlValue (data: any): string | number {
  return quote(data)
}

// Exported so createIndex() builds index paths with the SAME code that builds
// query paths - if these ever diverge, indexes silently stop matching queries.
export function toJson1PathString (pathArr: string[]): string | number {
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
  // Array Query Operators
  $all: null,
  $elemMatch: null,
  $size: null
}
const OPS_KEYS = Object.keys(OPS)

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

function convertOp (ctx: SqlContext, field: string, op: string, value: string | number | any[]): string {
  switch (op) {
    // ---------------------- Comparison Query Operators ----------------------
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
    case '$ne':
    case '$eq': {
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

      if (op === '$ne') {
        // MongoDB's $ne is the complement of the whole $eq match: it excludes
        // documents whose field equals the value AND documents whose array
        // field contains it, keeping everything else including missing fields.
        const eqScalar = `${toJson1Extract(ctx.col, [extractField])} is ${quote(extractValue)}`
        const eqElem = `${elemValue} is ${quote(extractValue)}`
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
      const scalarPred = `${toJson1Extract(ctx.col, [extractField])} ${OPS[op]} ${quote(extractValue)} ${notNull}${scalarTypeGuard}`
      const elemPred = `${elemValue} ${OPS[op]} ${quote(extractValue)}${elemTypeGuard}`
      return withElementMatch(ctx, scalarPred, elementMatch(ctx, field, elemPred))
    }
    case '$in': {
      if (!Array.isArray(value)) throw Error(`$in expects value to be of type: array; but got: ${typeof value}`)
      // A Date in the list needs a different extract path than the scalar
      // values, so the list form can't be used; rewrite as an OR of per-value
      // equalities, which is what $in means anyway.
      if (value.some(element => element instanceof Date)) {
        return convert(ctx, { $or: value.map(element => ({ [field]: element })) })
      }
      const list = `(${value.map(quote).join(',')})`
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
      if (value.some(element => element instanceof Date)) {
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
    // ---------------------- Element Query Operators ----------------------
    case '$exists': {
      if (typeof value !== 'boolean') throw Error(`$exists expects value to be of type: boolean; but got: ${typeof value}`)
      return `select count(*) ${value ? '>' : '='} 0 from json_each(${quote2(ctx.col)}, ${toJson1PathString([field])})`
    }
    // ---------------------- Array Query Operators ----------------------
    case '$all': {
      if (!Array.isArray(value)) throw Error(`$all expects value to be of type: array; but got: ${typeof value}`)
      return `(select count(*) from json_each(${toJson1Extract(ctx.col, [field])}) where value in (select value from json_each(${quote(value)}))) = ${quote(new Set(value).size)}`
    }
    case '$elemMatch': {
      if (Array.isArray(value) || typeof value !== 'object' || value === null) throw Error(`$${op} expects value to be of type: non-array-object; but got: ${typeof value}`)
      // Each array element is re-wrapped as { "f": <element> } so the normal
      // field-path machinery can address it. An operator key ($gte, $lt, ...)
      // constrains the element itself, so it targets "f"; any other key is a
      // field path *inside* the element, so it targets "f.<key>".
      const $and = Object.entries(value).map(([key, criterion]) => (
        OPS_KEYS.includes(key)
          ? { f: { [key]: criterion } }
          : { [`f.${key}`]: criterion }
      ))
      return `EXISTS (select json_object('f', json(value)) as valueJson from json_each(${toJson1Extract(ctx.col, [field])}) where (${convert({ col: 'valueJson' }, { $and })}))`
    }
    case '$size': {
      if (typeof value !== 'number') throw Error(`$size expects value to be of type: number; but got: ${typeof value}`)
      return `json_array_length(${quote2(ctx.col)}, ${toJson1PathString([field])}) = ${quote(value)}`
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

    if (!opEqualsField && typeof valueOrOp === 'object' && valueOrOp !== null) {
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
 * `columnName`. Pass `table` (the collection's table name) for top-level
 * statements so implicit array matching can compile to its indexable form.
 */
export function toSql (columnName: string, query: QueryFilterDocument, table?: string): string {
  return convert({ col: columnName, table }, query)
}
