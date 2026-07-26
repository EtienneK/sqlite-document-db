/**
 * MongoDB projection semantics (BACKLOG item 7), applied in JS to each
 * decoded document rather than in SQL: reconstructing nested inclusions with
 * json_object cannot distinguish a missing field from a null one (MongoDB
 * omits missing fields), and dotted paths project INTO arrays of embedded
 * documents - both trivial on the decoded document.
 *
 * Supported: inclusion (`{ a: 1 }`), exclusion (`{ a: 0 }`), the `_id`
 * exemption, dotted paths (including through arrays of documents), and the
 * three `$`-operators: `$slice`, `$elemMatch` and `$` positional.
 *
 * **The `$`-operators do not decide which element matches; SQLite does.**
 * `$elemMatch` and `$` both need "the first element of this array satisfying a
 * criterion", and the criterion is written in the filter language - so
 * answering it here would mean a JavaScript re-implementation of that language,
 * the one thing this library refuses to have twice (see the note on
 * mid-pipeline `$match` in CLAUDE.md). Instead a compiled projection declares
 * what it needs as `probes`, the caller compiles each into an extra column of
 * the query it was already running (`firstMatchingElementSql` in query.ts), and
 * `project()` is handed the resulting indexes. One statement, one matcher.
 */

export type ProjectionSpec = Record<string, any>

/**
 * A question for the query engine: the index of the first element of `path`
 * satisfying `criterion`, per document, or null when nothing does.
 */
export interface ElementProbe {
  path: string
  /** An element criterion, in the same shape `$elemMatch` takes in a filter. */
  criterion: Record<string, any>
}

export interface CompiledProjection {
  /** What `project` needs resolved per document. Empty for ordinary projections. */
  readonly probes: readonly ElementProbe[]
  /** `indexes[i]` answers `probes[i]` for this document. */
  project: (doc: any, indexes?: ReadonlyArray<number | null>) => any
}

/**
 * A node of the compiled path tree.
 *
 * ALWAYS built with `Object.create(null)`. The tree is keyed by user-supplied
 * field names and looked up with the DOCUMENT's field names, so an ordinary
 * object would answer both from `Object.prototype`: a document field called
 * `toString` would find a function where a subtree was expected and be
 * projected as `{}`, and a projection of `{ '__proto__.x': 1 }` would walk into
 * `Object.prototype` and write to it - prototype pollution from a projection
 * spec, which in a web application can come straight from a query string.
 */
interface Tree { [key: string]: true | Tree }

function emptyTree (): Tree {
  return Object.create(null) as Tree
}

