import { Db } from '../src/index.js'

// Cursor mechanics are specific to this library's SQLite implementation
// (statement lifetime, query plans), so unlike the parity specs these tests
// run against sqlite-document-db alone.
describe('FindCursor', () => {
  let db: Db

  beforeEach(async () => {
    db = await Db.fromUrl(':memory:')
    await db.collection('items').insertMany(
      Array.from({ length: 100 }, (_, n) => ({ n, even: n % 2 === 0 }))
    )
  })

  afterEach(async () => {
    await db.close()
  })

  it('toArray() should keep working after partial iteration via next()', async () => {
    // Typed collection: exercises Db.collection<TSchema>() at compile time.
    const cursor = db.collection<{ n: number, even: boolean }>('items').find({ even: true })
    expect((await cursor.next())?.n).toStrictEqual(0)
    expect((await cursor.next())?.n).toStrictEqual(2)
    const rest = await cursor.toArray()
    expect(rest.length).toStrictEqual(48)
    expect(rest[0]?.n).toStrictEqual(4)
  })

  it('next() should return null forever once exhausted', async () => {
    const cursor = db.collection('items').find({ n: { $lt: 1 } })
    expect((await cursor.next())?.n).toStrictEqual(0)
    expect(await cursor.next()).toStrictEqual(null)
    expect(await cursor.next()).toStrictEqual(null)
  })

  it('close() should stop iteration', async () => {
    const cursor = db.collection('items').find()
    expect(await cursor.next()).not.toStrictEqual(null)
    await cursor.close()
    expect(await cursor.next()).toStrictEqual(null)
  })

  it('close() before any next() should be safe', async () => {
    const cursor = db.collection('items').find()
    await cursor.close()
    expect(await cursor.next()).toStrictEqual(null)
  })

  it('breaking out of for-await should release the cursor', async () => {
    const seen: number[] = []
    for await (const doc of db.collection('items').find({ even: true })) {
      seen.push(doc.n)
      if (seen.length === 3) break
    }
    expect(seen).toStrictEqual([0, 2, 4])
    // The statement was finalized by the break; the collection must remain
    // fully usable, including for writes.
    await db.collection('items').deleteMany({ even: false })
    expect(await db.collection('items').countDocuments()).toStrictEqual(50)
  })

  it('two cursors on the same collection should iterate independently', async () => {
    const a = db.collection('items').find({ even: true })
    const b = db.collection('items').find({ even: false })
    expect((await a.next())?.n).toStrictEqual(0)
    expect((await b.next())?.n).toStrictEqual(1)
    expect((await a.next())?.n).toStrictEqual(2)
    expect((await b.next())?.n).toStrictEqual(3)
    await a.close()
    await b.close()
  })
})
