/**
 * Storage serialization (BACKLOG DR-1).
 *
 * Documents are stored as JSON, with two Extended JSON encodings on top:
 * `Date` values are wrapped as `{"$date": "<ISO-8601 UTC>"}` and `Uint8Array`
 * values as `{"$binary": {"base64": "<base64>", "subType": "00"}}` - the same
 * wire formats MongoDB's EJSON uses, so a later move to full EJSON stays
 * backwards-compatible with data written today.
 *
 * Every other value JSON cannot represent (RegExp, other typed arrays, Map,
 * Set, functions, bigints, NaN/Infinity, ...) is REJECTED at write time with
 * an error naming the offending path. The alternative - what JSON.stringify
 * does silently - is corruption: RegExp becomes {}, a DataView becomes {},
 * NaN becomes null.
 *
 * `undefined` keeps JSON.stringify's behaviour (dropped from objects, null in
 * arrays) because document identity in the existing API depends on it.
 *
 * One consequence of the wrapper format: a document field that is itself an
 * object of exactly the shape `{ "$date": "<string>" }` (or of the `$binary`
 * shape) is indistinguishable from a stored Date or byte array, so it is
 * rejected at write time too. These are the only field names the library
 * reserves, and it is the alternative to handing that document back with an
 * Invalid Date - or someone else's bytes - in it.
 */

import { Buffer } from 'node:buffer'

const DATE_KEY = '$date'
const BINARY_KEY = '$binary'

/**
 * How deeply a stored document may nest, counting the document itself as
 * level 1 and each object or array below it as one more.
 *
 * Three limits bear on this number, and 200 is chosen to sit under the two
 * that are hard and over the one that is not ours to widen:
 *
 * 1. **The JavaScript call stack.** `encode` below recurses once per level, so
 *    the reachable depth depends on the engine's stack. This was originally set
 *    to 1000 to mirror SQLite, which worked on Linux/Node 26 and blew the stack
 *    on Windows/Node 22.13 with `RangeError: Maximum call stack size exceeded`
 *    - a limit the implementation could not actually reach. Whatever the number
 *    is, it has to be one every supported platform can encode.
 * 2. **SQLite's `SQLITE_MAX_JSON_DEPTH`**, 1000 by default. Past it `json()`
 *    fails with a bare "malformed JSON" naming neither the limit nor the path,
 *    which is the error this check exists to replace.
 * 3. **MongoDB's own nesting limit**, which is the tightest of the three:
 *    measured at ~180 levels ("BSONObj exceeds maximum nested object depth"),
 *    and documented as 100. Sitting slightly ABOVE it is deliberate - being
 *    more permissive than the oracle means data still round-trips here, where
 *    being stricter would reject documents a real server accepts.
 *
 * A `Date` costs a level, because it is stored as `{"$date": ...}`.
 * test/ejson.spec.ts pins both edges, so this cannot drift in either direction.
 */
export const MAX_DOCUMENT_DEPTH = 200

/** Serialize a document for storage. Throws on values JSON cannot hold. */
export function stringify (doc: unknown): string {
  return JSON.stringify(encode(doc, '$', new Set(), 1))
}

/** Encode a single value the way `stringify` encodes document fields. */
export function encodeValue (value: unknown): unknown {
  return encode(value, '$', new Set(), 1)
}

/** Parse a stored document, reviving `{"$date": ...}` and `{"$binary": ...}` wrappers. */
export function parse (text: string): any {
  return JSON.parse(text, (_key, value) => {
    if (isDateWrapper(value)) return new Date(value[DATE_KEY])
    if (isBinaryWrapper(value)) return new Uint8Array(Buffer.from(value[BINARY_KEY].base64, 'base64'))
    return value
  })
}

function isDateWrapper (value: any): value is { $date: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    typeof value[DATE_KEY] === 'string' && Object.keys(value).length === 1
}

/**
 * Exactly the shape `encode` writes for a `Uint8Array`, keys and all. Anything
 * looser would revive objects the encoder never produced; anything stricter
 * would strand bytes the encoder wrote.
 */
function isBinaryWrapper (value: any): value is { $binary: { base64: string, subType: string } } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.keys(value).length !== 1) return false
  const inner = value[BINARY_KEY]
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner) &&
    typeof inner.base64 === 'string' && typeof inner.subType === 'string' &&
    Object.keys(inner).length === 2
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

  // Bytes (BACKLOG item 35 step 2): the EJSON $binary wrapper, generic
  // subtype. Buffer is a Uint8Array subclass, so it lands here too - and
  // Buffer.from(view) honours the view's window, so a Uint8Array over part of
  // a larger buffer stores exactly its own bytes.
  if (value instanceof Uint8Array) {
    return { [BINARY_KEY]: { base64: Buffer.from(value).toString('base64'), subType: '00' } }
  }

  // The types JSON.stringify would silently mangle rather than reject. Other
  // ArrayBuffer views are refused BY NAME with the fix, like db.sql refuses
  // them: bytes are spelled Uint8Array everywhere in this library.
  if (value instanceof RegExp) throw unsupported(path, 'RegExp')
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw Error(
      `cannot store value of type ${value.constructor.name} (at ${path}): ` +
      'bytes are stored as Uint8Array - wrap the buffer, e.g. new Uint8Array(view.buffer, view.byteOffset, view.byteLength)'
    )
  }
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
    // Reject it at write time rather than corrupt it on read. The $binary
    // wrapper reserves its shape for the same reason.
    if (isDateWrapper(value)) {
      throw unsupported(path, 'object shaped like the stored Date wrapper ({ "$date": "..." })')
    }
    if (isBinaryWrapper(value)) {
      throw unsupported(path, 'object shaped like the stored binary wrapper ({ "$binary": { ... } })')
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
    'only JSON types, Date and Uint8Array are supported - see "Supported value types" in the README'
  )
}