/** A value projection can descend into (excludes Dates, which decode as objects). */
function isProjectable (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

function addPath (tree: Tree, field: string): void {
  const segments = field.split('.')
  let node: Tree = tree
  for (const segment of segments.slice(0, -1)) {
    const existing = node[segment]
    if (existing === true) throw Error(`Path collision at ${field}`) // e.g. { a: 1, 'a.b': 1 }
    if (existing === undefined) node[segment] = emptyTree()
    node = node[segment] as Tree
  }
  const leaf = segments[segments.length - 1]!
  if (node[leaf] !== undefined) throw Error(`Path collision at ${field}`)
  node[leaf] = true
}

function projectInclude (value: Record<string, unknown> | unknown[], tree: Tree): any {
  if (Array.isArray(value)) {
    // MongoDB projects into arrays of documents, dropping non-document elements.
    return value.filter(isProjectable).map(element => projectInclude(element, tree))
  }
  const result: Record<string, unknown> = {}
  // Iterating the DOCUMENT's keys (not the tree's) preserves field order.
  for (const [key, fieldValue] of Object.entries(value)) {
    const subtree = tree[key]
    if (subtree === undefined) continue
    if (subtree === true) {
      result[key] = fieldValue
    } else if (Array.isArray(fieldValue) || isProjectable(fieldValue)) {
      result[key] = projectInclude(fieldValue, subtree)
    }
    // A scalar with a deeper path requested is omitted, like MongoDB.
  }
  return result
}

function projectExclude (value: Record<string, unknown> | unknown[], tree: Tree): any {
  if (Array.isArray(value)) {
    // In exclusion mode non-document elements are KEPT.
    return value.map(element => (Array.isArray(element) || isProjectable(element)) ? projectExclude(element, tree) : element)
  }
  const result: Record<string, unknown> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    const subtree = tree[key]
    if (subtree === true) continue
    if (subtree === undefined) {
      result[key] = fieldValue
    } else {
      result[key] = (Array.isArray(fieldValue) || isProjectable(fieldValue)) ? projectExclude(fieldValue, subtree) : fieldValue
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// The $-operators
// ---------------------------------------------------------------------------

type Directive =
  /** `{ tags: { $slice: 2 } }` - a window over the array, in place. */
  | { kind: 'slice', field: string, skip: number, limit: number }
  /** `{ grades: { $elemMatch: {...} } }` - the first element matching a criterion. */
  | { kind: 'element', field: string, probe: number }

/**
 * `$slice`, as a skip and a limit.
 *
 * `{ $slice: n }` takes the first n, or the LAST |n| when negative;
 * `{ $slice: [skip, limit] }` takes a window, and a negative skip counts from
 * the end. Both verified against the server, including the edges: skipping past
 * the end gives `[]`, and a limit past the end just stops.
 */
function parseSlice (field: string, value: unknown): Directive {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw Error(`$slice takes a whole number; but got: ${value} (at ${field})`)
    return value < 0
      ? { kind: 'slice', field, skip: value, limit: Math.abs(value) }
      : { kind: 'slice', field, skip: 0, limit: value }
  }
  if (Array.isArray(value) && value.length === 2) {
    const [skip, limit] = value
    if (!Number.isInteger(skip) || !Number.isInteger(limit) || limit < 0) {
      throw Error(`$slice takes [<skip>, <limit>] as whole numbers with a non-negative limit (at ${field})`)
    }
    return { kind: 'slice', field, skip, limit }
  }
  throw Error(`$slice takes a whole number or [<skip>, <limit>]; but got: ${JSON.stringify(value)} (at ${field})`)
}

function applySlice (value: unknown, skip: number, limit: number): unknown {
  // A non-array is left ALONE rather than removed - verified against the server.
  if (!Array.isArray(value)) return value
  const start = skip < 0 ? Math.max(value.length + skip, 0) : skip
  return value.slice(start, start + limit)
}

/**
 * The element criterion the `$` positional operator matches with: the parts of
 * the FILTER that constrain the projected array.
 *
 * `{ 'grades.score': { $gt: 80 } }` with `{ 'grades.$': 1 }` means "the first
 * grade scoring over 80", so the condition has to be recovered from the query.
 * `$and` is traversed (it is just a conjunction); `$or` is not, because no
 * single branch is the one that matched. A filter that says nothing about the
 * array is an error here exactly as it is on the server, rather than a
 * projection that quietly returns the first element.
 */
function positionalCriterion (filter: Record<string, any>, field: string): Record<string, any> {
  const criterion: Record<string, any> = {}
  let found = false

  const visit = (node: Record<string, any>): void => {
    for (const [key, value] of Object.entries(node ?? {})) {
      if (key === '$and' && Array.isArray(value)) {
        for (const branch of value) visit(branch)
        continue
      }
      if (key === field) {
        found = true
        if (value instanceof RegExp) criterion.$regex = value
        else if (isProjectable(value)) {
          const inner = Object.keys(value).some(k => k.startsWith('$'))
            ? ((value as Record<string, any>).$elemMatch ?? value)
            : { $eq: value }
          Object.assign(criterion, inner)
        } else criterion.$eq = value
      } else if (key.startsWith(`${field}.`)) {
        found = true
        criterion[key.slice(field.length + 1)] = value
      }
    }
  }
  visit(filter)

  if (!found) {
    throw Error(
      `positional projection '${field}.$' needs the query to constrain '${field}' - ` +
      'there is no matching element without a condition to match'
    )
  }
  return criterion
}

/** Reads a dotted path out of a projected document. */
function getPath (doc: any, field: string): unknown {
  let node = doc
  for (const segment of field.split('.')) {
    if (!isProjectable(node)) return undefined
    node = node[segment]
  }
  return node
}

/** Writes (or removes) a dotted path in a document nothing else holds. */
function setPath (doc: any, field: string, value: unknown, remove = false): void {
  const segments = field.split('.')
  let node = doc
  for (const segment of segments.slice(0, -1)) {
    if (!isProjectable(node[segment])) return
    node = node[segment]
  }
  const leaf = segments[segments.length - 1]!
  if (remove) delete node[leaf]
  else if (leaf in node || !remove) node[leaf] = value
}

// ---------------------------------------------------------------------------

/**
 * Compiles a projection specification.
 *
 * `filter` is the query the projection accompanies, needed only by the `$`
 * positional operator. Throws on inclusion/exclusion mixes (except `_id`),
 * path collisions and unsupported values, like MongoDB.
 */
export function compileProjection (spec: ProjectionSpec, filter: Record<string, any> = {}): CompiledProjection {
  const directives: Directive[] = []
  const probes: ElementProbe[] = []
  const plain: Array<[field: string, include: boolean]> = []
  let includeCount = 0
  let excludeCount = 0
  let positionalCount = 0
  let idValue: unknown

  for (const [field, value] of Object.entries(spec)) {
    // ---- the $ positional operator: { 'tags.$': 1 } ----
    if (field.endsWith('.$')) {
      if (typeof value !== 'number' && typeof value !== 'boolean') {
        throw Error(`positional projection '${field}' takes 1 or true; but got: ${JSON.stringify(value)}`)
      }
      if (!value) throw Error('positional projection cannot be used with exclusion')
      if (++positionalCount > 1) throw Error('Cannot specify more than one positional projection per query.')
      const target = field.slice(0, -2)
      if (target === '') throw Error("'$' is not a field path")
      probes.push({ path: target, criterion: positionalCriterion(filter, target) })
      directives.push({ kind: 'element', field: target, probe: probes.length - 1 })
      plain.push([target, true])
      includeCount++
      continue
    }

    // ---- $slice and $elemMatch ----
    if (isProjectable(value)) {
      const keys = Object.keys(value)
      const operator = keys[0]
      if (keys.length !== 1 || operator === undefined || !operator.startsWith('$')) {
        throw Error(`unsupported projection value for field ${field}: ${JSON.stringify(value)}`)
      }
      if (operator === '$slice') {
        // $slice decides NOTHING about inclusion or exclusion - it is a
        // transform. `{ tags: { $slice: 2 } }` alone returns whole documents
        // with `tags` shortened, which is why it does not touch the counts.
        directives.push(parseSlice(field, (value as Record<string, unknown>).$slice))
        continue
      }
      if (operator === '$elemMatch') {
        const criterion = (value as Record<string, unknown>).$elemMatch
        if (!isProjectable(criterion)) throw Error(`$elemMatch takes a criterion document (at ${field})`)
        probes.push({ path: field, criterion: criterion as Record<string, any> })
        directives.push({ kind: 'element', field, probe: probes.length - 1 })
        plain.push([field, true])
        includeCount++ // unlike $slice, $elemMatch IS an inclusion
        continue
      }
      throw Error(
        `unsupported projection operator: ${operator} (supported: $slice, $elemMatch, ` +
        "and '<field>.$' positional)"
      )
    }

    if (typeof value !== 'number' && typeof value !== 'boolean') {
      throw Error(`unsupported projection value for field ${field}: ${JSON.stringify(value)}`)
    }
    if (field === '_id') {
      idValue = value
      continue
    }
    if (value) includeCount++
    else excludeCount++
    plain.push([field, Boolean(value)])
  }

  if (includeCount > 0 && excludeCount > 0) {
    throw Error('Cannot do inclusion and exclusion in the same projection (except for _id)')
  }

  // With only _id in the spec, its value decides the mode ({ _id: 0 } is a
  // valid exclusion projection; { _id: 1 } a valid inclusion one). A spec of
  // nothing but $slice lands here too, as an exclusion of nothing - which is
  // exactly "every field, sliced".
  const include = includeCount > 0 || (excludeCount === 0 && Boolean(idValue ?? false))
  const keepId = idValue === undefined ? true : Boolean(idValue)

  const tree: Tree = emptyTree()
  for (const [field, wanted] of plain) {
    if (wanted === include) addPath(tree, field)
  }
  // A sliced field survives an inclusion projection: `{ name: 1, tags: {
  // $slice: 2 } }` returns both, so the slice target has to be in the tree.
  if (include) {
    for (const directive of directives) {
      if (directive.kind === 'slice') addPath(tree, directive.field)
    }
  }

  return {
    probes,
    project (doc: any, indexes: ReadonlyArray<number | null> = []): any {
      if (doc === null || typeof doc !== 'object') return doc
      let projected = include ? projectInclude(doc, tree) : projectExclude(doc, tree)
      if (include && keepId && '_id' in doc) projected = { _id: doc._id, ...projected }
      if (!include && !keepId) delete projected._id

      for (const directive of directives) {
        if (directive.kind === 'slice') {
          const current = getPath(projected, directive.field)
          if (current !== undefined) {
            setPath(projected, directive.field, applySlice(current, directive.skip, directive.limit))
          }
          continue
        }
        // $elemMatch / positional: the array is read from the ORIGINAL document
        // (the projected copy may hold a reshaped version of it), and a field
        // with no matching element is dropped rather than left empty.
        const index = indexes[directive.probe]
        const source = getPath(doc, directive.field)
        if (index == null || !Array.isArray(source)) setPath(projected, directive.field, undefined, true)
        else setPath(projected, directive.field, [source[index]])
      }
      return projected
    }
  }
}
