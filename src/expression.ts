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
 * language nobody would get right by halves) and the date-arithmetic family.
 * See "Missing Features" in the README.
 */

import { compareBson, equalsBson } from './bson-order.js'
import { toRegExp } from './regex.js'
import { ownField, setField } from './safe-object.js'
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
    node = ownField(node as Record<string, unknown>, segment)
  }
  return node
}

/** Evaluates an expression against one document. The entry point. */
export function evaluateExpression (expression: unknown, doc: Document, strict = false): unknown {
  return evaluate(expression, { root: doc, vars: {}, strict })
}

export function evaluate (expression: unknown, ctx: EvalContext): unknown {
  if (typeof expression === 'string') return evaluateString(expression, ctx)
  // A RegExp is an object with no own enumerable keys, so without this it would
  // fall through to the plain-document branch and evaluate to `{}` - which is
  // how `{ $regexMatch: { regex: /x/ } }` would have silently matched nothing.
  if (expression === null || typeof expression !== 'object' || expression instanceof Date ||
    expression instanceof RegExp) return expression
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
    if (evaluated !== undefined) setField(result, key, evaluated)
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

/** The variables `evaluate` resolves without a binding. Never substituted. */
const SYSTEM_VARIABLES = new Set(['ROOT', 'CURRENT', 'REMOVE', 'NOW', 'CLUSTER_TIME'])

/**
 * Returns `expression` with every reference to a variable in `vars` replaced by
 * its VALUE, wrapped in `$literal` - what `$lookup`'s `let` needs (BACKLOG
 * item 16).
 *
 * The sub-pipeline of a correlated `$lookup` runs as an ordinary aggregation on
 * the foreign collection, and its `$match` travels through SQL (`mdb_expr`),
 * where an `EvalContext` cannot follow. Substituting the values as literals is
 * what lets ONE pipeline execution path serve both - `$literal` survives the
 * `$expr` serialisation because a Date encodes through the storage wrapper, and
 * `assertKnownExpressionOperators` never walks a `$literal`'s argument.
 *
 * Scope-aware, which is the part that would go quietly wrong without it: an
 * inner `$let`/`$map`/`$filter`/`$reduce` binding SHADOWS an outer `let`
 * variable of the same name, so a shadowed reference is left for the evaluator
 * to resolve. A `$$name` that names no variable at all is also left alone -
 * "undefined variable" is the evaluator's error to raise, at evaluation time,
 * exactly as the server raises it.
 */
export function substituteVariables (expression: unknown, vars: Record<string, unknown>): unknown {
  return substitute(expression, vars, new Set())
}

function substitute (expression: unknown, vars: Record<string, unknown>, bound: Set<string>): unknown {
  if (typeof expression === 'string') {
    if (!expression.startsWith('$$')) return expression
    const [name, ...rest] = expression.slice(2).split('.')
    if (SYSTEM_VARIABLES.has(name!) || bound.has(name!) || !Object.hasOwn(vars, name!)) return expression
    const value = rest.length === 0 ? vars[name!] : pathValue(vars[name!], rest.join('.'))
    // `{ $literal: undefined }` would not survive JSON serialisation (the key
    // vanishes), and $$REMOVE already means exactly "the missing value".
    return value === undefined ? '$$REMOVE' : { $literal: value }
  }
  if (expression === null || typeof expression !== 'object' || expression instanceof Date ||
    expression instanceof RegExp) return expression
  if (Array.isArray(expression)) return expression.map(element => substitute(element, vars, bound))

  const entries = Object.entries(expression as Document)
  const operator = entries.length === 1 ? entries[0]![0] : undefined
  // $literal's argument is DATA - a '$$name' inside it is a string, not a
  // reference - so it is not walked, mirroring assertKnownExpressionOperators.
  if (operator === '$literal') return expression

  if (operator === '$let') {
    const spec = expression as { $let: { vars?: Document, in?: unknown } }
    const bindings = spec.$let?.vars ?? {}
    const substituted: Document = {}
    // Binding VALUES evaluate in the OUTER scope; only `in` sees the names.
    for (const [name, value] of Object.entries(bindings)) setField(substituted, name, substitute(value, vars, bound))
    const inner = new Set([...bound, ...Object.keys(bindings)])
    return { $let: { ...spec.$let, vars: substituted, in: substitute(spec.$let?.in, vars, inner) } }
  }
  if (operator === '$map' || operator === '$filter') {
    const spec = (expression as Document)[operator] as Document
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return expression
    const name = typeof spec.as === 'string' ? spec.as : 'this'
    const inner = new Set([...bound, name])
    const body = operator === '$map' ? 'in' : 'cond'
    return {
      [operator]: {
        ...spec,
        ...(spec.input === undefined ? {} : { input: substitute(spec.input, vars, bound) }),
        ...(spec.limit === undefined ? {} : { limit: substitute(spec.limit, vars, bound) }),
        ...(spec[body] === undefined ? {} : { [body]: substitute(spec[body], vars, inner) })
      }
    }
  }
  if (operator === '$reduce') {
    const spec = (expression as Document).$reduce as Document
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return expression
    const inner = new Set([...bound, 'this', 'value'])
    return {
      $reduce: {
        ...spec,
        ...(spec.input === undefined ? {} : { input: substitute(spec.input, vars, bound) }),
        ...(spec.initialValue === undefined ? {} : { initialValue: substitute(spec.initialValue, vars, bound) }),
        ...(spec.in === undefined ? {} : { in: substitute(spec.in, vars, inner) })
      }
    }
  }

  const result: Document = {}
  for (const [key, value] of entries) setField(result, key, substitute(value, vars, bound))
  return result
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

/**
 * MongoDB's truthiness: false, null, missing and 0 are false; everything else
 * is true - including the empty string and the empty array.
 *
 * Exported because `$expr` decides whether a document matches by it.
 */
export function isTruthy (value: unknown): boolean {
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

  $exp: (raw, ctx) => arithmetic('$exp', args('$exp', raw, ctx, 1), ([n]) => Math.exp(n!)),
  $ln: (raw, ctx) => arithmetic('$ln', args('$ln', raw, ctx, 1), ([n]) => positiveLog('$ln', n!, Math.log)),
  $log10: (raw, ctx) => arithmetic('$log10', args('$log10', raw, ctx, 1), ([n]) => positiveLog('$log10', n!, Math.log10)),
  $log: (raw, ctx) => arithmetic('$log', args('$log', raw, ctx, 2), ([n, base]) => {
    if (base! <= 0 || base === 1) throw Error(`$log's base must be a positive number not equal to 1, but is ${base!}`)
    return positiveLog('$log', n!, value => Math.log(value) / Math.log(base!))
  }),

  // --- Trigonometry -------------------------------------------------------
  //
  // Radians throughout, like MongoDB. Each is `Math`, with one rule on top: a
  // result that is NaN means the argument was outside the function's domain,
  // which is an error on the server rather than a NaN in the output.

  $sin: trigonometry('$sin', Math.sin),
  $cos: trigonometry('$cos', Math.cos),
  $tan: trigonometry('$tan', Math.tan),
  $asin: trigonometry('$asin', Math.asin),
  $acos: trigonometry('$acos', Math.acos),
  $atan: trigonometry('$atan', Math.atan),
  $sinh: trigonometry('$sinh', Math.sinh),
  $cosh: trigonometry('$cosh', Math.cosh),
  $tanh: trigonometry('$tanh', Math.tanh),
  $asinh: trigonometry('$asinh', Math.asinh),
  $acosh: trigonometry('$acosh', Math.acosh),
  $atanh: trigonometry('$atanh', Math.atanh),
  $degreesToRadians: trigonometry('$degreesToRadians', degrees => degrees * Math.PI / 180),
  $radiansToDegrees: trigonometry('$radiansToDegrees', radians => radians * 180 / Math.PI),
  $atan2: (raw, ctx) => arithmetic('$atan2', args('$atan2', raw, ctx, 2), ([y, x]) => Math.atan2(y!, x!)),

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

  $and: (raw, ctx) => (Array.isArray(raw) ? raw : [raw]).every(element => isTruthy(evaluate(element, ctx))),
  $or: (raw, ctx) => (Array.isArray(raw) ? raw : [raw]).some(element => isTruthy(evaluate(element, ctx))),
  $not: (raw, ctx) => !isTruthy(args('$not', raw, ctx, 1)[0]),

  // --- Conditional --------------------------------------------------------

  /** Both the array form `[if, then, else]` and the document form. */
  $cond: (raw, ctx) => {
    if (Array.isArray(raw)) {
      if (raw.length !== 3) throw Error(`$cond takes exactly 3 arguments, but ${raw.length} were given`)
      return evaluate(isTruthy(evaluate(raw[0], ctx)) ? raw[1] : raw[2], ctx)
    }
    const spec = options('$cond', raw, ['if', 'then', 'else'])
    for (const key of ['if', 'then', 'else']) {
      if (!Object.hasOwn(spec, key)) throw Error(`$cond requires '${key}'`)
    }
    return evaluate(isTruthy(evaluate(spec.if, ctx)) ? spec.then : spec.else, ctx)
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
      const parsed = options('a $switch branch', branch, ['case', 'then'])
      // Presence, not just recognised names: a branch missing its `case`
      // evaluated to undefined -> false, so MongoDB's error became a silent
      // "no match" that fell through to the default.
      if (!Object.hasOwn(parsed, 'case')) throw Error("$switch requires each branch have a 'case' expression")
      if (!Object.hasOwn(parsed, 'then')) throw Error("$switch requires each branch have a 'then' expression")
      if (isTruthy(evaluate(parsed.case, ctx))) return evaluate(parsed.then, ctx)
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
    // A non-integral or negative start is an error in MongoDB, exactly as in the
    // byte twin below - not a silently-truncated or always-missing index.
    const from = start === undefined ? 0 : wholeNumber('$indexOfCP', start)
    const to = end === undefined ? points.length : wholeNumber('$indexOfCP', end)
    if (from < 0) throw Error('$indexOfCP requires a non-negative starting index')
    for (let i = from; i + needle.length <= Math.min(to, points.length); i++) {
      if (needle.every((point, offset) => points[i + offset] === point)) return i
    }
    return -1
  },

  // The byte twins of the CP operators above. MongoDB counts UTF-8 BYTES here,
  // not UTF-16 code units, so `é` is 2 and an emoji is 4 - JavaScript's own
  // `.length` agrees with neither. `$substr` is MongoDB's deprecated spelling
  // of `$substrBytes` and is the same operator.
  $substr: (raw, ctx) => substrBytes('$substr', raw, ctx),
  $substrBytes: (raw, ctx) => substrBytes('$substrBytes', raw, ctx),

  $strLenBytes: (raw, ctx) => utf8('$strLenBytes', args('$strLenBytes', raw, ctx, 1)[0]).length,

  $indexOfBytes: (raw, ctx) => {
    const [value, search, start, end] = args('$indexOfBytes', raw, ctx, 2, 4)
    if (isNullish(value)) return null
    const haystack = utf8('$indexOfBytes', value)
    const needle = utf8('$indexOfBytes', search)
    const from = start === undefined ? 0 : wholeNumber('$indexOfBytes', start)
    const to = end === undefined ? haystack.length : wholeNumber('$indexOfBytes', end)
    if (from < 0) throw Error('$indexOfBytes requires a non-negative starting index')
    for (let i = from; i + needle.length <= Math.min(to, haystack.length); i++) {
      if (needle.every((byte, offset) => haystack[i + offset] === byte)) return i
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

  // --- Regular expressions ------------------------------------------------
  //
  // The same JavaScript `RegExp` the `$regex` QUERY operator uses (see
  // src/regex.ts for the shared flag policy), so a pattern behaves the same on
  // both sides of the library. `idx` counts CODE POINTS, as MongoDB's does.
  //
  // Missing and null input is NOT an error here: `$regexMatch` is false,
  // `$regexFind` is null and `$regexFindAll` is the empty array - verified
  // against the server, and the reason these are usable in a schema-less store.

  $regexMatch: (raw, ctx) => {
    const { input, regex } = regexArgs('$regexMatch', raw, ctx)
    return input === null ? false : regex.test(input)
  },

  $regexFind: (raw, ctx) => {
    const { input, regex } = regexArgs('$regexFind', raw, ctx)
    if (input === null) return null
    return regexMatchDocument(regex.exec(input), input)
  },

  $regexFindAll: (raw, ctx) => {
    const { input, regex } = regexArgs('$regexFindAll', raw, ctx)
    if (input === null) return []
    const all = new RegExp(regex.source, regex.flags + 'g')
    const found: Document[] = []
    let match: RegExpExecArray | null
    while ((match = all.exec(input)) !== null) {
      // MongoDB starts a match attempt at every index from 0 up to and
      // including the LAST CHARACTER - not past it - so a zero-width pattern
      // finds two matches in 'ab' where JavaScript finds three. The empty
      // string still gets its one attempt at 0. Both halves verified against
      // the server; the two regex engines genuinely differ here.
      if (match[0] !== '' || input === '' || match.index < input.length) {
        found.push(regexMatchDocument(match, input)!)
      }
      // An empty match would otherwise spin forever on the same index.
      if (match[0] === '') all.lastIndex++
    }
    return found
  },

  // --- Objects ------------------------------------------------------------

  /**
   * Merges documents left to right; null and missing arguments are SKIPPED
   * rather than propagating, which is what makes `$mergeObjects` usable over a
   * field some documents do not have. A single argument that resolves to an
   * array merges that array's elements.
   */
  $mergeObjects: (raw, ctx) => {
    const values = variadic(raw, ctx)
    const documents = values.length === 1 && Array.isArray(values[0]) ? values[0] : values
    const merged: Document = {}
    for (const value of documents) {
      if (isNullish(value)) continue
      Object.assign(merged, asDocument('$mergeObjects', value))
    }
    return merged
  },

  $objectToArray: (raw, ctx) => {
    const value = args('$objectToArray', raw, ctx, 1)[0]
    if (isNullish(value)) return null
    return Object.entries(asDocument('$objectToArray', value)).map(([k, v]) => ({ k, v }))
  },

  /** Both spellings: `[[k, v], ...]` and `[{ k, v }, ...]`. Last key wins. */
  $arrayToObject: (raw, ctx) => {
    const value = args('$arrayToObject', raw, ctx, 1)[0]
    if (isNullish(value)) return null
    const result: Document = {}
    for (const entry of asArray('$arrayToObject', value)) {
      if (Array.isArray(entry)) {
        if (entry.length !== 2) {
          throw Error(`$arrayToObject requires an array of size 2 arrays, found array of size: ${entry.length}`)
        }
        setField(result, asString('$arrayToObject', entry[0]), entry[1])
        continue
      }
      const pair = asDocument('$arrayToObject', entry)
      if (!Object.hasOwn(pair, 'k') || !Object.hasOwn(pair, 'v')) {
        throw Error("$arrayToObject requires an object with keys 'k' and 'v'")
      }
      setField(result, asString('$arrayToObject', pair.k), pair.v)
    }
    return result
  },

  /**
   * Reads a field by NAME rather than by path - which is the whole point:
   * `$getField` is how a field whose name contains a `.` or starts with `$`
   * gets read at all. The shorthand `{ $getField: 'name' }` reads it from
   * `$$CURRENT`.
   */
  $getField: (raw, ctx) => {
    const { field, input } = fieldTarget('$getField', raw, ctx, ['field', 'input'])
    if (isNullish(input)) return null
    return ownField(asDocument('$getField', input), field)
  },

  /** Setting a field to `$$REMOVE` (an expression evaluating to missing) drops it. */
  $setField: (raw, ctx) => {
    const { field, input, spec } = fieldTarget('$setField', raw, ctx, ['field', 'input', 'value'])
    if (isNullish(input)) return null
    const result = { ...asDocument('$setField', input) }
    const value = evaluate(spec.value, ctx)
    if (value === undefined) delete result[field]
    else setField(result, field, value)
    return result
  },

  $unsetField: (raw, ctx) => {
    const { field, input } = fieldTarget('$unsetField', raw, ctx, ['field', 'input'])
    if (isNullish(input)) return null
    const result = { ...asDocument('$unsetField', input) }
    delete result[field]
    return result
  },

  // --- Sets ---------------------------------------------------------------
  //
  // An "array" is a set here, deduplicated by the same `equalsBson` `$addToSet`
  // uses. `$setUnion` and `$setIntersection` come back in BSON order (which is
  // what the server does, though it documents the order as unspecified);
  // `$setDifference` keeps the first array's order.

  $setUnion: (raw, ctx) => {
    const sets = setArgs('$setUnion', raw, ctx)
    if (sets === null) return null
    return dedupe(sets.flat()).toSorted(compareBson)
  },

  $setIntersection: (raw, ctx) => {
    const sets = setArgs('$setIntersection', raw, ctx)
    if (sets === null) return null
    if (sets.length === 0) return []
    const [first, ...rest] = sets
    return dedupe(first!.filter(value => rest.every(other => other.some(o => equalsBson(o, value)))))
      .toSorted(compareBson)
  },

  $setDifference: (raw, ctx) => {
    const sets = setArgs('$setDifference', raw, ctx, 2)
    if (sets === null) return null
    const [first, second] = sets as [unknown[], unknown[]]
    return dedupe(first.filter(value => !second.some(other => equalsBson(other, value))))
  },

  $setEquals: (raw, ctx) => {
    const sets = setArgs('$setEquals', raw, ctx, 2, Infinity, false)!
    const [first, ...rest] = sets
    return rest.every(other =>
      first!.every(value => other.some(o => equalsBson(o, value))) &&
      other.every(value => first!.some(o => equalsBson(o, value))))
  },

  $setIsSubset: (raw, ctx) => {
    const [subset, superset] = setArgs('$setIsSubset', raw, ctx, 2, 2, false)!
    return subset!.every(value => superset!.some(other => equalsBson(other, value)))
  },

  $allElementsTrue: (raw, ctx) => setArgs('$allElementsTrue', raw, ctx, 1, 1, false)![0]!.every(isTruthy),
  $anyElementTrue: (raw, ctx) => setArgs('$anyElementTrue', raw, ctx, 1, 1, false)![0]!.some(isTruthy),

  // --- Vector similarity --------------------------------------------------
  //
  // BACKLOG item 32: plain arithmetic over two equal-length arrays of numbers,
  // which is enough to express brute-force kNN as `$addFields` + `$sort` +
  // `$limit`. There is no index behind them - every document is scored - so
  // they are for modest collections, and the README says so. `$vectorSearch`
  // itself is Atlas-only and has no local oracle, so it is not implemented.

  $similarityDotProduct: (raw, ctx) => similarity('$similarityDotProduct', raw, ctx, (a, b) => dot(a, b)),
  $similarityCosine: (raw, ctx) => similarity('$similarityCosine', raw, ctx, (a, b) => {
    const magnitude = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b))
    return magnitude === 0 ? 0 : dot(a, b) / magnitude
  }),
  $similarityEuclidean: (raw, ctx) => similarity('$similarityEuclidean', raw, ctx, (a, b) =>
    Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]!) ** 2, 0))),

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

  $indexOfArray: (raw, ctx) => {
    const [array, search, start, end] = args('$indexOfArray', raw, ctx, 2, 4)
    if (isNullish(array)) return null
    const list = asArray('$indexOfArray', array)
    const from = start === undefined ? 0 : wholeNumber('$indexOfArray', start)
    const to = end === undefined ? list.length : wholeNumber('$indexOfArray', end)
    if (from < 0) throw Error('$indexOfArray requires a non-negative starting index')
    for (let i = from; i < Math.min(to, list.length); i++) {
      if (equalsBson(list[i], search)) return i
    }
    return -1
  },

  /**
   * `sortBy` is either 1/-1 (order the elements themselves) or a
   * `{ field: 1 | -1 }` document - the same two spellings `$push: { $sort }`
   * takes, ordered by the same BSON comparison.
   */
  $sortArray: (raw, ctx) => {
    const spec = options('$sortArray', raw, ['input', 'sortBy'])
    const input = evaluate(spec.input, ctx)
    if (isNullish(input)) return null
    const list = asArray('$sortArray', input)
    const by = spec.sortBy
    if (by === 1 || by === -1) return list.toSorted((a, b) => compareBson(a, b) * by)
    const entries = Object.entries(options('the sortBy option to $sortArray', by, Object.keys(by as Document ?? {})))
    if (entries.length === 0) throw Error('the sortBy option to $sortArray requires at least one field')
    for (const [field, direction] of entries) {
      if (direction !== 1 && direction !== -1) {
        throw Error(`the sortBy option to $sortArray must be 1 or -1 for '${field}'`)
      }
    }
    return list.toSorted((a, b) => {
      for (const [field, direction] of entries) {
        // pathValue, so a missing field ranks as null - which is what $sort
        // does everywhere else in this library.
        const comparison = compareBson(pathValue(a, field), pathValue(b, field))
        if (comparison !== 0) return comparison * (direction as number)
      }
      return 0
    })
  },

  /** Transposes arrays: `[[1,2],[3,4]]` becomes `[[1,3],[2,4]]`. */
  $zip: (raw, ctx) => {
    const spec = options('$zip', raw, ['inputs', 'useLongestLength', 'defaults'])
    const inputs = evaluate(spec.inputs, ctx)
    if (isNullish(inputs)) return null
    const arrays = asArray('$zip', inputs).map(input => {
      if (isNullish(input)) return null
      return asArray('$zip', input)
    })
    if (arrays.length === 0) throw Error('$zip requires at least one input array')
    if (arrays.some(array => array === null)) return null

    const longest = evaluate(spec.useLongestLength, ctx) === true
    const defaults = spec.defaults === undefined ? [] : asArray('$zip', evaluate(spec.defaults, ctx))
    if (defaults.length > 0) {
      if (!longest) throw Error('the defaults option to $zip requires useLongestLength: true')
      if (defaults.length !== arrays.length) {
        throw Error('$zip requires one default per input array when defaults are given')
      }
    }
    const lengths = (arrays as unknown[][]).map(array => array.length)
    const length = longest ? Math.max(...lengths) : Math.min(...lengths)
    return Array.from({ length }, (_unused, index) =>
      (arrays as unknown[][]).map((array, arrayIndex) =>
        index < array.length ? array[index] : (defaults[arrayIndex] ?? null)))
  },

  // The N-family: one shared shape, four selections. `n` and `input` are both
  // expressions, and `input` must resolve to an array (missing and null are
  // null, as everywhere else). $maxN/$minN SKIP null and missing elements;
  // $firstN/$lastN keep them, which is the difference the oracle settled.
  $firstN: (raw, ctx) => takeN('$firstN', raw, ctx, (list, n) => list.slice(0, n)),
  $lastN: (raw, ctx) => takeN('$lastN', raw, ctx, (list, n) => n >= list.length ? list : list.slice(list.length - n)),
  $maxN: (raw, ctx) => takeN('$maxN', raw, ctx, (list, n) =>
    list.filter(value => !isNullish(value)).toSorted((a, b) => compareBson(b, a)).slice(0, n)),
  $minN: (raw, ctx) => takeN('$minN', raw, ctx, (list, n) =>
    list.filter(value => !isNullish(value)).toSorted(compareBson).slice(0, n)),

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
      if (isTruthy(evaluate(spec.cond, { ...ctx, vars: { ...ctx.vars, [name]: element } }))) kept.push(element)
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
    for (const [name, expression] of Object.entries(bindings)) setField(vars, name, evaluate(expression, ctx))
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

  $toDate: (raw, ctx) => toDate('$toDate', args('$toDate', raw, ctx, 1)[0]),

  /**
   * The general form of the `$toX` operators, plus `onError` and `onNull`.
   *
   * `to` is a type NAME or a BSON type code. The targets this library can
   * produce are the ones its storage layer can hold; `decimal`, `objectId` and
   * the rest are valid names that raise (or answer with `onError`) rather than
   * silently producing something else. `long` is accepted and yields an
   * ordinary JavaScript number, which loses precision past 2^53 - MongoDB's
   * would not.
   */
  $convert: (raw, ctx) => {
    const spec = options('$convert', raw, ['input', 'to', 'onError', 'onNull', 'format'])
    if (spec.format !== undefined) throw Error('the format option to $convert is not supported')
    for (const key of ['input', 'to']) {
      if (!Object.hasOwn(spec, key)) throw Error(`$convert requires '${key}'`)
    }
    const input = evaluate(spec.input, ctx)
    if (isNullish(input)) return Object.hasOwn(spec, 'onNull') ? evaluate(spec.onNull, ctx) : null
    const to = convertTarget(evaluate(spec.to, ctx))
    try {
      return convertValue(to, input)
    } catch (error) {
      if (!Object.hasOwn(spec, 'onError')) throw error
      return evaluate(spec.onError, ctx)
    }
  },

  // --- Miscellaneous ------------------------------------------------------

  /**
   * A float in [0, 1). It takes no arguments and is the one operator here whose
   * answer changes between two runs of the same pipeline - which is what makes
   * it useful for sampling and useless for an equality assertion.
   */
  $rand: (raw) => {
    const spec = options('$rand', raw, [])
    if (Object.keys(spec).length !== 0) throw Error('$rand takes no arguments')
    return Math.random()
  }
}

