/**
 * The aggregation expression language (BACKLOG item 16).
 *
 * Everything a `$project`, `$addFields`, `$group._id` or accumulator argument
 * can be: a `'$field'` path, a `'$$variable'`, a literal, and the operator
 * families below. It lives in its own module rather than in aggregate.ts
 * because it is a language with its own rules, and because the query
 * operator `$expr` needs the same vocabulary.
 *
 * Three rules run through all of it, and each was verified against a real
 * server rather than reasoned about:
 *
 * 1. **Missing and null are different values that mostly behave the same.**
 *    A missing field evaluates to `undefined` here; MongoDB calls it "missing".
 *    Arithmetic and `$concat` return `null` when any operand is either, and a
 *    computed field that evaluates to missing is OMITTED from the output rather
 *    than set to null. The distinction is why `$ifNull` and `$$REMOVE` work.
 * 2. **A wrong TYPE is an error; a missing VALUE is not.** `{ $add: ['$a', 1] }`
 *    over a document without `a` is null, but over `{ a: 'x' }` it throws. This
 *    is MongoDB's rule and it is the useful one - a schema-less store is full of
 *    absent fields and they should not blow up a pipeline.
 * 3. **An unknown `$`-operator is an error**, as everywhere else in this
 *    library. A silently-ignored operator returns a plausible wrong answer.
 *
 * Not implemented, and rejected by name: `$function`/`$accumulator` (arbitrary
 * JavaScript, like `$where`), `$$NOW`/`$$CLUSTER_TIME` (not deterministic, and
 * nothing here has a session), `$dateFromString` (a parser for a format
 * language nobody would get right by halves), the trigonometry family, and the
 * set operators. See "Missing Features" in the README.
 */

import { compareBson, equalsBson } from './bson-order.js'
import type { Document } from './types.js'

/** What an expression is evaluated against. */
export interface EvalContext {
  /** The document the stage is looking at - `$$ROOT`, and what `$field` reads. */
  root: Document
  /** `$$`-variables in scope: `$let`, `$map`, `$filter` and `$reduce` add them. */
  vars: Record<string, unknown>
  /** Reject constructs whose answer is known to differ from MongoDB's. */
  strict: boolean
}

/**
 * Reads a dotted path out of a document.
 *
 * Known divergence: MongoDB MAPS a path over an array of embedded documents,
 * so `'$instock.qty'` yields an array of quantities; here it yields undefined
 * and the path has to be reached through `$unwind` first. The collection-level
 * sort compiled to SQL does not map either, so at least the two agree - and
 * under `strict` the case raises instead of quietly reading as missing.
 */
