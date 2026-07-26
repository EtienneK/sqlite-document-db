import { Db } from '../src/index.js'

/**
 * `db.withTransaction()` (BACKLOG item 12).
 *
 * This library only: MongoDB's equivalent needs a replica set and a session
 * object, and the shape here is deliberately different (see the method's own
 * comment). There is nothing to run against the oracle.
 */
describe('withTransaction', () => {
  let db: Db

  beforeEach(async () => {
    db = await Db.fromUrl(':memory:')
  })

  afterEach(async () => {
    await db.close()
  })

  const accounts = (): any => db.collection('accounts')
  const balances = async (): Promise<Record<string, number>> => {
    const rows = await accounts().find({}).toArray()
    return Object.fromEntries(rows.map((r: any) => [r._id, r.balance]))
  }

  beforeEach(async () => {
    await accounts().insertMany([{ _id: 'a', balance: 100 }, { _id: 'b', balance: 0 }])
  })

  it('should commit every write when the callback returns', async () => {
    await db.withTransaction(async () => {
      await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -60 } })
      await accounts().updateOne({ _id: 'b' }, { $inc: { balance: 60 } })
    })
    expect(await balances()).toStrictEqual({ a: 40, b: 60 })
  })

  it('should roll every write back when the callback throws', async () => {
    await expect(db.withTransaction(async () => {
      await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -60 } })
      await accounts().updateOne({ _id: 'b' }, { $inc: { balance: 60 } })
      throw Error('no')
    })).rejects.toThrow('no')

    // The half-applied transfer is the exact thing this exists to prevent.
    expect(await balances()).toStrictEqual({ a: 100, b: 0 })
  })

  it('should return the callback result', async () => {
    const result = await db.withTransaction(async () => {
      await accounts().insertOne({ _id: 'c', balance: 5 })
      return 'done'
    })
    expect(result).toStrictEqual('done')
  })

  it('should roll back an insert', async () => {
    await expect(db.withTransaction(async () => {
      await accounts().insertOne({ _id: 'c', balance: 5 })
      expect(await accounts().countDocuments({})).toStrictEqual(3) // visible inside
      throw Error('no')
    })).rejects.toThrow()
    expect(await accounts().countDocuments({})).toStrictEqual(2)
  })

  it('should roll back a delete and a drop-in-progress alike', async () => {
    await expect(db.withTransaction(async () => {
      await accounts().deleteMany({})
      expect(await accounts().countDocuments({})).toStrictEqual(0)
      throw Error('no')
    })).rejects.toThrow()
    expect(await accounts().countDocuments({})).toStrictEqual(2)
  })

  it('should report whether a transaction is open', async () => {
    expect(db.inTransaction).toStrictEqual(false)
    await db.withTransaction(async () => {
      expect(db.inTransaction).toStrictEqual(true)
    })
    expect(db.inTransaction).toStrictEqual(false)
  })

  it('should clear the transaction state after a rollback', async () => {
    await expect(db.withTransaction(async () => { throw Error('no') })).rejects.toThrow()
    expect(db.inTransaction).toStrictEqual(false)
    // A transaction left open would break every later write.
    await accounts().insertOne({ _id: 'later', balance: 1 })
    expect(await accounts().countDocuments({ _id: 'later' })).toStrictEqual(1)
  })

  describe('nesting', () => {
    it('should let an inner failure roll back only its own work', async () => {
      await db.withTransaction(async () => {
        await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } })
        await expect(db.withTransaction(async () => {
          await accounts().updateOne({ _id: 'b' }, { $inc: { balance: 999 } })
          throw Error('inner')
        })).rejects.toThrow('inner')
      })
      // The outer -10 committed; the inner +999 did not.
      expect(await balances()).toStrictEqual({ a: 90, b: 0 })
    })

    it('should let an outer rollback discard committed inner work', async () => {
      await expect(db.withTransaction(async () => {
        await db.withTransaction(async () => {
          await accounts().updateOne({ _id: 'b' }, { $inc: { balance: 60 } })
        })
        throw Error('outer')
      })).rejects.toThrow('outer')
      expect(await balances()).toStrictEqual({ a: 100, b: 0 })
    })

    it('should nest more than two deep', async () => {
      await db.withTransaction(async () => {
        await db.withTransaction(async () => {
          await db.withTransaction(async () => {
            await accounts().updateOne({ _id: 'a' }, { $inc: { balance: 1 } })
          })
        })
      })
      expect((await balances()).a).toStrictEqual(101)
      expect(db.inTransaction).toStrictEqual(false)
    })
  })

  describe('interaction with insertMany', () => {
    it('should let insertMany run inside one without opening its own', async () => {
      await db.withTransaction(async () => {
        await accounts().insertMany([{ _id: 'x', balance: 1 }, { _id: 'y', balance: 2 }])
      })
      expect(await accounts().countDocuments({})).toStrictEqual(4)
    })

    it('should discard the prefix an ordered insertMany would otherwise keep', async () => {
      // On its own, this insertMany keeps 'x' and fails on the duplicate. The
      // transaction is the caller saying they want all-or-nothing instead.
      await expect(db.withTransaction(async () => {
        await accounts().insertMany([{ _id: 'x', balance: 1 }, { _id: 'a', balance: 2 }])
      })).rejects.toThrow()
      expect(await accounts().countDocuments({ _id: 'x' })).toStrictEqual(0)
      expect(await accounts().countDocuments({})).toStrictEqual(2)
    })
  })

  it('should work across collections', async () => {
    await expect(db.withTransaction(async () => {
      await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -10 } })
      await db.collection('audit').insertOne({ _id: 'e1', what: 'transfer' } as any)
      throw Error('no')
    })).rejects.toThrow()
    expect((await balances()).a).toStrictEqual(100)
    expect(await db.collection('audit').countDocuments({})).toStrictEqual(0)
  })

  it('should be usable for the read-modify-write a single statement cannot express', async () => {
    await db.withTransaction(async () => {
      const from = await accounts().findOne({ _id: 'a' })
      if (from.balance < 60) throw Error('insufficient funds')
      await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -60 } })
      await accounts().updateOne({ _id: 'b' }, { $inc: { balance: 60 } })
    })
    expect(await balances()).toStrictEqual({ a: 40, b: 60 })

    await expect(db.withTransaction(async () => {
      const from = await accounts().findOne({ _id: 'a' })
      if (from.balance < 60) throw Error('insufficient funds')
      await accounts().updateOne({ _id: 'a' }, { $inc: { balance: -60 } })
    })).rejects.toThrow('insufficient funds')
    expect(await balances()).toStrictEqual({ a: 40, b: 60 })
  })
})
