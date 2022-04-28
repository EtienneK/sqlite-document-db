# UNDER CONSTRUCTION

# SQLite Document DB

Use SQLite as a JSON Document Database.

API based on MongoDB's JavaScript API.

## Getting started

1. Install using NPM:

```
npm i --save sqlite-document-db
```

2. Start using it:

```javascript
import Db from 'sqlite-document-db'

const db = await Db.fromUrl(':memory:') // Can also be a path to your DB file

// Insert some users into a collection
await db.collection('users').insertOne({ username: 'test_user', email: 'test@example.com' })
await db.collection('users').insertMany([
  { username: 'test_user2', email: 'test2@example.com' },
  { username: 'test_user3', email: 'test3@example.com' },
])

const user = await db.collection('users').findOne({ email: 'test3@example.com' })

console.log(user)
```

Console output of the above:

```javascript
{
  _id: '626964400e547e782d04d7f1',
  username: 'test_user2',
  email: 'test2@example.com'
}
```

## Features and examples

### Insert documents

```javascript
// Insert a single document
db.collection('inventory').insertOne({ item: 'canvas', qty: 100, tags: ['cotton'], size: { h: 28, w: 35.5, uom: 'cm' } })

// Insert multiple documents
db.collection('inventory').insertOne([
  { _id: undefined, item: 'journal', qty: 25, tags: ['blank', 'red'], size: { h: 14, w: 21, uom: 'cm' } },
  { item: 'mat', qty: 85, tags: ['gray'], size: { h: 27.9, w: 35.5, uom: 'cm' } },
  { item: 'mousepad', qty: 25, tags: ['gel', 'blue'], size: { h: 19, w: 22.85, uom: 'cm' } }
])
```

### Query documents

```javascript
const items = [
  { item: 'journal', qty: 25, size: { h: 14, w: 21, uom: 'cm' }, status: 'A' },
  { item: 'notebook', qty: 50, size: { h: 8.5, w: 11, uom: 'in' }, status: 'A' },
  { item: 'paper', qty: 100, size: { h: 8.5, w: 11, uom: 'in' }, status: 'D' },
  { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'C' },
  { item: 'planner', qty: 75, size: { h: 22.85, w: 30, uom: 'cm' }, status: 'D' },
  { item: 'postcard', qty: 45, size: { h: 10, w: 15.25, uom: 'cm' }, status: 'A' }
]

await db.collection('items').insertMany(items)

// Select a single document
db.collection('items').findOne({ item: 'paper' })

// Select all documents in a collection
const allItemsArray = await db.collection('items').find().toArray()

// Query using equality conditions
db.collection('items').find({ status: 'D' })
db.collection('items').find({ status: { $in: ['A', 'D'] } })
db.collection('items').find({ qty: { $lt: 30 } })
db.collection('items').find({ qty: { $gt: 30 } })
db.collection('items').find({ qty: { $lte: 45 } })
db.collection('items').find({ qty: { $gte: 45 } })
db.collection('items').find({ qty: { $eq: 45 } })
db.collection('items').find({ qty: { $ne: 45 } })
db.collection('items').find({ status: 'A', qty: { $lt: 30 } })
db.collection('items').find({ $or: [{ status: 'A' }, { qty: { $lt: 30 } }] })
```

## Missing Features

Many. From the top of my head:

### Missing query operators

- Regular expressions - `$regex` or using `/pattern/` syntax
- [Query an Array for an Element](https://www.mongodb.com/docs/manual/tutorial/query-arrays/#query-an-array-for-an-element)
- [Query an Array with Compound Filter Conditions on the Array Elements](https://www.mongodb.com/docs/manual/tutorial/query-arrays/#query-an-array-for-an-element)
- [Query for an Array Element that Meets Multiple Criteria using `$elemMatch`](https://www.mongodb.com/docs/manual/tutorial/query-arrays/#query-for-an-array-element-that-meets-multiple-criteria)
- [Query an Array of Embedded Documents](https://www.mongodb.com/docs/manual/tutorial/query-array-of-documents/#query-an-array-of-embedded-documents)

## Thanks

Thanks to <https://github.com/thomas4019/mongo-query-to-postgres-jsonb> for being a huge inspiration for this project.
