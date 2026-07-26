/**
 * Prototype-safe writes for objects keyed by user-supplied names.
 *
 * A document field or a dotted-path segment can be any string, `__proto__`
 * included. Assigning `obj[key] = value` with `key === '__proto__'` does NOT
 * create a field - it invokes the inherited accessor and rewrites the object's
 * prototype. When the object being written is an intermediate node reached by
 * walking a dotted path, that prototype is the shared `Object.prototype`, so a
 * field name like `__proto__.polluted` poisons every object in the process.
 * This is prototype pollution, and it is also a divergence from MongoDB, which
 * stores `__proto__` as an ordinary field and pollutes nothing.
 *
 * `setField` creates the field as an own data property whatever its name, so
 * both problems go away at once. Only `__proto__` needs the guard: `constructor`
 * and `prototype` are ordinary data members of `Object.prototype`, so assigning
 * them already shadows with an own property rather than mutating anything.
 * `ownField` is its read twin, used when walking a path so an INHERITED member
 * is never mistaken for a field that is actually present.
 */

export function setField (target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
  } else {
    target[key] = value
  }
}

/** The own value stored at `key`, or `undefined` when it is only inherited. */
export function ownField (source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined
}
