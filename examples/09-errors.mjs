// Failures you should expect to handle, and what they look like.
import Db, { DUPLICATE_KEY_ERROR, MongoServerError } from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const users = db.collection('users')

// A duplicate _id reports MongoDB's error code, so existing error handling
// ports across unchanged. Branch on `code`, not on the message.
await users.insertOne({ _id: 'ada', name: 'Ada' })
try {
  await users.insertOne({ _id: 'ada', name: 'Someone else' })
} catch (error) {
  console.log('duplicate _id  ', error.code === DUPLICATE_KEY_ERROR, error instanceof MongoServerError)
  console.log('  message      ', error.message)
}

// The same for your own unique indexes.
await users.createIndex({ email: 1 }, { unique: true })
await users.insertOne({ name: 'Grace', email: 'grace@example.com' })
try {
  await users.insertOne({ name: 'Impostor', email: 'grace@example.com' })
} catch (error) {
  console.log('duplicate email', error.code === DUPLICATE_KEY_ERROR, '| index:', error.message.split('index: ')[1])
}

// Mistakes in a query are refused rather than quietly matching nothing.
const refuse = async (label, fn) => {
  try { await fn(); console.log(`${label} - NOT refused`) } catch (e) { console.log(`${label} ${e.message}`) }
}
await refuse('typo operator  ', () => users.find({ name: { $eqq: 'Ada' } }).toArray())
await refuse('bad $size      ', () => users.find({ tags: { $size: -1 } }).toArray())
await refuse('empty $or      ', () => users.find({ $or: [] }).toArray())

// ...and so are updates that would damage a document.
await refuse('_id is immutable', () => users.updateOne({ _id: 'ada' }, { $unset: { _id: '' } }))
await refuse('$inc on a string', () => users.updateOne({ _id: 'ada' }, { $inc: { name: 1 } }))
console.log('ada survived   ', await users.findOne({ _id: 'ada' }))

await db.close()
