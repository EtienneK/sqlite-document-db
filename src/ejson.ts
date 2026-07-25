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
 *
 * One consequence of the wrapper format: a document field that is itself an
 * object of exactly the shape `{ "$date": "<string>" }` is indistinguishable
 * from a stored Date, so it is rejected at write time too. This is the only
 * place the library reserves a field name, and it is the alternative to
 * handing that document back with an Invalid Date in it.
 */

const DATE_KEY = '$date'

/**
 * How deeply a stored document may nest, counting the document itself as
 * level 1 and each object or array below it as one more.
 *
 * This mirrors SQLite's `SQLITE_MAX_JSON_DEPTH`, which defaults to 1000: one
 * level deeper and `json()` rejects the document with the bare message
 * "malformed JSON", naming neither the limit nor the path. Checking it here
 * turns that into an error that says what happened and where.
 *
 * The number is MEASURED against the boundary, not read off the SQLite docs -
 * a document whose deepest container sits at level 1000 round-trips, and one at
 * 1001 does not. A `Date` costs a level, because it is stored as the object
 * `{"$date": ...}`; test/ejson.spec.ts pins both edges.
 */
export const MAX_DOCUMENT_DEPTH = 1000

/** Serialize a document for storage. Throws on values JSON cannot hold. */
export function stringify (doc: unknown): string {
  return JSON.stringify(encode(doc, '$', new Set(), 1))
}

/** Encode a single value the way `stringify` encodes document fields. */
export function encodeValue (value: unknown): unknown {
  return encode(value, '$', new Set(), 1)
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

function encode (value: unknown, path: string, seen: Set<object>, depth: number): unknown {
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

  // Everything below is stored as a JSON object or array - including a Date,
  // which becomes its {"$date": ...} wrapper - so this is where a level is
  // spent and where the depth limit applies.
  if (depth > MAX_DOCUMENT_DEPTH) {
    throw Error(
      `document nests deeper than ${MAX_DOCUMENT_DEPTH} levels (at ${path}): ` +
      'SQLite cannot store it, and would report only "malformed JSON"'
    )
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
      return value.map((element, i) => encode(element, `${path}.${i}`, seen, depth + 1) ?? null)
    }

    // A stored `{"$date": "<string>"}` is how a Date is written, so a document
    // field of exactly that shape would be revived as a Date - or, if the
    // string is not a date, as an Invalid Date that serialises back to null.
    // Reject it at write time rather than corrupt it on read.
    if (isDateWrapper(value)) {
      throw unsupported(path, 'object shaped like the stored Date wrapper ({ "$date": "..." })')
    }

    // A null prototype, so that a field literally named __proto__ (which
    // JSON.parse produces as an ordinary own property) is stored as data
    // instead of silently vanishing into a prototype assignment.
    const encoded: Record<string, unknown> = Object.create(null)
    for (const [key, fieldValue] of Object.entries(value)) {
      if (fieldValue === undefined) continue // JSON.stringify drops these; keep that.
      encoded[key] = encode(fieldValue, `${path}.${key}`, seen, depth + 1)
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
