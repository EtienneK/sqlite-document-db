/**
 * Storage serialization (BACKLOG DR-1).
 *
 * Documents are stored as JSON, with one Extended JSON encoding on top:
 * `Date` values are wrapped as `{"$date": "<ISO-8601 UTC>"}` - the same wire
 * format MongoDB's EJSON uses, so a later move to full EJSON stays
 * backwards-compatible with data written today.
 *
 * Every other value JSON cannot represent (RegExp, typed arrays, Map, Set,
 * functions, bigints, NaN/Infinity, ...) is REJECTED at write time with an
 * error naming the offending path. The alternative - what JSON.stringify does
 * silently - is corruption: RegExp becomes {}, a Uint8Array becomes
 * {"0":1,"1":2}, NaN becomes null.
 *
 * `undefined` keeps JSON.stringify's behaviour (dropped from objects, null in
 * arrays) because document identity in the existing API depends on it.
 */

const DATE_KEY = '$date'

/** Serialize a document for storage. Throws on values JSON cannot hold. */
export function stringify (doc: unknown): string {
  return JSON.stringify(encode(doc, '$', new Set()))
}

/** Encode a single value the way `stringify` encodes document fields. */
export function encodeValue (value: unknown): unknown {
  return encode(value, '$', new Set())
}

/** Parse a stored document, reviving `{"$date": ...}` wrappers into Dates. */
export function parse (text: string): any {
  return JSON.parse(text, (_key, value) =>
    isDateWrapper(value) ? new Date(value[DATE_KEY]) : value
  )
}

function isDateWrapper (value: any): value is { $date: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    typeof value[DATE_KEY] === 'string' && Object.keys(value).length === 1
}

function encode (value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) throw unsupported(path, `non-finite number (${String(value)})`)
      return value
    case 'bigint':
    case 'function':
    case 'symbol':
      throw unsupported(path, typeof value)
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw unsupported(path, 'invalid Date')
    return { [DATE_KEY]: value.toISOString() }
  }

  // The types JSON.stringify would silently mangle rather than reject.
  if (value instanceof RegExp) throw unsupported(path, 'RegExp')
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw unsupported(path, value.constructor.name)
  if (value instanceof Map || value instanceof Set) throw unsupported(path, value.constructor.name)

  if (seen.has(value)) throw Error(`cannot store circular structure (at ${path})`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      // JSON.stringify turns undefined array elements into null; keep that.
      return value.map((element, i) => encode(element, `${path}.${i}`, seen) ?? null)
    }

    const encoded: Record<string, unknown> = {}
    for (const [key, fieldValue] of Object.entries(value)) {
      if (fieldValue === undefined) continue // JSON.stringify drops these; keep that.
      encoded[key] = encode(fieldValue, `${path}.${key}`, seen)
    }
    return encoded
  } finally {
    seen.delete(value)
  }
}

function unsupported (path: string, what: string): Error {
  return Error(
    `cannot store value of type ${what} (at ${path}): ` +
    'only JSON types and Date are supported - see "Supported value types" in the README'
  )
}