/** Operator names this module implements, for error messages and validation. */
export const EXPRESSION_OPERATORS = ['$literal', ...Object.keys(OPERATORS)].toSorted()

/**
 * Rejects an unknown `$`-operator anywhere in an expression, WITHOUT evaluating
 * it.
 *
 * `$expr` compiles to a SQL function that runs per row (see src/query.ts) and
 * deliberately treats an evaluation error as "no match" - so a typo like
 * `{ $gtt: [...] }` would quietly match nothing rather than erroring. Checking
 * the structure once, at compile time, is what makes the common mistake an
 * error, everywhere the expression could run.
 *
 * It is a structural check only. Evaluating a sample document instead would
 * raise on expressions that are perfectly valid ({ $switch } with no default
 * and no matching branch), which is worse than not checking.
 */
export function assertKnownExpressionOperators (expression: unknown): void {
  if (Array.isArray(expression)) {
    for (const element of expression) assertKnownExpressionOperators(element)
    return
  }
  if (expression === null || typeof expression !== 'object' || expression instanceof Date) return

  for (const [key, value] of Object.entries(expression as Document)) {
    if (!key.startsWith('$')) {
      assertKnownExpressionOperators(value)
      continue
    }
    if (!EXPRESSION_OPERATORS.includes(key)) {
      throw Error(`unsupported aggregation expression operator: ${key}`)
    }
    // $literal's argument is data, not an expression, so it is not walked.
    if (key !== '$literal') assertKnownExpressionOperators(value)
  }
}

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

