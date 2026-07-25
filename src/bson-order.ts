/**
 * MongoDB's BSON comparison order, in JavaScript.
 *
 * This is the twin of `bsonRankSql`/`bsonValueSql` in src/query/query.ts, and
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
    case 2: {
      // Code-unit order, which is what SQLite's BINARY collation does too.
      const x = a as string
      const y = b as string
      return x === y ? 0 : (x < y ? -1 : 1)
    }
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

/** Deep equality under the same rules - the identity `$addToSet` dedupes on. */
export function equalsBson (a: unknown, b: unknown): boolean {
  return compareBson(a, b) === 0
}