export function pathValue (doc: unknown, path: string, strict = false): unknown {
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

/** Evaluates an expression against one document. The entry point. */
export function evaluateExpression (expression: unknown, doc: Document, strict = false): unknown {
  return evaluate(expression, { root: doc, vars: {}, strict })
}

export function evaluate (expression: unknown, ctx: EvalContext): unknown {
  if (typeof expression === 'string') return evaluateString(expression, ctx)
  if (expression === null || typeof expression !== 'object' || expression instanceof Date) return expression
  if (Array.isArray(expression)) return expression.map(element => evaluate(element, ctx))

  const entries = Object.entries(expression as Document)
  const operatorEntry = entries.find(([key]) => key.startsWith('$'))
  if (operatorEntry !== undefined) {
    const [name, argument] = operatorEntry
    if (entries.length !== 1) {
      throw Error(`an expression document may hold one operator or a set of fields, not both: ${JSON.stringify(Object.keys(expression as Document))}`)
    }
    if (name === '$literal') return argument
    const operator = OPERATORS[name]
    if (operator === undefined) throw Error(`unsupported aggregation expression operator: ${name}`)
    return operator(argument, ctx)
  }

  // A plain document: every value is an expression, and a field whose value
  // evaluates to missing is omitted rather than set to null.
  const result: Document = {}
  for (const [key, value] of entries) {
    const evaluated = evaluate(value, ctx)
    if (evaluated !== undefined) result[key] = evaluated
  }
  return result
}

/** `'$field.path'`, `'$$variable.path'`, or a plain string literal. */
function evaluateString (expression: string, ctx: EvalContext): unknown {
  if (!expression.startsWith('$')) return expression

  if (expression.startsWith('$$')) {
    const [name, ...rest] = expression.slice(2).split('.')
    const value = variableValue(name!, ctx)
    return rest.length === 0 ? value : pathValue(value, rest.join('.'), ctx.strict)
  }

  const path = expression.slice(1)
  if (path === '') throw Error("'$' is not a field path; use { $literal: '$' } for the string")
  return pathValue(ctx.root, path, ctx.strict)
}

function variableValue (name: string, ctx: EvalContext): unknown {
  // ROOT and CURRENT are the same document here: nothing rebinds CURRENT,
  // because $replaceRoot and the $let form that does are not implemented.
  if (name === 'ROOT' || name === 'CURRENT') return ctx.root
  if (name === 'REMOVE') return undefined // the value that means "omit this field"
  if (Object.hasOwn(ctx.vars, name)) return ctx.vars[name]
  if (name === 'NOW' || name === 'CLUSTER_TIME') {
    throw Error(`the system variable $$${name} is not supported: it is not deterministic, so a result could not be verified`)
  }
  throw Error(`undefined variable: $$${name}`)
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/**
 * The arguments of an operator, evaluated.
 *
 * A single-argument operator accepts either the expression itself or a
 * one-element array holding it, exactly as MongoDB does - so `{ $size: '$a' }`
 * and `{ $size: ['$a'] }` are the same thing, while `{ $size: [1, 2] }` is the
 * error "takes exactly 1 argument".
 */
function args (name: string, raw: unknown, ctx: EvalContext, min: number, max = min): unknown[] {
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length < min || list.length > max) {
    throw Error(max === min
      ? `${name} takes exactly ${min} argument${min === 1 ? '' : 's'}, but ${list.length} were given`
      : `${name} takes ${min} to ${max} arguments, but ${list.length} were given`)
  }
  return list.map(element => evaluate(element, ctx))
}

/** Variadic operators: the argument list is always an array of expressions. */
function variadic (raw: unknown, ctx: EvalContext): unknown[] {
  return (Array.isArray(raw) ? raw : [raw]).map(element => evaluate(element, ctx))
}

/** The `{ ...options }` document form some operators take, validated. */
function options (name: string, raw: unknown, known: string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Error(`${name} requires a document with ${known.map(k => `'${k}'`).join(', ')}`)
  }
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw Error(`unrecognized option to ${name}: ${key}`)
  }
  return raw as Record<string, unknown>
}

/** Missing and null are one thing for most operators: "no value". */
function isNullish (value: unknown): boolean {
  return value === null || value === undefined
}

/** MongoDB's truthiness: false, null, missing and 0 are false; everything else is true. */
function truthy (value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0)
}

function asNumber (name: string, value: unknown): number {
  if (typeof value !== 'number') throw Error(`${name} requires numeric arguments, but got ${typeName(value)}`)
  return value
}

function asString (name: string, value: unknown): string {
  if (typeof value !== 'string') throw Error(`${name} requires string arguments, but got ${typeName(value)}`)
  return value
}

function asArray (name: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error(`${name} requires an array argument, but got ${typeName(value)}`)
  return value
}

function asDate (name: string, value: unknown): Date {
  if (!(value instanceof Date)) throw Error(`${name} requires a Date argument, but got ${typeName(value)}`)
  return value
}

/** MongoDB's name for a value's type - what the `$type` expression reports. */
export function typeName (value: unknown): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  switch (typeof value) {
    case 'string': return 'string'
    case 'boolean': return 'bool'
    // The same split the $type QUERY operator uses (see src/query.ts): an
    // integral number in int32 range serialises as an int, anything else as a
    // double, so the two report the same thing about the same value.
    case 'number': return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? 'int' : 'double'
    default: return 'object'
  }
}

/**
 * Applies `compute` to numbers, short-circuiting to null when anything is
 * missing or null - the arithmetic null-propagation rule.
 */
function arithmetic (name: string, values: unknown[], compute: (numbers: number[]) => number): unknown {
  if (values.some(isNullish)) return null
  return compute(values.map(value => asNumber(name, value)))
}

// ---------------------------------------------------------------------------
// The operator table
// ---------------------------------------------------------------------------

type Operator = (raw: unknown, ctx: EvalContext) => unknown

