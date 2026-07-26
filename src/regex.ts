/**
 * MongoDB regex options, normalised to a JavaScript `RegExp`.
 *
 * It lives in its own module because TWO sides of the library need exactly the
 * same rule and neither may import the other: the `$regex` QUERY operator
 * (src/query.ts, which compiles to the `mdb_regexp` SQL function) and the
 * `$regexMatch`/`$regexFind`/`$regexFindAll` EXPRESSION operators
 * (src/expression.ts, which query.ts already imports for `$expr`). Duplicating
 * it would duplicate the flag policy, which is the part with decisions in it.
 *
 * The policy, in both places:
 *
 * - **`x` (extended) is refused.** JavaScript has no equivalent, and silently
 *   ignoring it would change which documents match. MongoDB accepts it, so this
 *   is a divergence - a loud one, which is the point.
 * - **`g` and `y` are stateful in JavaScript.** `RegExp.prototype.test`
 *   advances `lastIndex`, so a global pattern would skip every other row. The
 *   query operator strips them (it has always done so); the expression
 *   operators refuse them, because MongoDB refuses them there too.
 */

/** Flags MongoDB itself accepts. `x` is in the list and refused below. */
const MONGODB_FLAGS = 'imsx'

export interface RegExpOptions {
  /** Names the operator in error messages: `$regex`, `$regexMatch`, ... */
  operator?: string
  /** Where the options came from, for the "set in both" message. */
  optionsKey?: string
  /**
   * True for the query `$regex` operator, which has always accepted `g`/`y` and
   * dropped them. The expression operators reject every flag MongoDB rejects.
   */
  stripStatefulFlags?: boolean
}

export function toRegExp (pattern: unknown, options: unknown, config: RegExpOptions = {}): RegExp {
  const operator = config.operator ?? '$regex'
  const optionsKey = config.optionsKey ?? '$options'

  let source: string
  let flags: string
  if (pattern instanceof RegExp) {
    source = pattern.source
    flags = pattern.flags
  } else if (typeof pattern === 'string') {
    source = pattern
    flags = ''
  } else {
    throw Error(`${operator} has to be a string or a RegExp`)
  }

  if (options !== undefined) {
    if (typeof options !== 'string') throw Error(`${optionsKey} has to be a string`)
    if (flags !== '' && options !== '') throw Error(`options set in both ${operator} and ${optionsKey}`)
    flags = options
  }

  if (flags.includes('x')) throw Error(`${optionsKey} flag "x" (extended) is not supported`)
  if (config.stripStatefulFlags === true) return new RegExp(source, flags.replace(/[gy]/g, ''))

  const invalid = [...flags].find(flag => !MONGODB_FLAGS.includes(flag))
  if (invalid !== undefined) throw Error(`${operator} invalid flag in regex options: ${invalid}`)
  return new RegExp(source, flags)
}