function asDocument (name: string, value: unknown): Document {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    throw Error(`${name} only supports objects, but got ${typeName(value)}`)
  }
  return value as Document
}

/** `Math.log`-family guard: MongoDB raises on a non-positive argument. */
function positiveLog (name: string, value: number, compute: (value: number) => number): number {
  if (value <= 0) throw Error(`${name}'s argument must be a positive number, but is ${value}`)
  return compute(value)
}

/**
 * One trigonometric operator: numeric, null-propagating, and NaN means the
 * argument was outside the function's domain (`$acos` of 2, `$acosh` of 0),
 * which MongoDB reports as an error rather than as a NaN in the result.
 */
function trigonometry (name: string, compute: (value: number) => number): Operator {
  return (raw, ctx) => arithmetic(name, args(name, raw, ctx, 1), ([value]) => {
    const result = compute(value!)
    if (Number.isNaN(result)) throw Error(`${name} cannot take ${value!}: it is outside the operator's domain`)
    return result
  })
}

// ---------------------------------------------------------------------------
// Strings, measured in UTF-8 bytes
// ---------------------------------------------------------------------------

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function utf8 (name: string, value: unknown): Uint8Array {
  return UTF8_ENCODER.encode(asString(name, value))
}

/** True for a byte that continues a multi-byte character rather than starting one. */
function isContinuation (bytes: Uint8Array, index: number): boolean {
  return index < bytes.length && (bytes[index]! & 0b1100_0000) === 0b1000_0000
}

