/**
 * Typed filters and update documents (BACKLOG item 5b).
 *
 * The point of these types is to catch the two mistakes a `Record<string, any>`
 * filter cannot: a **misspelled field** (`{ qtyy: { $lt: 30 } }`) and a **wrong
 * operator value** (`{ qty: { $lt: 'thirty' } }`). Both used to compile happily
 * and then quietly match nothing.
 *
 * Two rules shaped everything here:
 *
 * 1. **Never over-promise.** Only operators this library actually implements
 *    appear. The MongoDB driver's own `Filter` advertises `$expr`, `$text`,
 *    `$where`, `$jsonSchema` and the geo operators, none of which exist here -
 *    a type that says "this compiles" about a query that throws at runtime is
 *    worse than no type at all. (DR-2 permits vendoring the driver's
 *    declarations - Apache-2.0 - and `AlternativeType`/`RegExpOrString` below
 *    are adapted from them, because they describe exactly the implicit
 *    array-element and regex matching this library gained in items 3 and 8.)
 *
 * 2. **An untyped collection must keep working.** `Collection<Document>` is the
 *    default, `Document` has an index signature, and every helper below detects
 *    that (`IsAny`, and `keyof T & string` widening to `string`) and degrades to
 *    the permissive behaviour callers have today. Turning on the types is
 *    opt-in, by passing a schema to `db.collection<User>('users')`.
 */

import type { Document, WithoutId } from './types.js'

/** True only for `any` - `any` matches both branches of a conditional. */
type IsAny<T> = 0 extends 1 & T ? true : false

/**
 * Recursion budget for path expansion. A hard bound is not optional: a schema
 * with a self-referential field would otherwise make the compiler diverge.
 * Four levels covers `a.b.c.d`, past which callers can fall back to `Document`.
 */
type Prev = [never, 0, 1, 2, 3, 4]
type Depth = 0 | 1 | 2 | 3 | 4

/** Values that are the end of a path rather than something to descend into. */
type Leaf = string | number | boolean | bigint | symbol | Date | Uint8Array | null | undefined

/**
 * Every dot-notation path into `T`: `'size'`, `'size.uom'`, `'tags.0'`.
 *
 * Arrays contribute their element's paths BOTH with and without an index, so
 * `'instock.qty'` and `'instock.0.qty'` are equally valid - MongoDB matches an
 * array of embedded documents either way, and so does this library.
 */
export type Paths<T, D extends Depth = 4> =
  IsAny<T> extends true ? string
    : [D] extends [never] ? never
      : T extends Leaf ? never
        : T extends ReadonlyArray<infer U>
          ? `${number}` | `${number}.${Paths<U, Prev[D]>}` | Paths<U, Prev[D]>
          : T extends object
            ? { [K in keyof T & string]-?: K | `${K}.${Paths<T[K], Prev[D]>}` }[keyof T & string]
            : never

/** The type stored at a dot-notation path, or `any` for an unknown schema. */
export type PathValue<T, P> =
  IsAny<T> extends true ? any
    : P extends `${infer Key}.${infer Rest}`
      ? T extends ReadonlyArray<infer U>
        ? Key extends `${number}` ? PathValue<U, Rest> : PathValue<U, P>
        : Key extends keyof T ? PathValue<NonNullable<T[Key]>, Rest> : any
      : T extends ReadonlyArray<infer U>
        ? P extends `${number}` ? U : PathValue<U, P>
        : P extends keyof T ? T[P] : any

/** A string field can also be matched by a regular expression. */
type RegExpOrString<T> = T extends string ? RegExp | T : T

/**
 * What a field of type `T` may be compared against.
 *
 * For an array field this is the array itself OR one of its elements, which is
 * MongoDB's implicit array-element matching: `{ tags: 'B' }` matches a document
 * whose `tags` array contains `'B'`.
 */
export type AlternativeType<T> =
  T extends ReadonlyArray<infer U> ? T | RegExpOrString<U> : RegExpOrString<T>

/** BSON type names and codes `$type` accepts (see TYPE_ALIAS_BY_CODE). */
export type BsonTypeAlias =
  | 'double' | 'string' | 'object' | 'array' | 'binData' | 'undefined' | 'objectId'
  | 'bool' | 'date' | 'null' | 'regex' | 'dbPointer' | 'javascript' | 'symbol'
  | 'javascriptWithScope' | 'int' | 'timestamp' | 'long' | 'decimal'
  | 'minKey' | 'maxKey' | 'number'