const OPERATORS: Record<string, Operator> = {
  // --- Arithmetic ---------------------------------------------------------

  /**
   * Numbers, or ONE date plus numbers - `{ $add: ['$due', 86400000] }` is a day
   * later. Two dates is an error, because "date plus date" means nothing.
   */
  $add: (raw, ctx) => {
    const values = variadic(raw, ctx)
    if (values.some(isNullish)) return null
    const dates = values.filter(value => value instanceof Date) as Date[]
    if (dates.length === 0) return values.reduce<number>((sum, value) => sum + asNumber('$add', value), 0)
    if (dates.length > 1) throw Error('$add can add at most one date')
    const offset = values.filter(value => !(value instanceof Date))
      .reduce<number>((sum, value) => sum + asNumber('$add', value), 0)
    return new Date(dates[0]!.getTime() + offset)
  },

  /**
   * Date minus date is the difference in MILLISECONDS; date minus number is an
   * earlier date; number minus number is arithmetic.
   */
  $subtract: (raw, ctx) => {
    const [left, right] = args('$subtract', raw, ctx, 2)
    if (isNullish(left) || isNullish(right)) return null
    if (left instanceof Date) {
      if (right instanceof Date) return left.getTime() - right.getTime()
      return new Date(left.getTime() - asNumber('$subtract', right))
    }
    if (right instanceof Date) throw Error('$subtract cannot subtract a date from a number')
    return asNumber('$subtract', left) - asNumber('$subtract', right)
  },

  $multiply: (raw, ctx) =>
    arithmetic('$multiply', variadic(raw, ctx), numbers => numbers.reduce((product, n) => product * n, 1)),

  $divide: (raw, ctx) => arithmetic('$divide', args('$divide', raw, ctx, 2), ([left, right]) => {
    if (right === 0) throw Error("can't $divide by zero")
    return left! / right!
  }),

  $mod: (raw, ctx) => arithmetic('$mod', args('$mod', raw, ctx, 2), ([left, right]) => {
    if (right === 0) throw Error("can't $mod by zero")
    return left! % right!
  }),

  $abs: (raw, ctx) => arithmetic('$abs', args('$abs', raw, ctx, 1), ([n]) => Math.abs(n!)),
  $ceil: (raw, ctx) => arithmetic('$ceil', args('$ceil', raw, ctx, 1), ([n]) => Math.ceil(n!)),
  $floor: (raw, ctx) => arithmetic('$floor', args('$floor', raw, ctx, 1), ([n]) => Math.floor(n!)),
  $sqrt: (raw, ctx) => arithmetic('$sqrt', args('$sqrt', raw, ctx, 1), ([n]) => {
    if (n! < 0) throw Error("can't take $sqrt of a negative number")
    return Math.sqrt(n!)
  }),
  $pow: (raw, ctx) => arithmetic('$pow', args('$pow', raw, ctx, 2), ([base, exponent]) => base! ** exponent!),

  /**
   * Half-way values round to the EVEN neighbour, which is what the server does
   * and what `Math.round` does not: `$round: 2.5` is 2, and `$round: 3.5` is 4.
   */
  $round: (raw, ctx) => arithmetic('$round', args('$round', raw, ctx, 1, 2), numbers => {
    const [value, places = 0] = numbers
    const factor = 10 ** Math.trunc(places!)
    return roundHalfToEven(value! * factor) / factor
  }),

  $trunc: (raw, ctx) => arithmetic('$trunc', args('$trunc', raw, ctx, 1, 2), numbers => {
    const [value, places = 0] = numbers
    const factor = 10 ** Math.trunc(places!)
    return Math.trunc(value! * factor) / factor
  }),

  // --- Comparison ---------------------------------------------------------
  //
  // All of these order values by the BSON type order in src/bson-order.ts, the
  // same one $sort uses - so comparing a number with a string answers rather
  // than throwing, exactly as it does on the server.

  $cmp: (raw, ctx) => compare('$cmp', raw, ctx),
  $eq: (raw, ctx) => compare('$eq', raw, ctx) === 0,
  $ne: (raw, ctx) => compare('$ne', raw, ctx) !== 0,
  $gt: (raw, ctx) => compare('$gt', raw, ctx) > 0,
  $gte: (raw, ctx) => compare('$gte', raw, ctx) >= 0,
  $lt: (raw, ctx) => compare('$lt', raw, ctx) < 0,
  $lte: (raw, ctx) => compare('$lte', raw, ctx) <= 0,

  // --- Boolean ------------------------------------------------------------

  $and: (raw, ctx) => (Array.isArray(raw) ? raw : [raw]).every(element => truthy(evaluate(element, ctx))),
  $or: (raw, ctx) => (Array.isArray(raw) ? raw : [raw]).some(element => truthy(evaluate(element, ctx))),
  $not: (raw, ctx) => !truthy(args('$not', raw, ctx, 1)[0]),

  // --- Conditional --------------------------------------------------------

  /** Both the array form `[if, then, else]` and the document form. */
  $cond: (raw, ctx) => {
    if (Array.isArray(raw)) {
      if (raw.length !== 3) throw Error(`$cond takes exactly 3 arguments, but ${raw.length} were given`)
      return evaluate(truthy(evaluate(raw[0], ctx)) ? raw[1] : raw[2], ctx)
    }
    const spec = options('$cond', raw, ['if', 'then', 'else'])
    for (const key of ['if', 'then', 'else']) {
      if (!Object.hasOwn(spec, key)) throw Error(`$cond requires '${key}'`)
    }
    return evaluate(truthy(evaluate(spec.if, ctx)) ? spec.then : spec.else, ctx)
  },

  /** The first argument that is neither null nor missing, else the last. */
  $ifNull: (raw, ctx) => {
    const list = Array.isArray(raw) ? raw : [raw]
    if (list.length < 2) throw Error(`$ifNull needs at least 2 arguments, but ${list.length} were given`)
    for (const element of list.slice(0, -1)) {
      const value = evaluate(element, ctx)
      if (!isNullish(value)) return value
    }
    return evaluate(list[list.length - 1], ctx)
  },

  $switch: (raw, ctx) => {
    const spec = options('$switch', raw, ['branches', 'default'])
    const branches = spec.branches
    if (!Array.isArray(branches) || branches.length === 0) {
      throw Error('$switch requires a non-empty array of branches')
    }
    for (const branch of branches) {
      const { case: condition, then } = options('a $switch branch', branch, ['case', 'then'])
      if (truthy(evaluate(condition, ctx))) return evaluate(then, ctx)
    }
    if (!Object.hasOwn(spec, 'default')) {
      throw Error('$switch could not find a matching branch and no default was given')
    }
    return evaluate(spec.default, ctx)
  },

  // --- Strings ------------------------------------------------------------

  /** Null or missing anywhere gives null, as it does for arithmetic. */
  $concat: (raw, ctx) => {
    const values = variadic(raw, ctx)
    if (values.some(isNullish)) return null
    return values.map(value => asString('$concat', value)).join('')
  },

  // Null and missing become the EMPTY STRING here, not null - one of the
  // places MongoDB does not propagate, and one nobody would guess.
  $toLower: (raw, ctx) => stringOrEmpty('$toLower', args('$toLower', raw, ctx, 1)[0]).toLowerCase(),
  $toUpper: (raw, ctx) => stringOrEmpty('$toUpper', args('$toUpper', raw, ctx, 1)[0]).toUpperCase(),

  $strLenCP: (raw, ctx) => [...asString('$strLenCP', args('$strLenCP', raw, ctx, 1)[0])].length,

  /** Code POINTS, so an emoji counts as one character rather than two. */
  $substrCP: (raw, ctx) => {
    const [value, start, length] = args('$substrCP', raw, ctx, 3)
    if (isNullish(value)) return ''
    const points = [...asString('$substrCP', value)]
    const from = asNumber('$substrCP', start)
    const count = asNumber('$substrCP', length)
    if (from < 0 || count < 0) throw Error('$substrCP requires non-negative start and length')
    return points.slice(from, from + count).join('')
  },

  $indexOfCP: (raw, ctx) => {
    const [value, search, start, end] = args('$indexOfCP', raw, ctx, 2, 4)
    if (isNullish(value)) return null
    const points = [...asString('$indexOfCP', value)]
    const needle = [...asString('$indexOfCP', search)]
    const from = start === undefined ? 0 : asNumber('$indexOfCP', start)
    const to = end === undefined ? points.length : asNumber('$indexOfCP', end)
    for (let i = from; i + needle.length <= Math.min(to, points.length); i++) {
      if (needle.every((point, offset) => points[i + offset] === point)) return i
    }
    return -1
  },

  $split: (raw, ctx) => {
    const [value, separator] = args('$split', raw, ctx, 2)
    if (isNullish(value) || isNullish(separator)) return null
    const delimiter = asString('$split', separator)
    if (delimiter === '') throw Error('$split requires a non-empty separator')
    return asString('$split', value).split(delimiter)
  },

  $trim: (raw, ctx) => trim('$trim', raw, ctx),
  $ltrim: (raw, ctx) => trim('$ltrim', raw, ctx),
  $rtrim: (raw, ctx) => trim('$rtrim', raw, ctx),

  /** -1, 0 or 1, comparing case-insensitively. Null counts as the empty string. */
  $strcasecmp: (raw, ctx) => {
    const [left, right] = args('$strcasecmp', raw, ctx, 2)
    const a = stringOrEmpty('$strcasecmp', left).toUpperCase()
    const b = stringOrEmpty('$strcasecmp', right).toUpperCase()
    return a === b ? 0 : (compareBson(a, b) < 0 ? -1 : 1)
  },

  $replaceOne: (raw, ctx) => replace('$replaceOne', raw, ctx, false),
  $replaceAll: (raw, ctx) => replace('$replaceAll', raw, ctx, true),

  // --- Arrays -------------------------------------------------------------

  $size: (raw, ctx) => asArray('$size', args('$size', raw, ctx, 1)[0]).length,
  $isArray: (raw, ctx) => Array.isArray(args('$isArray', raw, ctx, 1)[0]),
  $reverseArray: (raw, ctx) => {
    const value = args('$reverseArray', raw, ctx, 1)[0]
    return isNullish(value) ? null : asArray('$reverseArray', value).toReversed()
  },

  $arrayElemAt: (raw, ctx) => {
    const [array, index] = args('$arrayElemAt', raw, ctx, 2)
    if (isNullish(array) || isNullish(index)) return null
    const list = asArray('$arrayElemAt', array)
    const at = asNumber('$arrayElemAt', index)
    if (!Number.isInteger(at)) throw Error('$arrayElemAt requires a whole-number index')
    // Out of range is MISSING, not null - so the field disappears entirely.
    return at < 0 ? list[list.length + at] : list[at]
  },

  $first: (raw, ctx) => {
    const value = args('$first', raw, ctx, 1)[0]
    return isNullish(value) ? null : asArray('$first', value)[0]
  },
  $last: (raw, ctx) => {
    const value = args('$last', raw, ctx, 1)[0]
    if (isNullish(value)) return null
    const list = asArray('$last', value)
    return list[list.length - 1]
  },

  /** `[array, n]` takes the first n (last n if negative); `[array, skip, n]` a window. */
  $slice: (raw, ctx) => {
    const [array, second, third] = args('$slice', raw, ctx, 2, 3)
    if (isNullish(array)) return null
    const list = asArray('$slice', array)
    if (third === undefined) {
      const count = asNumber('$slice', second)
      return count < 0 ? list.slice(count) : list.slice(0, count)
    }
    const start = asNumber('$slice', second)
    const count = asNumber('$slice', third)
    if (count < 0) throw Error('$slice requires a non-negative count when a starting position is given')
    const from = start < 0 ? Math.max(list.length + start, 0) : start
    return list.slice(from, from + count)
  },

  $concatArrays: (raw, ctx) => {
    const values = variadic(raw, ctx)
    if (values.some(isNullish)) return null
    return values.flatMap(value => asArray('$concatArrays', value))
  },

  /** `{ $in: [<value>, <array>] }` - the EXPRESSION, not the query operator. */
  $in: (raw, ctx) => {
    const [needle, array] = args('$in', raw, ctx, 2)
    return asArray('$in', array).some(element => equalsBson(element, needle))
  },

  $range: (raw, ctx) => {
    const [start, end, step] = args('$range', raw, ctx, 2, 3)
    const from = wholeNumber('$range', start)
    const to = wholeNumber('$range', end)
    const by = step === undefined ? 1 : wholeNumber('$range', step)
    if (by === 0) throw Error('$range requires a non-zero step')
    const values: number[] = []
    for (let n = from; by > 0 ? n < to : n > to; n += by) values.push(n)
    return values
  },

  // $sum / $avg / $min / $max are accumulators inside $group (see
  // src/aggregate.ts) and ARRAY operators everywhere else, which is why they
  // appear twice in this library. `{ $sum: '$scores' }` in a $project adds up
  // one document's array; the same spelling in $group adds up the group.
  $sum: (raw, ctx) => numbersOf(numericArgs(raw, ctx)).reduce((total, n) => total + n, 0),
  $avg: (raw, ctx) => {
    const numbers = numbersOf(numericArgs(raw, ctx))
    return numbers.length === 0 ? null : numbers.reduce((total, n) => total + n, 0) / numbers.length
  },
  $min: (raw, ctx) => extreme(numericArgs(raw, ctx), -1),
  $max: (raw, ctx) => extreme(numericArgs(raw, ctx), 1),

  $map: (raw, ctx) => {
    const spec = options('$map', raw, ['input', 'as', 'in'])
    const input = evaluate(spec.input, ctx)
    if (isNullish(input)) return null
    const name = variableName('$map', spec.as)
    return asArray('$map', input).map(element =>
      evaluate(spec.in, { ...ctx, vars: { ...ctx.vars, [name]: element } })
    )
  },

  $filter: (raw, ctx) => {
    const spec = options('$filter', raw, ['input', 'as', 'cond', 'limit'])
    const input = evaluate(spec.input, ctx)
    if (isNullish(input)) return null
    const name = variableName('$filter', spec.as)
    const limit = spec.limit === undefined ? Infinity : wholeNumber('$filter', evaluate(spec.limit, ctx))
    if (limit < 1) throw Error('the limit option to $filter must be at least 1')
    const kept: unknown[] = []
    for (const element of asArray('$filter', input)) {
      if (kept.length >= limit) break
      if (truthy(evaluate(spec.cond, { ...ctx, vars: { ...ctx.vars, [name]: element } }))) kept.push(element)
    }
    return kept
  },

  $reduce: (raw, ctx) => {
    const spec = options('$reduce', raw, ['input', 'initialValue', 'in'])
    const input = evaluate(spec.input, ctx)
    if (isNullish(input)) return null
    let value = evaluate(spec.initialValue, ctx)
    for (const element of asArray('$reduce', input)) {
      value = evaluate(spec.in, { ...ctx, vars: { ...ctx.vars, this: element, value } })
    }
    return value
  },

  $let: (raw, ctx) => {
    const spec = options('$let', raw, ['vars', 'in'])
    const bindings = options('the vars option to $let', spec.vars, Object.keys(spec.vars as Document ?? {}))
    const vars = { ...ctx.vars }
    for (const [name, expression] of Object.entries(bindings)) vars[name] = evaluate(expression, ctx)
    return evaluate(spec.in, { ...ctx, vars })
  },

  // --- Dates --------------------------------------------------------------
  //
  // UTC only. A `timezone` option is REJECTED rather than ignored: answering a
  // timezone question in UTC is a wrong answer that looks right.

  $year: (raw, ctx) => datePart('$year', raw, ctx, date => date.getUTCFullYear()),
  $month: (raw, ctx) => datePart('$month', raw, ctx, date => date.getUTCMonth() + 1),
  $dayOfMonth: (raw, ctx) => datePart('$dayOfMonth', raw, ctx, date => date.getUTCDate()),
  $hour: (raw, ctx) => datePart('$hour', raw, ctx, date => date.getUTCHours()),
  $minute: (raw, ctx) => datePart('$minute', raw, ctx, date => date.getUTCMinutes()),
  $second: (raw, ctx) => datePart('$second', raw, ctx, date => date.getUTCSeconds()),
  $millisecond: (raw, ctx) => datePart('$millisecond', raw, ctx, date => date.getUTCMilliseconds()),
  /** 1 for Sunday through 7 for Saturday, as MongoDB numbers it. */
  $dayOfWeek: (raw, ctx) => datePart('$dayOfWeek', raw, ctx, date => date.getUTCDay() + 1),
  $dayOfYear: (raw, ctx) => datePart('$dayOfYear', raw, ctx, date =>
    Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000)),

  $dateToString: (raw, ctx) => {
    const spec = options('$dateToString', raw, ['date', 'format', 'timezone', 'onNull'])
    if (spec.timezone !== undefined) throw Error(UTC_ONLY('$dateToString'))
    const value = evaluate(spec.date, ctx)
    if (isNullish(value)) return Object.hasOwn(spec, 'onNull') ? evaluate(spec.onNull, ctx) : null
    const format = spec.format === undefined ? ISO_FORMAT : asString('$dateToString', evaluate(spec.format, ctx))
    return formatDate(asDate('$dateToString', value), format)
  },

  // --- Types --------------------------------------------------------------

  $type: (raw, ctx) => typeName(args('$type', raw, ctx, 1)[0]),
  $isNumber: (raw, ctx) => typeof args('$isNumber', raw, ctx, 1)[0] === 'number',

  $toString: (raw, ctx) => {
    const value = args('$toString', raw, ctx, 1)[0]
    if (isNullish(value)) return null
    if (typeof value === 'string') return value
    if (value instanceof Date) return formatDate(value, ISO_FORMAT)
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    throw Error(`$toString cannot convert a value of type ${typeName(value)}`)
  },

  $toBool: (raw, ctx) => {
    const value = args('$toBool', raw, ctx, 1)[0]
    if (isNullish(value)) return null
    // Only 0 is false among numbers, and EVERY string is true - including ''.
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'boolean') return value
    return true
  },

  $toInt: (raw, ctx) => toNumber('$toInt', args('$toInt', raw, ctx, 1)[0], true),
  $toDouble: (raw, ctx) => toNumber('$toDouble', args('$toDouble', raw, ctx, 1)[0], false),

  $toDate: (raw, ctx) => {
    const value = args('$toDate', raw, ctx, 1)[0]
    if (isNullish(value)) return null
    if (value instanceof Date) return value
    if (typeof value === 'number') return new Date(value)
    if (typeof value === 'string') {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) throw Error(`$toDate could not parse the string: ${value}`)
      return date
    }
    throw Error(`$toDate cannot convert a value of type ${typeName(value)}`)
  }
}