/**
 * `$substrBytes` / `$substr`.
 *
 * The indexes are BYTE offsets into the UTF-8 encoding, so a range that would
 * split a character is an error rather than a string with a replacement
 * character in it - which is what MongoDB does, and what makes the operator
 * safe to use at all.
 */
function substrBytes (name: string, raw: unknown, ctx: EvalContext): unknown {
  const [value, start, length] = args(name, raw, ctx, 3)
  if (isNullish(value)) return ''
  const bytes = utf8(name, value)
  const from = wholeNumber(name, start)
  const count = wholeNumber(name, length)
  if (from < 0) throw Error(`${name}: starting index must be non-negative`)
  // A negative length means "to the end", as it does on the server.
  const to = count < 0 ? bytes.length : Math.min(from + count, bytes.length)
  if (isContinuation(bytes, from)) throw Error(`${name}: invalid range, starting index is in the middle of a UTF-8 character`)
  if (isContinuation(bytes, to)) throw Error(`${name}: invalid range, ending index is in the middle of a UTF-8 character`)
  if (from >= bytes.length) return ''
  return UTF8_DECODER.decode(bytes.slice(from, to))
}

// ---------------------------------------------------------------------------
// Regular expressions
// ---------------------------------------------------------------------------

/** The `{ input, regex, options }` the `$regex*` operators share. */
function regexArgs (name: string, raw: unknown, ctx: EvalContext): { input: string | null, regex: RegExp } {
  const spec = options(name, raw, ['input', 'regex', 'options'])
  if (!Object.hasOwn(spec, 'input')) throw Error(`${name} requires 'input'`)
  if (!Object.hasOwn(spec, 'regex')) throw Error(`${name} requires 'regex'`)
  const value = evaluate(spec.input, ctx)
  const regex = toRegExp(evaluate(spec.regex, ctx), spec.options === undefined ? undefined : evaluate(spec.options, ctx), {
    operator: name, optionsKey: `${name}'s 'options'`
  })
  // Missing and null input answer "no match" rather than raising - a wrong TYPE
  // still does, which is the rule the whole module follows.
  return { input: isNullish(value) ? null : asString(name, value), regex }
}

