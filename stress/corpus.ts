/**
 * The document corpus the stress suite runs everything over (BACKLOG item 34).
 *
 * These documents are deliberately hostile in the ways this library has
 * actually broken before - deep, wide, array-heavy, unicode-heavy - rather than
 * merely numerous. `bench/` already answers "is the index used" over 20k simple
 * documents; nothing answered "what does a 180-level document do to the
 * COMPILER", and every limit this project has hit has been of the second kind.
 *
 * Generation is deterministic (seeded LCG, no `Math.random`) so a failure
 * reproduces exactly, on the same principle as the benchmarks.
 */

/** How deeply a document may nest before src/ejson.ts rejects it. */
export const MAX_DEPTH = 200

/**
 * Nesting used by the `deep` shape.
 *
 * Under the cap with room to spare, because the shape adds levels of its own:
 * the document is level 1, each nested object is one more, and a Date leaf
 * costs another (it is stored as `{"$date": ...}`).
 */
export const DEEP_LEVELS = 180

/** Fields on the `wide` shape's top level. */
export const WIDE_FIELDS = 500

/** Elements in the `bigArray` shape's array. */
export const BIG_ARRAY_LENGTH = 5_000

const BASE_TIME = Date.UTC(2020, 0, 1)

export function makeRng (seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

// Three of the values below are invisible or indistinguishable on screen, so
// they are built rather than written: a list of trap characters nobody can read
// is a trap of its own.

/** e + COMBINING ACUTE: renders identically to 'caf\u00e9' and is a different string. */
const CAFE_NFD = 'cafe' + String.fromCodePoint(0x301)

/** Ranks above a high surrogate, which is what makes code-point order observable. */
const PRIVATE_USE = String.fromCodePoint(0xe000)

/** A NUL inside a string - legal in a document, fatal in a C string. */
const NUL = String.fromCodePoint(0)

/**
 * Strings chosen to exercise the paths test/unicode.spec.ts pins: nine scripts,
 * both normalisation forms of the same word, astral characters (which sort by
 * code POINT, not UTF-16 code unit), and a quote that has to survive being a
 * SQL string literal when it appears as a FIELD name.
 */
export const AWKWARD_STRINGS = [
  'plain',
  'caf\u00e9', // NFC: e-acute as ONE code point
  CAFE_NFD,
  '\u00dcnicode', '\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac', '\u0420\u0443\u0441\u0441\u043a\u0438\u0439', '\u65e5\u672c\u8a9e', '\ud55c\uad6d\uc5b4', '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', '\u0e44\u0e17\u0e22', '\u05e2\u05d1\u05e8\u05d9\u05ea',
  String.fromCodePoint(0x1f680) + ' astral', // a surrogate pair
  PRIVATE_USE + ' private use',
  "it's quoted", 'back\\slash', 'tab\there', 'new\nline', 'nul' + NUL + 'byte',
  '%wildcard%', '_under_', 'json{"looking":true}', '$dollar', 'dot.ted'
]

/** A chain of `levels` nested objects with a mixed leaf. Shape: `deep`. */
export function deepDocument (index: number, levels = DEEP_LEVELS): Record<string, any> {
  // Built from the inside out: recursion here would hit the same stack limit
  // the encoder does, and this generator must not be the thing that breaks.
  let node: any = {
    leaf: `leaf_${index}`,
    n: index,
    when: new Date(BASE_TIME + index * 86_400_000),
    tags: ['deep', AWKWARD_STRINGS[index % AWKWARD_STRINGS.length]!]
  }
  for (let level = levels; level > 0; level--) {
    node = { level, name: `n${level}`, child: node }
  }
  return { shape: 'deep', index, root: node }
}

/** `WIDE_FIELDS` fields at one level, of every storable type. Shape: `wide`. */
export function wideDocument (index: number, rng: () => number): Record<string, any> {
  const doc: Record<string, any> = { shape: 'wide', index }
  for (let field = 0; field < WIDE_FIELDS; field++) {
    const key = `f${field}`
    switch (field % 6) {
      case 0: doc[key] = Math.floor(rng() * 1_000); break
      case 1: doc[key] = AWKWARD_STRINGS[field % AWKWARD_STRINGS.length]!.repeat(4); break
      case 2: doc[key] = rng() > 0.5; break
      case 3: doc[key] = new Date(BASE_TIME + field * 3_600_000); break
      case 4: doc[key] = { a: field, b: { c: field * 2 } }; break
      default: doc[key] = [field, `${field}`, { n: field }]
    }
  }
  // A field named like an operator, and one that looks like the Date wrapper's
  // sibling - both are ordinary data the compiler must not treat as syntax.
  doc.notAnOperator = { $notAnOp: 1 }
  doc.almostADate = { $date: 'not-a-date', extra: true }
  return doc
}

/**
 * Arrays of documents holding arrays of documents holding arrays. Shape:
 * `nested`.
 *
 * THREE array levels on purpose: `MAX_ARRAY_PATH_DEPTH` expands two, so
 * `orders.lines.parts.sku` is exactly the dotted path the compiler declines to
 * expand - and which `strict: true` refuses rather than under-matching.
 */
export function nestedDocument (index: number, rng: () => number): Record<string, any> {
  const orders = Array.from({ length: 8 }, (_, o) => ({
    id: `o${index}_${o}`,
    placed: new Date(BASE_TIME + (index * 8 + o) * 3_600_000),
    total: Math.round(rng() * 10_000) / 100,
    lines: Array.from({ length: 6 }, (_line, l) => ({
      sku: `sku_${index}_${o}_${l}`,
      qty: Math.floor(rng() * 20),
      uom: l % 2 === 0 ? 'cm' : 'in',
      parts: Array.from({ length: 4 }, (_part, p) => ({
        sku: `part_${o}_${l}_${p}`,
        weight: Math.round(rng() * 500) / 10,
        tags: [AWKWARD_STRINGS[(o + l + p) % AWKWARD_STRINGS.length]!, p % 2 === 0 ? 'even' : 'odd']
      }))
    }))
  }))
  return {
    shape: 'nested',
    index,
    customer: { name: AWKWARD_STRINGS[index % AWKWARD_STRINGS.length]!, since: new Date(BASE_TIME) },
    orders,
    // One order marked so a positional update has a single unambiguous target.
    marker: `mark_${index}`
  }
}

/** One array of `BIG_ARRAY_LENGTH` elements. Shape: `bigArray`. */
export function bigArrayDocument (index: number, rng: () => number): Record<string, any> {
  return {
    shape: 'bigArray',
    index,
    values: Array.from({ length: BIG_ARRAY_LENGTH }, (_, i) => Math.floor(rng() * 100_000) + i),
    docs: Array.from({ length: 200 }, (_, i) => ({ i, name: `d${i}`, ok: i % 3 === 0 })),
    label: AWKWARD_STRINGS[index % AWKWARD_STRINGS.length]!
  }
}

/** A moderately nested, realistic document - the aggregation sweep's input. Shape: `mixed`. */
export function mixedDocument (index: number, rng: () => number): Record<string, any> {
  return {
    shape: 'mixed',
    index,
    item: `item_${index}`,
    qty: Math.floor(rng() * 500),
    price: Math.round(rng() * 10_000) / 100,
    status: ['A', 'B', 'C', 'D'][index % 4],
    label: AWKWARD_STRINGS[index % AWKWARD_STRINGS.length]!,
    tags: [`t${index % 7}`, `t${index % 3}`, index % 50 === 0 ? 'rare' : 'common'],
    size: { h: Math.floor(rng() * 50), w: Math.floor(rng() * 50), uom: index % 2 === 0 ? 'cm' : 'in' },
    instock: Array.from({ length: 4 }, (_, w) => ({ warehouse: `w${w}`, qty: Math.floor(rng() * 100) })),
    createdAt: new Date(BASE_TIME + index * 60_000),
    scores: Array.from({ length: 10 }, () => Math.floor(rng() * 100))
  }
}

export type Shape = 'deep' | 'wide' | 'nested' | 'bigArray' | 'mixed'

/**
 * The whole corpus, as one array.
 *
 * `count` is the number of documents of EACH cheap shape; the expensive ones
 * (`wide`, `bigArray`) are scaled down, because a thousand 500-field documents
 * measures the generator rather than the library.
 */
export function makeCorpus (count: number, seed = 1): Array<Record<string, any>> {
  const rng = makeRng(seed)
  const docs: Array<Record<string, any>> = []
  for (let i = 0; i < count; i++) docs.push(mixedDocument(i, rng))
  for (let i = 0; i < count; i++) docs.push(nestedDocument(i, rng))
  for (let i = 0; i < Math.max(1, Math.floor(count / 10)); i++) docs.push(deepDocument(i))
  for (let i = 0; i < Math.max(1, Math.floor(count / 20)); i++) docs.push(wideDocument(i, rng))
  for (let i = 0; i < Math.max(1, Math.floor(count / 100)); i++) docs.push(bigArrayDocument(i, rng))
  return docs
}
