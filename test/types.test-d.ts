import { describe, expectTypeOf, it } from 'vitest'

import type { Collection, Db, Document, Filter, UpdateFilter, WithId } from '../src/index.js'

/**
 * Type-level tests for BACKLOG item 5b.
 *
 * The NEGATIVE cases are the feature. A filter type that accepts everything is
 * what this replaced, so every `@ts-expect-error` below is an assertion that a
 * mistake now fails to compile - and if the types ever go slack again, the
 * missing error turns `@ts-expect-error` itself into a compile error. The
 * positive cases exist to prove the types did not overshoot and start rejecting
 * queries that work.
 *
 * These run under `npm run test:types` (vitest --typecheck) and are also
 * checked by `npm run typecheck`, since @ts-expect-error is a tsc feature.
 */

interface Size { h: number, w: number, uom: string }
interface Stock { warehouse: string, qty: number }

interface Item {
  _id: string
  item: string
  qty: number
  status: 'A' | 'D'
  size: Size
  tags: string[]
  instock: Stock[]
  shipped?: Date
}

declare const db: Db
declare const col: Collection<Item>

describe('Filter<TSchema>', () => {
  it('types an operator against the field it applies to', async () => {
    await col.find({ qty: { $lt: 30 } }).toArray()
    await col.find({ qty: { $in: [10, 20] } }).toArray()
    await col.find({ status: 'A' }).toArray()
    await col.find({ item: /^p/ }).toArray() // regex on a string field
    await col.find({ shipped: { $gte: new Date() } }).toArray()
    await col.find({ qty: { $exists: true } }).toArray()
    await col.find({ tags: { $size: 2 } }).toArray()
    await col.find({ qty: { $mod: [4, 0] } }).toArray()
    await col.find({ status: { $type: 'string' } }).toArray()
  })

  it('rejects a misspelled field', async () => {
    // @ts-expect-error - 'qtyy' is not a field of Item
    await col.find({ qtyy: { $lt: 30 } }).toArray()
  })

  it('rejects a value of the wrong type', async () => {
    // @ts-expect-error - qty is a number
    await col.find({ qty: { $lt: 'thirty' } }).toArray()
    // @ts-expect-error - $in wants an array of the field's type
    await col.find({ qty: { $in: ['ten'] } }).toArray()
    // @ts-expect-error - status is a union of two literals
    await col.find({ status: 'Z' }).toArray()
    // @ts-expect-error - $exists is a boolean
    await col.find({ qty: { $exists: 'yes' } }).toArray()
    // @ts-expect-error - $size is a number
    await col.find({ tags: { $size: 'two' } }).toArray()
  })

  it('rejects an unknown operator', async () => {
    // @ts-expect-error - $gtt is not an operator
    await col.find({ qty: { $gtt: 1 } }).toArray()
    // @ts-expect-error - $where is deliberately not supported
    await col.find({ $where: 'this.qty > 1' }).toArray()
  })

  it('accepts the operators that ARE implemented', async () => {
    // $expr takes an aggregation expression, which is a second grammar - typed
    // loosely on purpose, because a half-typed version of it would promise
    // more than it checks.
    await col.find({ $expr: { $gt: ['$qty', 1] } }).toArray()
    await col.find({ qty: { $bitsAllSet: 0b101 } }).toArray()
    await col.find({ qty: { $bitsAnyClear: [0, 2] } }).toArray()
    // @ts-expect-error - a bitmask is a number or an array of bit positions
    await col.find({ qty: { $bitsAllSet: 'nope' } }).toArray()
  })

  it('types dot-notation paths against the nested schema', async () => {
    await col.find({ 'size.uom': 'cm' }).toArray()
    await col.find({ 'size.h': { $gt: 10 } }).toArray()
    await col.find({ 'tags.0': 'red' }).toArray()
    // Into an array of embedded documents, with or without an index
    await col.find({ 'instock.qty': { $gte: 5 } }).toArray()
    await col.find({ 'instock.0.warehouse': 'A' }).toArray()

    // @ts-expect-error - 'size.nope' is not a path
    await col.find({ 'size.nope': 1 }).toArray()
    // @ts-expect-error - size.h is a number
    await col.find({ 'size.h': 'tall' }).toArray()
  })

  it('allows an element where the field is an array (implicit matching)', async () => {
    await col.find({ tags: 'red' }).toArray() // matches an array containing 'red'
    await col.find({ tags: ['red', 'blue'] }).toArray() // ...or the array itself
    await col.find({ tags: /^r/ }).toArray()
    // @ts-expect-error - elements are strings
    await col.find({ tags: 42 }).toArray()
  })

  it('types the logical operators recursively', async () => {
    await col.find({ $or: [{ qty: { $lt: 10 } }, { status: 'D' }] }).toArray()
    await col.find({ $and: [{ $or: [{ qty: 1 }] }] }).toArray()
    // @ts-expect-error - the nested filter is checked too
    await col.find({ $or: [{ qtyy: 1 }] }).toArray()
  })

  it('leaves an untyped collection permissive', async () => {
    // The default schema has an index signature, so nothing is constrained -
    // this is what keeps existing untyped code compiling.
    const loose = db.collection('anything')
    await loose.find({ whatever: { $lt: 'mixed' } }).toArray()
    await loose.find({ 'deeply.nested.unknown.path': 1 }).toArray()
    expectTypeOf<Filter<Document>>().toExtend<Record<string, any>>()
  })
})