/** How many CODE POINTS a string holds - not the UTF-16 units `.length` counts. */
function codePointLength (text: string): number {
  let count = 0
  for (const _character of text) count++
  return count
}

/** MongoDB's `{ match, idx, captures }`, with `idx` counted in CODE POINTS. */
function regexMatchDocument (match: RegExpExecArray | null, input: string): Document | null {
  if (match === null) return null
  return {
    match: match[0],
    idx: codePointLength(input.slice(0, match.index)),
    // A group that did not participate is null, not missing.
    captures: match.slice(1).map(capture => capture ?? null)
  }
}

// ---------------------------------------------------------------------------
// Objects and sets
// ---------------------------------------------------------------------------

/** The `{ field, input }` shape `$getField`/`$setField`/`$unsetField` share. */
function fieldTarget (
  name: string, raw: unknown, ctx: EvalContext, known: string[]
): { field: string, input: unknown, spec: Record<string, unknown> } {
  // `{ $getField: 'name' }` is shorthand for reading it out of $$CURRENT.
  if (typeof raw === 'string' || (raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
    !Object.keys(raw).some(key => known.includes(key)))) {
    if (name !== '$getField') throw Error(`${name} requires a document with ${known.map(k => `'${k}'`).join(', ')}`)
    return { field: asString(name, evaluate(raw, ctx)), input: ctx.root, spec: {} }
  }
  const spec = options(name, raw, known)
  for (const key of known) {
    if (!Object.hasOwn(spec, key)) throw Error(`${name} requires '${key}'`)
  }
  return { field: asString(name, evaluate(spec.field, ctx)), input: evaluate(spec.input, ctx), spec }
}

