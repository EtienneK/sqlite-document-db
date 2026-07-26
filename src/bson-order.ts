/**
 * MongoDB's BSON comparison order, in JavaScript.
 *
 * This is the twin of `bsonRankSql`/`bsonValueSql` in src/query.ts, and
 * the two MUST agree: a `$sort` stage that runs in SQL (because it led the
 * pipeline) and one that runs here (because it followed a `$group`) have to
 * order identically, or the same pipeline gives different answers depending on
 * a detail the caller cannot see.
 *
 *   null/missing < numbers < strings < objects < arrays < booleans < dates
 *
 * Known divergence, shared with the SQL side: MongoDB compares two ARRAYS
 * element by element (and sorts an array FIELD by its smallest or largest
 * element, depending on direction); here arrays rank as a group and compare by
 * their JSON text. `strict: true` rejects the sorts where that shows.
 */

/** Where a value sits in the BSON type order. Missing sorts with null. */
export function bsonRank (value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return 1
  if (typeof value === 'string') return 2
  if (value instanceof Date) return 6
  if (Array.isArray(value)) return 4
  if (typeof value === 'boolean') return 5
  return 3 // object
}

/** Total order over stored values. Returns -1, 0 or 1. */
export function compareBson (a: unknown, b: unknown): number {
  const rankA = bsonRank(a)
  const rankB = bsonRank(b)
  if (rankA !== rankB) return rankA < rankB ? -1 : 1

  switch (rankA) {
    case 0: return 0
    case 1: {
      const x = a as number
      const y = b as number
      return x === y ? 0 : (x < y ? -1 : 1)
    }
    case 2: return compareStrings(a as string, b as string)
    case 5: return Number(a) - Number(b)
    case 6: {
      const x = (a as Date).getTime()
      const y = (b as Date).getTime()
      return x === y ? 0 : (x < y ? -1 : 1)
    }
    default: {
      // Objects and arrays: JSON text, matching what the SQL side compares.
      const x = JSON.stringify(a)
      const y = JSON.stringify(b)
      return x === y ? 0 : (x < y ? -1 : 1)
    }
  }
}

/**
 * Strings in code-POINT order, which is what both sides of the comparison do:
 * MongoDB's default collation compares the UTF-8 encoding byte by byte, and so
 * does SQLite's BINARY collation, and UTF-8 byte order IS code-point order.
 *
 * JavaScript's `<` compares UTF-16 code UNITS, which is NOT the same thing. A
 * character outside the BMP is a surrogate pair, and a high surrogate
 * (U+D800..U+DBFF) sorts BELOW U+E000..U+FFFF as a code unit where the code
 * point it introduces (>= U+10000) sorts above them. So `'🚀' < '�'` in
 * JavaScript and `'�' < '🚀'` in both engines - which made a $sort that
 * ran in SQL and a $sort that ran here (because it followed a $group) order the
 * same two values differently. Pinned by test/unicode.spec.ts.
 */
function compareStrings (x: string, y: string): number {
  if (x === y) return 0
  const shared = Math.min(x.length, y.length)
  for (let i = 0; i < shared; i++) {
    const a = x.charCodeAt(i)
    const b = y.charCodeAt(i)
    if (a === b) continue
    return codeUnitRank(a) < codeUnitRank(b) ? -1 : 1
  }
  return x.length < y.length ? -1 : 1
}

// Lifts a high surrogate to where the code point it begins actually sits. Only
// the FIRST differing unit is ever ranked, and at that position a low surrogate
// is always preceded by an identical high surrogate in both strings, so the
// pair's remainder compares correctly as itself.
function codeUnitRank (unit: number): number {
  return unit >= 0xD800 && unit <= 0xDBFF ? unit + 0x10000 : unit
}

/** Deep equality under the same rules - the identity `$addToSet` dedupes on. */
export function equalsBson (a: unknown, b: unknown): boolean {
  return compareBson(a, b) === 0
}