/** Operator names this module implements, for error messages and validation. */
export const EXPRESSION_OPERATORS = ['$literal', ...Object.keys(OPERATORS)].toSorted()

// ---------------------------------------------------------------------------
// Shared operator bodies
// ---------------------------------------------------------------------------

function compare (name: string, raw: unknown, ctx: EvalContext): number {
  const [left, right] = args(name, raw, ctx, 2)
  return compareValues(left, right)
}

/**
 * The order the comparison OPERATORS use.
 *
 * It differs from src/bson-order.ts in exactly one place: a MISSING value ranks
 * below null instead of alongside it, so `{ $eq: ['$absent', null] }` is
 * **false** and `{ $lt: ['$absent', null] }` is true. Verified against the
 * server, and genuinely surprising - `$sort` and `$group._id` DO treat a
 * missing field as null, which is why this cannot simply be folded into
 * `compareBson`.
 */
function compareValues (a: unknown, b: unknown): number {
  if (a === undefined || b === undefined) {
    if (a === b) return 0
    return a === undefined ? -1 : 1
  }
  return compareBson(a, b)
}

/**
 * The values `$sum`/`$avg`/`$min`/`$max` work over.
 *
 * One argument that resolves to an ARRAY contributes its elements
 * (`{ $sum: '$scores' }`); a list of arguments contributes each of them
 * (`{ $sum: ['$a', '$b'] }`). The two spellings are told apart by the shape of
 * the expression, not by what it evaluates to.
 */