/**
 * The argument arrays of a set operator.
 *
 * Returns null (rather than the arrays) when any argument is null or missing
 * and the operator propagates that - `$setUnion`, `$setIntersection` and
 * `$setDifference` do; `$setEquals`, `$setIsSubset` and the two
 * `$*ElementsTrue` operators raise instead, as MongoDB does.
 */
function setArgs (
  name: string, raw: unknown, ctx: EvalContext, min = 1, max = Infinity, nullable = true
): unknown[][] | null {
  const values = variadic(raw, ctx)
  if (values.length < min || values.length > max) {
    throw Error(max === min
      ? `${name} takes exactly ${min} argument${min === 1 ? '' : 's'}, but ${values.length} were given`
      : `${name} needs at least ${min} arguments, but ${values.length} were given`)
  }
  if (nullable && values.some(isNullish)) return null
  return values.map(value => asArray(name, value))
}

function dedupe (values: unknown[]): unknown[] {
  const unique: unknown[] = []
  for (const value of values) {
    if (!unique.some(existing => equalsBson(existing, value))) unique.push(value)
  }
  return unique
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

function dot (a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0)
}

/** Two equal-length arrays of numbers, and the arithmetic over them. */
function similarity (
  name: string, raw: unknown, ctx: EvalContext, compute: (a: number[], b: number[]) => number
): unknown {
  const [left, right] = args(name, raw, ctx, 2)
  if (isNullish(left) || isNullish(right)) return null
  const a = asArray(name, left).map(value => asNumber(name, value))
  const b = asArray(name, right).map(value => asNumber(name, value))
  if (a.length !== b.length) {
    throw Error(`array arguments to ${name} must be of the same length, but are ${a.length} and ${b.length}`)
  }
  if (a.length === 0) throw Error(`${name} requires non-empty vectors`)
  return compute(a, b)
}

