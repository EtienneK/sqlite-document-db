// The Node counterpart of deno.ts: the smallest thing that does something.
//   node examples/01-quickstart.mjs
import Db from '../dist/index.js'

// ':memory:' is a throwaway database. Pass a path for one that persists.
const db = await Db.fromUrl(':memory:')

await db.collection('users').insertOne({ username: 'test_user', email: 'test@example.com' })
await db.collection('users').insertMany([
  { username: 'test_user2', email: 'test2@example.com' },
  { username: 'test_user3', email: 'test3@example.com' }
])

const user = await db.collection('users').findOne({ email: 'test3@example.com' })
console.log(user)

console.log('users:', await db.collection('users').countDocuments())

await db.close()