/** The operators this library implements, typed against the field they apply to. */
export interface FilterOperators<TValue> {
  $eq?: TValue
  $gt?: TValue
  $gte?: TValue
  $lt?: TValue
  $lte?: TValue
  $ne?: TValue
  $in?: readonly TValue[]
  $nin?: readonly TValue[]
  $exists?: boolean
  $type?: BsonTypeAlias | number | ReadonlyArray<BsonTypeAlias | number>
  $regex?: RegExp | string
  /** Regex flags. Only valid alongside `$regex`, and not when it is a RegExp. */
  $options?: string
  /** `[divisor, remainder]`. */
  $mod?: [number, number]
  $all?: readonly unknown[]
  $elemMatch?: Document
  $size?: number
  $not?: FilterOperators<TValue> | RegExp
  /** A bitmask, or an array of bit positions. */
  $bitsAllSet?: number | readonly number[]
  $bitsAnySet?: number | readonly number[]
  $bitsAllClear?: number | readonly number[]
  $bitsAnyClear?: number | readonly number[]
}

/** A filter's value for one field: a literal to match, or operators. */
export type Condition<T> = AlternativeType<T> | FilterOperators<AlternativeType<T>>

/** Operators that take whole sub-filters rather than applying to a field. */
export interface RootFilterOperators<TSchema> {
  $and?: ReadonlyArray<Filter<TSchema>>
  $or?: ReadonlyArray<Filter<TSchema>>
  $nor?: ReadonlyArray<Filter<TSchema>>
  /**
   * An aggregation expression used as a filter - the way to compare two fields
   * of the same document. Deliberately typed loosely: the expression language
   * is a second grammar (see src/expression.ts), and a half-typed version of it
   * would promise more than it checks.
   */
  $expr?: Document
  /** A note for whoever reads the query log. It selects nothing. */
  $comment?: unknown
  /** Keep each document with this probability, from 0 to 1. */
  $sampleRate?: number
}

/**
 * `_id` is whatever the schema says it is, and unconstrained otherwise.
 *
 * The library generates ObjectId hex strings, but any storable value works as
 * an `_id` and the specs rely on numeric ones. Rather than pretend otherwise,
 * an undeclared `_id` stays `any` (BACKLOG item 17 tracks specifying this).
 */
export type InferIdType<TSchema> = TSchema extends { _id: infer Id } ? Id : any

type FilterSchema<TSchema> = Omit<TSchema, '_id'> & { _id: InferIdType<TSchema> }

/**
 * A MongoDB filter document, typed against `TSchema`.
 *
 * With the default `Document` schema this is equivalent to the old
 * `Record<string, any>`, so untyped code is unaffected.
 */
export type Filter<TSchema = Document> =
  IsAny<TSchema> extends true ? Record<string, any>
    : {
        [P in Paths<FilterSchema<TSchema>>]?: Condition<PathValue<FilterSchema<TSchema>, P>>
      } & RootFilterOperators<TSchema>

/** Paths of `TSchema` whose value is a number - the only thing `$inc` accepts. */
export type NumericPaths<TSchema> =
  IsAny<TSchema> extends true ? string
    : {
        [P in Paths<TSchema>]: NonNullable<PathValue<TSchema, P>> extends number ? P : never
      }[Paths<TSchema>]

/** `{ path: value }` for `$set`/`$setOnInsert`, each value typed to its path. */
export type MatchKeysAndValues<TSchema> =
  IsAny<TSchema> extends true ? Record<string, any>
    : { [P in Paths<TSchema>]?: PathValue<TSchema, P> } &
    // A positional path writes into an array element, whose own schema is not
    // tracked through the segment - see PositionalPaths.
    { [P in PositionalPaths<TSchema>]?: any }

/** Paths of `TSchema` whose value is an array - what the array operators accept. */
export type ArrayPaths<TSchema> =
  IsAny<TSchema> extends true ? string
    : {
        [P in Paths<TSchema>]: NonNullable<PathValue<TSchema, P>> extends ReadonlyArray<any> ? P : never
      }[Paths<TSchema>]

/** The element type of the array at `P`, or `any` for an unknown schema. */
type ElementOf<TSchema, P> =
  IsAny<TSchema> extends true ? any
    : NonNullable<PathValue<TSchema, P>> extends ReadonlyArray<infer U> ? U : never

/**
 * A `$push` operand: one element, or `$each` with the modifiers this library
 * implements.
 */
export type PushOperand<T> = T | {
  $each: readonly T[]
  /** Keep the first n elements, or the last n when negative. */
  $slice?: number
  /** 1/-1 sorts the elements themselves; a document sorts by a field of each. */
  $sort?: 1 | -1 | Record<string, 1 | -1>
  /** Insert at this index instead of appending; negative counts from the end. */
  $position?: number
}

/**
 * The positional forms an UPDATE may write through: `$` (the element the query
 * matched), `$[]` (every element) and `$[<identifier>]` (those an
 * `arrayFilters` entry names).
 *
 * Deliberately confined to the update side. In a FILTER these are not operators
 * at all, so admitting them to `Paths` would make a query that throws compile -
 * which rule 1 at the top of this file forbids.
 */