// ---------------------------------------------------------------------------
// The N-family
// ---------------------------------------------------------------------------

/** `n` as MongoDB validates it: a whole number greater than zero. */
export function assertPositiveN (name: string, value: unknown): number {
  const n = wholeNumber(name, value)
  if (n <= 0) throw Error(`the 'n' given to ${name} must be greater than 0, found ${n}`)
  return n
}

function takeN (
  name: string, raw: unknown, ctx: EvalContext, select: (list: unknown[], n: number) => unknown[]
): unknown {
  const spec = options(name, raw, ['input', 'n'])
  for (const key of ['input', 'n']) {
    if (!Object.hasOwn(spec, key)) throw Error(`${name} requires '${key}'`)
  }
  const n = assertPositiveN(name, evaluate(spec.n, ctx))
  const input = evaluate(spec.input, ctx)
  if (isNullish(input)) return null
  return select(asArray(name, input), n)
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
function toNumber (name: string, value: unknown, whole: boolean, int32 = true): unknown {
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
  if (int32 && (truncated < -2147483648 || truncated > 2147483647)) {
    throw Error(`${name} would overflow a 32-bit integer: ${number}`)
  }
  return truncated
}

/**
 * `$toDate`, and `$convert`'s date target.
 *
 * A 32-bit INT is refused where a double or a long is accepted, which is
 * MongoDB's rule and is easy to mistake for a bug: `{ $toDate: 0 }` raises and
 * `{ $toDate: 1600000000000 }` does not. This library tells the two apart the
 * same way `$type` does - an integral number in int32 range serialises as an
 * int, anything else as a double - so the same values raise here and there.
 */
function toDate (name: string, value: unknown): unknown {
  if (isNullish(value)) return null
  if (value instanceof Date) return value
  if (typeof value === 'number') {
    if (typeName(value) === 'int') throw Error(`unsupported conversion from int to date in ${name}`)
    return new Date(value)
  }
  if (typeof value === 'string') {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) throw Error(`${name} could not parse the string: ${value}`)
    return date
  }
  throw Error(`${name} cannot convert a value of type ${typeName(value)}`)
}

