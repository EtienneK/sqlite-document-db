/**
 * MongoDB projection semantics (BACKLOG item 7), applied in JS to each
 * decoded document rather than in SQL: reconstructing nested inclusions with
 * json_object cannot distinguish a missing field from a null one (MongoDB
 * omits missing fields), and dotted paths project INTO arrays of embedded
 * documents - both trivial on the decoded document.
 *
 * Supported: inclusion ({ a: 1 }), exclusion ({ a: 0 }), the _id exemption,
 * dotted paths (including through arrays of documents). Not supported yet:
 * $slice, $elemMatch and $ positional projection.
 */

export type ProjectionSpec = Record<string, any>

interface Tree { [key: string]: true | Tree }

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
    if (existing === undefined) node[segment] = {}
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

/**
 * Compiles a projection specification into a function applied to each result
 * document. Throws on inclusion/exclusion mixes (except _id) and unsupported
 * values, like MongoDB.
 */
export function compileProjection (spec: ProjectionSpec): (doc: any) => any {
  const entries = Object.entries(spec)

  let includeCount = 0
  let excludeCount = 0
  for (const [field, value] of entries) {
    if (typeof value !== 'number' && typeof value !== 'boolean') {
      throw Error(`unsupported projection value for field ${field}: ${JSON.stringify(value)} ($-operators are not supported yet)`)
    }
    if (field === '_id') continue
    if (value) includeCount++
    else excludeCount++
  }
  if (includeCount > 0 && excludeCount > 0) {
    throw Error('Cannot do inclusion and exclusion in the same projection (except for _id)')
  }

  const idValue = spec._id
  // With only _id in the spec, its value decides the mode ({ _id: 0 } is a
  // valid exclusion projection; { _id: 1 } a valid inclusion one).
  const include = includeCount > 0 || (excludeCount === 0 && Boolean(idValue ?? false))
  const keepId = idValue === undefined ? true : Boolean(idValue)

  const tree: Tree = {}
  for (const [field, value] of entries) {
    if (field === '_id') continue
    if (Boolean(value) === include) addPath(tree, field)
  }

  return (doc: any): any => {
    if (doc === null || typeof doc !== 'object') return doc
    const projected = include ? projectInclude(doc, tree) : projectExclude(doc, tree)
    if (include && keepId && '_id' in doc) return { _id: doc._id, ...projected }
    if (!include && !keepId) delete projected._id
    return projected
  }
}
