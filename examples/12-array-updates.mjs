// Changing arrays in place, without reading the document back first.
import Db from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const tasks = db.collection('tasks')
await tasks.insertOne({ _id: 't1', title: 'ship it', tags: ['todo'], history: [] })

const tags = async () => (await tasks.findOne({ _id: 't1' })).tags

// $push appends; onto a MISSING field it creates the array.
await tasks.updateOne({ _id: 't1' }, { $push: { tags: 'urgent' } })
console.log('after $push         ', await tags())

// $each pushes several at once, in order.
await tasks.updateOne({ _id: 't1' }, { $push: { tags: { $each: ['review', 'todo'] } } })
console.log('after $each         ', await tags())

// $addToSet only adds what is not already there - by VALUE, so an equal
// document counts as present even though it is a different object.
await tasks.updateOne({ _id: 't1' }, { $addToSet: { tags: 'urgent' } })
console.log('after $addToSet     ', await tags(), '(unchanged - already present)')

// $pull removes by value...
await tasks.updateOne({ _id: 't1' }, { $pull: { tags: 'todo' } })
console.log('after $pull todo    ', await tags(), '(BOTH copies)')

// ...or by a criterion matched against each element.
await tasks.updateOne({ _id: 't1' }, { $pull: { tags: { $regex: '^rev' } } })
console.log('after $pull /^rev/  ', await tags())

// $pop takes one off the end (1) or the front (-1); it is a no-op on an
// empty array rather than an error.
await tasks.updateOne({ _id: 't1' }, { $pop: { tags: 1 } })
console.log('after $pop          ', await tags())

// ---------------------------------------------------------------------------
// $each + $sort + $slice: keep the top N, atomically. This is the whole reason
// the three modifiers exist together - no read-modify-write, no race.
const players = db.collection('players')
await players.insertOne({ _id: 'p1', name: 'ann', top: [{ score: 90 }, { score: 40 }] })

for (const score of [65, 12, 99]) {
  await players.updateOne(
    { _id: 'p1' },
    { $push: { top: { $each: [{ score }], $sort: { score: -1 }, $slice: 3 } } }
  )
}
console.log('top 3 scores        ', (await players.findOne({ _id: 'p1' })).top.map(s => s.score))

// $sort: 1 / -1 orders the elements themselves rather than a field of them.
await players.updateOne({ _id: 'p1' }, { $push: { streak: { $each: [3, 1, 2], $sort: 1 } } })
console.log('sorted scalars      ', (await players.findOne({ _id: 'p1' })).streak)

// ---------------------------------------------------------------------------
// The numeric and field operators, for completeness.
const stock = db.collection('stock')
await stock.insertOne({ _id: 's1', qty: 10, label: 'B', seen: new Date('2021-01-01') })

await stock.updateOne({ _id: 's1' }, { $mul: { qty: 3 } })
await stock.updateOne({ _id: 's1' }, { $min: { qty: 99 } })       // 99 > 30, so no change
await stock.updateOne({ _id: 's1' }, { $max: { seen: new Date('2022-06-01') } })
await stock.updateOne({ _id: 's1' }, { $rename: { label: 'grade' } })
console.log('after $mul/$max/... ', await stock.findOne({ _id: 's1' }))

// Every check runs BEFORE anything is written, so a rejected update leaves the
// collection exactly as it was.
try {
  await stock.updateOne({ _id: 's1' }, { $push: { qty: 1 } })
} catch (error) {
  console.log('pushing onto a number', `-> ${error.message}`)
}
console.log('qty is untouched    ', (await stock.findOne({ _id: 's1' })).qty)

await db.close()