describe('UpdateFilter<TSchema>', () => {
  it('types $set values against their paths', async () => {
    await col.updateOne({ item: 'x' }, { $set: { qty: 5, 'size.uom': 'in' } })
    await col.updateOne({ item: 'x' }, { $unset: { shipped: '' } })
    await col.updateOne({ item: 'x' }, { $inc: { qty: 1, 'size.h': -1 } })
    await col.updateOne({ item: 'x' }, { $setOnInsert: { status: 'A' } }, { upsert: true })
  })

  it('rejects a $set value of the wrong type', async () => {
    // @ts-expect-error - qty is a number
    await col.updateOne({ item: 'x' }, { $set: { qty: 'five' } })
    // @ts-expect-error - 'nope' is not a path
    await col.updateOne({ item: 'x' }, { $set: { nope: 1 } })
  })

  it('restricts $inc to numeric paths', async () => {
    // @ts-expect-error - $inc on a string field is a runtime error, so it must
    // not compile either
    await col.updateOne({ item: 'x' }, { $inc: { item: 1 } })
  })

  it('rejects _id in $set and unsupported update operators', async () => {
    // @ts-expect-error - _id is immutable
    await col.updateOne({ item: 'x' }, { $set: { _id: 'other' } })
    // @ts-expect-error - $bit is not implemented
    await col.updateOne({ item: 'x' }, { $bit: { qty: { and: 1 } } })
  })

  it('types the array operators against the array they apply to', async () => {
    await col.updateOne({ item: 'x' }, { $push: { tags: 'new' } })
    await col.updateOne({ item: 'x' }, { $push: { tags: { $each: ['a', 'b'], $slice: -5 } } })
    await col.updateOne({ item: 'x' }, { $push: { instock: { $each: [{ warehouse: 'A', qty: 1 }], $sort: { qty: -1 } } } })
    await col.updateOne({ item: 'x' }, { $addToSet: { tags: { $each: ['a'] } } })
    await col.updateOne({ item: 'x' }, { $pop: { tags: -1 } })
    await col.updateOne({ item: 'x' }, { $pull: { instock: { qty: { $lt: 5 } } } })
    await col.updateOne({ item: 'x' }, { $pullAll: { tags: ['a', 'b'] } })
    await col.updateOne({ item: 'x' }, { $mul: { qty: 2 }, $rename: { status: 'state' } })
    await col.updateOne({ item: 'x' }, { $min: { qty: 1 }, $max: { shipped: new Date() } })
  })

  it('restricts the array operators to array paths and element types', async () => {
    // @ts-expect-error - qty is a number, not an array
    await col.updateOne({ item: 'x' }, { $push: { qty: 1 } })
    // @ts-expect-error - tags holds strings
    await col.updateOne({ item: 'x' }, { $push: { tags: 5 } })
    // @ts-expect-error - $each takes an array of the element type
    await col.updateOne({ item: 'x' }, { $addToSet: { tags: { $each: [1] } } })
    // @ts-expect-error - $pop takes 1 or -1
    await col.updateOne({ item: 'x' }, { $pop: { tags: 2 } })
    // @ts-expect-error - $mul on a string field is a runtime error
    await col.updateOne({ item: 'x' }, { $mul: { item: 2 } })
  })

  it('accepts $position and the positional operators', async () => {
    await col.updateOne({ item: 'x' }, { $push: { tags: { $each: ['a'], $position: 0 } } })
    await col.updateOne({ tags: 'a' }, { $set: { 'tags.$': 'b' } })
    await col.updateOne({ item: 'x' }, { $set: { 'tags.$[]': 'b' } })
    await col.updateOne({ item: 'x' }, { $set: { 'instock.$[w].qty': 1 } }, { arrayFilters: [{ 'w.qty': 0 }] })
    await col.updateOne({ item: 'x' }, { $inc: { 'instock.$[].qty': 1 } })
    await col.updateMany({ 'instock.qty': 0 }, { $unset: { 'instock.$.qty': '' } })
    // @ts-expect-error - 'nope' is not an array path, so it has no elements
    await col.updateOne({ item: 'x' }, { $set: { 'nope.$': 1 } })
    // @ts-expect-error - the positional operators are not filter syntax
    await col.find({ 'tags.$': 'a' }).toArray()
  })

  it('leaves an untyped collection permissive', async () => {
    const loose = db.collection('anything')
    await loose.updateOne({ a: 1 }, { $set: { whatever: 'goes' } })
    await loose.updateOne({ a: 1 }, { $push: { anything: 'goes' } })
    expectTypeOf<UpdateFilter<Document>>().toExtend<Record<string, any>>()
  })
})

describe('aggregate()', () => {
  it('returns a cursor of the requested shape', async () => {
    const totals = await col.aggregate<{ _id: string, total: number }>([
      { $group: { _id: '$item', total: { $sum: '$qty' } } }
    ]).toArray()
    expectTypeOf(totals).toEqualTypeOf<Array<{ _id: string, total: number }>>()
    expectTypeOf(col.aggregate([]).explain().pushedDown).toEqualTypeOf<number>()
  })

  it('defaults to Document, so an untyped pipeline stays permissive', async () => {
    const rows = await col.aggregate([{ $match: { qty: 1 } }]).toArray()
    expectTypeOf(rows[0]!.anythingAtAll).toEqualTypeOf<any>()
  })
})

describe('result types', () => {
  it('threads the schema through to the documents', async () => {
    expectTypeOf(await col.findOne({ item: 'x' })).toEqualTypeOf<WithId<Item> | null>()
    expectTypeOf(await col.find().toArray()).toEqualTypeOf<Array<WithId<Item>>>()
    expectTypeOf(await col.findOneAndDelete({ item: 'x' })).toEqualTypeOf<WithId<Item> | null>()
  })
})