/** BSON type codes accepted by `$convert`'s `to`, mapped to their names. */
const CONVERT_TARGET_BY_CODE: Record<number, string> = {
  1: 'double', 2: 'string', 5: 'binData', 7: 'objectId', 8: 'bool', 9: 'date', 16: 'int', 18: 'long', 19: 'decimal'
}

/**
 * Targets this library can produce. The rest are valid MongoDB type names that
 * the storage layer has no value for, so they raise (or answer with `onError`)
 * rather than quietly producing something of a different type - the same stance
 * `$type` takes for the aliases it can never match.
 */
const CONVERT_TARGETS = new Set(['double', 'int', 'long', 'bool', 'string', 'date'])

function convertTarget (to: unknown): string {
  if (typeof to === 'number') {
    const name = CONVERT_TARGET_BY_CODE[to]
    if (name === undefined) throw Error(`unknown type code in $convert: ${to}`)
    return name
  }
  if (typeof to !== 'string') throw Error('$convert requires a type name or a BSON type code for `to`')
  return to
}

function convertValue (to: string, input: unknown): unknown {
  switch (to) {
    case 'string': return OPERATORS.$toString!({ $literal: input }, EMPTY_CONTEXT)
    case 'bool': return OPERATORS.$toBool!({ $literal: input }, EMPTY_CONTEXT)
    case 'double': return toNumber('$convert', input, false)
    case 'int': return toNumber('$convert', input, true)
    // MongoDB's long is 64-bit; this one is a JavaScript number, so it does not
    // have to fit int32 but it does lose precision past 2^53.
    case 'long': return toNumber('$convert', input, true, false)
    case 'date': return toDate('$convert', input)
    default:
      if (!CONVERT_TARGETS.has(to) && !Object.values(CONVERT_TARGET_BY_CODE).includes(to)) {
        throw Error(`unknown type name in $convert: ${to}`)
      }
      throw Error(`$convert cannot produce a '${to}': this library's storage layer has no such type`)
  }
}

/** For the two `$convert` targets that reuse an operator body over a literal. */
const EMPTY_CONTEXT: EvalContext = { root: {}, vars: {}, strict: false }

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