type PositionalSegment = '$' | '$[]' | `$[${string}]`

/**
 * Positional paths of `TSchema`: an array path, the segment, and optionally a
 * path inside the element. The tail is `string` because the element's own
 * schema is not tracked through the segment - a wrong field there is a runtime
 * error rather than a compile one, which is the honest limit of this.
 */
export type PositionalPaths<TSchema> =
  IsAny<TSchema> extends true ? never
    : ArrayPaths<TSchema> extends infer A
      ? A extends string ? `${A}.${PositionalSegment}` | `${A}.${PositionalSegment}.${string}` : never
      : never

/**
 * A `$bit` operand: at least one of the three operations, applied in the order
 * they are written. Spelled as a union so `{}` does not compile - MongoDB
 * rejects an empty one too.
 */
export type BitOperation =
  | { and: number, or?: number, xor?: number }
  | { or: number, and?: number, xor?: number }
  | { xor: number, and?: number, or?: number }

/** An `$addToSet` operand: one element, or `$each` with several. */
export type AddToSetOperand<T> = T | { $each: readonly T[] }

/**
 * A `$pull` operand: a value to remove, or a criterion matched against each
 * element the way `$elemMatch` matches one.
 */
export type PullOperand<T> = T | FilterOperators<T> | Document

/**
 * An update document. Only the operators this library implements appear, and
 * each is restricted to the paths it can apply to - `$inc` to numeric ones,
 * the array operators to array ones - because a `$inc` on a string field or a
 * `$push` onto a number is a runtime error, so it should not compile either.
 */
export type UpdateFilter<TSchema = Document> =
  IsAny<TSchema> extends true ? Record<string, any>
    : {
      $set?: MatchKeysAndValues<Omit<TSchema, '_id'>>
      $setOnInsert?: MatchKeysAndValues<TSchema>
      $unset?: { [P in Paths<Omit<TSchema, '_id'>> | PositionalPaths<Omit<TSchema, '_id'>>]?: '' | true | 1 }
      $inc?: { [P in NumericPaths<Omit<TSchema, '_id'>> | PositionalPaths<Omit<TSchema, '_id'>>]?: number }
      $mul?: { [P in NumericPaths<Omit<TSchema, '_id'>> | PositionalPaths<Omit<TSchema, '_id'>>]?: number }
      $min?: MatchKeysAndValues<Omit<TSchema, '_id'>>
      $max?: MatchKeysAndValues<Omit<TSchema, '_id'>>
      $rename?: { [P in Paths<Omit<TSchema, '_id'>>]?: string }
      /** Sets the field to the current time. `{ $type: 'timestamp' }` is refused. */
      $currentDate?: {
        [P in Paths<Omit<TSchema, '_id'>> | PositionalPaths<Omit<TSchema, '_id'>>]?: boolean | { $type: 'date' }
      }
      /** Bitwise AND/OR/XOR against a whole-number field. */
      $bit?: {
        [P in NumericPaths<Omit<TSchema, '_id'>> | PositionalPaths<Omit<TSchema, '_id'>>]?: BitOperation
      }
      $push?: { [P in ArrayPaths<Omit<TSchema, '_id'>>]?: PushOperand<ElementOf<TSchema, P>> }
      $addToSet?: { [P in ArrayPaths<Omit<TSchema, '_id'>>]?: AddToSetOperand<ElementOf<TSchema, P>> }
      $pop?: { [P in ArrayPaths<Omit<TSchema, '_id'>>]?: 1 | -1 }
      $pull?: { [P in ArrayPaths<Omit<TSchema, '_id'>>]?: PullOperand<ElementOf<TSchema, P>> }
      $pullAll?: { [P in ArrayPaths<Omit<TSchema, '_id'>>]?: ReadonlyArray<ElementOf<TSchema, P>> }
    }

/**
 * One entry of a `bulkWrite` batch. Exactly one key, as MongoDB requires.
 *
 * Here rather than in types.ts so its filters and updates get the SAME schema
 * types as the standalone `updateOne`/`replaceOne`/`deleteOne` - a misspelled
 * field or wrong-typed value inside `bulkWrite` fails to compile just as it does
 * outside it, instead of being waved through as a bare `Document`.
 */
export type AnyBulkWriteOperation<TSchema extends Document = Document> =
  | { insertOne: { document: TSchema } }
  | { updateOne: { filter: Filter<TSchema>, update: UpdateFilter<TSchema> | Document[], upsert?: boolean } }
  | { updateMany: { filter: Filter<TSchema>, update: UpdateFilter<TSchema> | Document[], upsert?: boolean } }
  | { replaceOne: { filter: Filter<TSchema>, replacement: WithoutId<TSchema>, upsert?: boolean } }
  | { deleteOne: { filter: Filter<TSchema> } }
  | { deleteMany: { filter: Filter<TSchema> } }