function numericArgs (raw: unknown, ctx: EvalContext): unknown[] {
  if (Array.isArray(raw)) return raw.map(element => evaluate(element, ctx))
  const value = evaluate(raw, ctx)
  return Array.isArray(value) ? value : [value]
}

/** Non-numeric values are IGNORED rather than being an error, as on the server. */
function numbersOf (values: unknown[]): number[] {
  return values.filter((value): value is number => typeof value === 'number')
}

function extreme (values: unknown[], wanted: 1 | -1): unknown {
  let best: unknown
  let seen = false
  for (const value of values) {
    if (isNullish(value)) continue // null and missing are skipped, not compared
    if (!seen || Math.sign(compareBson(value, best)) === wanted) { best = value; seen = true }
  }
  return seen ? best : null
}

/** Ties go to the even neighbour: 2.5 → 2, 3.5 → 4, -2.5 → -2. */
function roundHalfToEven (value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction > 0.5) return floor + 1
  if (fraction < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function stringOrEmpty (name: string, value: unknown): string {
  return isNullish(value) ? '' : asString(name, value)
}

function wholeNumber (name: string, value: unknown): number {
  const number = asNumber(name, value)
  if (!Number.isInteger(number)) throw Error(`${name} requires whole numbers, but got ${number}`)
  return number
}

function variableName (operator: string, as: unknown): string {
  if (as === undefined) return 'this' // MongoDB's default
  if (typeof as !== 'string' || as === '') throw Error(`the as option to ${operator} must be a non-empty string`)
  return as
}

function trim (name: string, raw: unknown, ctx: EvalContext): unknown {
  const spec = options(name, raw, ['input', 'chars'])
  const value = evaluate(spec.input, ctx)
  if (isNullish(value)) return null
  const text = asString(name, value)
  const chars = spec.chars === undefined ? ' \t\n\r\v\f' : asString(name, evaluate(spec.chars, ctx))
  const set = new Set(chars) // a string iterates by code point
  const points = [...text]
  let start = 0
  let end = points.length
  if (name !== '$rtrim') while (start < end && set.has(points[start]!)) start++
  if (name !== '$ltrim') while (end > start && set.has(points[end - 1]!)) end--
  return points.slice(start, end).join('')
}

function replace (name: string, raw: unknown, ctx: EvalContext, all: boolean): unknown {
  const spec = options(name, raw, ['input', 'find', 'replacement'])
  const input = evaluate(spec.input, ctx)
  const find = evaluate(spec.find, ctx)
  const replacement = evaluate(spec.replacement, ctx)
  if (isNullish(input) || isNullish(find) || isNullish(replacement)) return null
  const text = asString(name, input)
  const needle = asString(name, find)
  const value = asString(name, replacement)
  return all ? text.replaceAll(needle, value) : text.replace(needle, value)
}

/**
 * `$toInt` / `$toDouble`.
 *
 * A NUMBER is truncated toward zero on the way to an int (`$toInt` of 2.5 is
 * 2), but a STRING has to spell one: the server parses the whole string or
 * fails, so `'2.5'` is an error rather than 2. Overflowing int32 is an error
 * too - MongoDB has a 32-bit int and this is the point where that shows.
 */
function toNumber (name: string, value: unknown, whole: boolean): unknown {
  if (isNullish(value)) return null
  let number: number
  let fromString = false
  if (typeof value === 'number') number = value
  else if (typeof value === 'boolean') number = value ? 1 : 0
  else if (value instanceof Date) number = value.getTime()
  else if (typeof value === 'string') {
    fromString = true
    number = Number(value)
    if (value.trim() === '' || Number.isNaN(number)) throw Error(`${name} could not convert the string: ${value}`)
  } else throw Error(`${name} cannot convert a value of type ${typeName(value)}`)

  if (!whole) return number
  if (fromString && !Number.isInteger(number)) {
    throw Error(`${name} could not convert the string: ${String(value)}`)
  }
  const truncated = Math.trunc(number)
  if (truncated < -2147483648 || truncated > 2147483647) {
    throw Error(`${name} would overflow a 32-bit integer: ${number}`)
  }
  return truncated
}

const UTC_ONLY = (name: string): string =>
  `the timezone option to ${name} is not supported: dates are handled in UTC here, and answering a ` +
  'timezone question in UTC would be a wrong answer that looks right'

function datePart (name: string, raw: unknown, ctx: EvalContext, part: (date: Date) => number): unknown {
  // Both the plain form ({ $year: '$d' }) and the document form, which exists
  // only to carry a timezone - so it is accepted and then refused.
  let expression = raw
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Date)) {
    const spec = options(name, raw, ['date', 'timezone'])
    if (spec.timezone !== undefined) throw Error(UTC_ONLY(name))
    expression = spec.date
  }
  const value = evaluate(expression, ctx)
  if (isNullish(value)) return null
  return part(asDate(name, value))
}

const ISO_FORMAT = '%Y-%m-%dT%H:%M:%S.%LZ'

function pad (value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * MongoDB's `$dateToString` format specifiers, UTC.
 *
 * An unknown specifier is an error rather than being emitted literally: `%q`
 * silently coming back as "%q" is a formatting bug that survives to production.
 */
function formatDate (date: Date, format: string): string {
  return format.replace(/%(.|$)/g, (_match, specifier: string) => {
    switch (specifier) {
      case 'Y': return pad(date.getUTCFullYear(), 4)
      case 'm': return pad(date.getUTCMonth() + 1, 2)
      case 'd': return pad(date.getUTCDate(), 2)
      case 'H': return pad(date.getUTCHours(), 2)
      case 'M': return pad(date.getUTCMinutes(), 2)
      case 'S': return pad(date.getUTCSeconds(), 2)
      case 'L': return pad(date.getUTCMilliseconds(), 3)
      case 'j': return pad(Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000), 3)
      case 'w': return String(date.getUTCDay() + 1)
      case 'z': return '+0000'
      case 'Z': return '0'
      case '%': return '%'
      default: throw Error(`unsupported $dateToString format specifier: %${specifier}`)
    }
  })
}
