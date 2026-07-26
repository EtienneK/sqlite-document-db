import { Db, stringifyDocument } from '../src/index.js'

/**
 * BACKLOG item 31: full-text search, under this library's own name.
 *
 * This library only - deliberately, and the reason is the feature's design.
 * `$text` cannot be oracle-verified (FTS5's stemmer disagrees with MongoDB's
 * Snowball one, so the same query returns different documents) and `$search`
 * is Atlas-only (no local server can run it), so there is no oracle even in
 * principle. `createSearchIndex`/`searchText` promise only what they can
 * keep - FTS5, with the tokenizer named by the caller - and these tests pin
 * exactly that.
 */
describe('search - createSearchIndex / searchText', () => {
  let db: Db

  beforeEach(async () => {
    db = await Db.fromUrl(':memory:')
  })

  afterEach(async () => {
    await db.close()
  })

  const seedArticles = async () => {
    const articles = db.collection('articles')
    await articles.insertMany([
      { _id: 1, title: 'Trail running shoes', body: 'grippy soles for muddy trails' },
      { _id: 2, title: 'Road cycling', body: 'a carbon frame for the road' },
      { _id: 3, title: 'Camping stoves', body: 'boils water fast' },
      { _id: 4, title: 'Running socks', body: 'no blisters while running' },
      { _id: 5, title: 'City walking', body: 'comfortable walking boots' }
    ])
    return articles
  }

  describe('searching', () => {
    it('indexes the documents that already exist, and finds them by word', async () => {
      const articles = await seedArticles()
      await articles.createSearchIndex({ fields: ['title', 'body'] })

      const hits = await articles.searchText('running')
      expect(hits.map(hit => hit.document._id).toSorted()).toStrictEqual([1, 4])
      // Hits are whole decoded documents plus a score, not projections.
      expect(hits[0]!.document.title).toMatch(/unning/)
    })

    it('ranks by BM25, best hit first, scores descending', async () => {
      const posts = db.collection('posts')
      await posts.insertMany([
        { _id: 10, text: 'spark spark spark spark filler filler' },
        { _id: 11, text: 'spark filler filler filler filler filler' },
        { _id: 12, text: 'nothing relevant here at all today' },
        { _id: 13, text: 'still nothing relevant in this one' },
        { _id: 14, text: 'filler without the term anywhere' }
      ])
      await posts.createSearchIndex({ fields: ['text'] })

      const hits = await posts.searchText('spark')
      expect(hits.map(hit => hit.document._id)).toStrictEqual([10, 11])
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
      expect(hits[1]!.score).toBeGreaterThan(0)
    })

    it('stems only when the caller chose a stemming tokenizer', async () => {
      // The tokenizer is the thing that cannot be made to agree with anybody,
      // so it is the caller's choice - and the choice has to be visible.
      const stemmed = db.collection('stemmed')
      const plain = db.collection('plain')
      await stemmed.insertOne({ _id: 1, t: 'running shoes' })
      await plain.insertOne({ _id: 1, t: 'running shoes' })
      await stemmed.createSearchIndex({ fields: ['t'], tokenizer: 'porter' })
      await plain.createSearchIndex({ fields: ['t'] })

      expect(await stemmed.searchText('run')).toHaveLength(1)
      expect(await plain.searchText('run')).toHaveLength(0)
      expect(await plain.searchText('running')).toHaveLength(1)
    })

    it('passes FTS5 query syntax through verbatim', async () => {
      const articles = await seedArticles()
      await articles.createSearchIndex({ fields: ['title', 'body'] })

      const ids = async (query: string) =>
        (await articles.searchText(query)).map(hit => hit.document._id).toSorted()

      expect(await ids('"walking boots"')).toStrictEqual([5]) // a phrase
      expect(await ids('walk*')).toStrictEqual([5]) // a prefix
      expect(await ids('running NOT socks')).toStrictEqual([1])
      expect(await ids('title : cycling')).toStrictEqual([2]) // a column filter
      // A syntax error surfaces as SQLite reports it - you are writing an
      // FTS5 query, the same posture db.sql takes for SQL.
      await expect(articles.searchText('"unbalanced')).rejects.toThrow()
    })

    it('applies limit and skip to the RANKED list', async () => {
      const posts = db.collection('posts')
      await posts.insertMany([
        { _id: 10, text: 'spark spark spark spark filler filler' },
        { _id: 11, text: 'spark filler filler filler filler filler' },
        { _id: 12, text: 'no match' }
      ])
      await posts.createSearchIndex({ fields: ['text'] })

      expect((await posts.searchText('spark', { limit: 1 })).map(hit => hit.document._id)).toStrictEqual([10])
      expect((await posts.searchText('spark', { skip: 1 })).map(hit => hit.document._id)).toStrictEqual([11])
      expect(await posts.searchText('spark', { limit: 0 })).toHaveLength(2) // 0 = no limit, as on find()
      await expect(posts.searchText('spark', { limit: NaN })).rejects.toThrow(/limit must be/)
    })

    it('indexes strings and the string elements of arrays, and nothing else', async () => {
      const items = db.collection('items')
      await items.insertOne({
        _id: 1, tags: ['alpha', 'beta', 7], qty: 42, meta: { inner: 'hidden' }, at: new Date('2020-01-02T03:04:05Z')
      })
      await items.createSearchIndex({ fields: ['tags', 'qty', 'meta', 'at'] })

      expect(await items.searchText('beta')).toHaveLength(1) // array element
      expect(await items.searchText('42')).toHaveLength(0) // a number is not text
      expect(await items.searchText('hidden')).toHaveLength(0) // objects contribute nothing
      // A stored Date is a {"$date": ...} wrapper object - which must not leak
      // its spelling into the index.
      expect(await items.searchText('date')).toHaveLength(0)
      expect(await items.searchText('2020')).toHaveLength(0)
    })

    it('reaches dotted paths', async () => {
      const items = db.collection('items')
      await items.insertOne({ _id: 1, meta: { title: 'deep sea' } })
      await items.createSearchIndex({ fields: ['meta.title'] })
      expect(await items.searchText('sea')).toHaveLength(1)
    })
  })

  describe('staying in step', () => {
    it('tracks every document write path', async () => {
      const articles = await seedArticles()
      await articles.createSearchIndex({ fields: ['title', 'body'] })

      await articles.insertOne({ _id: 6, title: 'Kayak paddles', body: 'light carbon paddles' })
      expect(await articles.searchText('kayak')).toHaveLength(1)

      await articles.updateOne({ _id: 6 }, { $set: { title: 'Canoe paddles' } })
      expect(await articles.searchText('kayak')).toHaveLength(0)
      expect(await articles.searchText('canoe')).toHaveLength(1)

      await articles.updateOne({ _id: 6 }, [{ $set: { title: 'Rafting oars' } }]) // a pipeline update
      expect(await articles.searchText('canoe')).toHaveLength(0)
      expect(await articles.searchText('rafting')).toHaveLength(1)

      await articles.replaceOne({ _id: 6 }, { title: 'Snorkels', body: 'for the reef' })
      expect(await articles.searchText('rafting')).toHaveLength(0)
      expect(await articles.searchText('snorkels')).toHaveLength(1)

      await articles.updateMany({}, { $set: { body: 'clearance sale' } })
      expect((await articles.searchText('clearance')).length).toStrictEqual(6)

      await articles.deleteOne({ _id: 6 })
      expect(await articles.searchText('snorkels')).toHaveLength(0)
      await articles.deleteMany({})
      expect(await articles.searchText('clearance')).toHaveLength(0)
    })

    it('tracks a raw db.sql write, which no library hook ever sees', async () => {
      // THE reason the index is kept in step by triggers rather than by the
      // write path: db.sql is the one door the write path does not stand in.
      const articles = await seedArticles()
      await articles.createSearchIndex({ fields: ['title', 'body'] })

      await db.sql.run`INSERT INTO ${db.table('articles')} (data)
        VALUES (json(${stringifyDocument({ _id: 7, title: 'Crampons', body: 'for ice' })}))`
      expect(await articles.searchText('crampons')).toHaveLength(1)

      await db.sql.run`UPDATE ${db.table('articles')}
        SET data = json_set(data, '$.title', ${'Ice axes'})
        WHERE json_extract(data, '$._id') = ${7}`
      expect(await articles.searchText('crampons')).toHaveLength(0)
      expect(await articles.searchText('axes')).toHaveLength(1)

      await db.sql.run`DELETE FROM ${db.table('articles')} WHERE json_extract(data, '$._id') = ${7}`
      expect(await articles.searchText('axes')).toHaveLength(0)
    })

    it('rolls back with the transaction it happened in', async () => {
      const articles = await seedArticles()

      // DDL is transactional in SQLite, so an index CREATED in a rolled-back
      // transaction is gone - table, triggers and all.
      await expect(db.withTransaction(async () => {
        await articles.createSearchIndex({ fields: ['title'] })
        expect(await articles.searchText('running')).toHaveLength(2) // visible inside
        throw Error('abandon')
      })).rejects.toThrow('abandon')
      expect(await articles.listSearchIndexes().toArray()).toStrictEqual([])
      const leftovers = await db.sql.all`
        SELECT name FROM sqlite_master WHERE name LIKE 'fts_collection_articles%' OR name LIKE 'ftg_%'`
      expect(leftovers).toStrictEqual([])

      // And a WRITE rolled back takes its index entries with it.
      await articles.createSearchIndex({ fields: ['title'] })
      await expect(db.withTransaction(async () => {
        await articles.insertOne({ _id: 8, title: 'Ephemeral gaiters' })
        throw Error('abandon')
      })).rejects.toThrow('abandon')
      expect(await articles.searchText('gaiters')).toHaveLength(0)
    })
  })

  describe('managing indexes', () => {
    it('names, lists and drops search indexes', async () => {
      const articles = await seedArticles()
      expect(await articles.createSearchIndex({ fields: ['title', 'body'] })).toStrictEqual('default')
      expect(await articles.createSearchIndex({ name: 'titles', fields: ['title'], tokenizer: 'porter' }))
        .toStrictEqual('titles')

      // The descriptions are recovered from the schema itself - there is
      // nowhere else they live (see parseSearchIndexSql).
      const listed = (await articles.listSearchIndexes().toArray())
        .toSorted((a, b) => a.name.localeCompare(b.name))
      expect(listed).toStrictEqual([
        { name: 'default', fields: ['title', 'body'] },
        { name: 'titles', fields: ['title'], tokenizer: 'porter' }
      ])

      // Two indexes: searchText needs to be told which, and says so.
      await expect(articles.searchText('running')).rejects.toThrow(/2 search indexes.*default, titles/s)
      expect((await articles.searchText('run', { index: 'titles' })).map(hit => hit.document._id).toSorted())
        .toStrictEqual([1, 4])
      await expect(articles.searchText('run', { index: 'nope' })).rejects.toThrow(/no search index named 'nope'/)

      await articles.dropSearchIndex('titles')
      expect(await articles.listSearchIndexes().toArray())
        .toStrictEqual([{ name: 'default', fields: ['title', 'body'] }])
      await expect(articles.dropSearchIndex('titles')).rejects.toThrow(/search index not found with name \[titles\]/)

      await articles.dropSearchIndex('default')
      await expect(articles.searchText('running')).rejects.toThrow(/no search index.*createSearchIndex/s)
    })

    it('refuses what it cannot keep, naming the reason', async () => {
      const items = db.collection('items')
      await expect(items.createSearchIndex({ fields: [] })).rejects.toThrow(/non-empty 'fields'/)
      await expect(items.createSearchIndex({ fields: ['rank'] })).rejects.toThrow(/FTS5 reserves/)
      await expect(items.createSearchIndex({ fields: ['t', 'T'] })).rejects.toThrow(/repeat/)
      await expect(items.createSearchIndex({ name: 'has space', fields: ['t'] })).rejects.toThrow(/letters, digits/)
      await expect(items.createSearchIndex({ fields: ['t'], analyzer: 'lucene.standard' } as any))
        .rejects.toThrow(/does not support the 'analyzer' option/)

      await items.createSearchIndex({ fields: ['t'] })
      await expect(items.createSearchIndex({ fields: ['t'] })).rejects.toThrow(/already exists: default/)
      // SQLite folds identifier case, so a case-variant would collide with a
      // far worse error downstream - refused up front instead.
      await expect(items.createSearchIndex({ name: 'Default', fields: ['t'] })).rejects.toThrow(/already exists/)

      await expect(items.searchText('')).rejects.toThrow(/non-empty FTS5 query/)
    })

    it('cleans up after a tokenizer FTS5 refuses, so the name is not burned', async () => {
      const items = db.collection('items')
      await expect(items.createSearchIndex({ fields: ['t'], tokenizer: 'not-a-tokenizer' })).rejects.toThrow()
      // The failed attempt left nothing behind: the same name works next try.
      expect(await items.createSearchIndex({ fields: ['t'], tokenizer: 'porter' })).toStrictEqual('default')
    })

    it('drop() takes the search index with the collection', async () => {
      const articles = await seedArticles()
      await articles.createSearchIndex({ fields: ['title'] })
      await articles.drop()

      const leftovers = await db.sql.all`
        SELECT name FROM sqlite_master WHERE name LIKE 'fts_collection_articles%' OR name LIKE 'ftg_%'`
      expect(leftovers).toStrictEqual([])

      // The recreated collection starts clean: no stale triggers to fire, and
      // the index name is free again.
      const recreated = db.collection('articles')
      await recreated.insertOne({ _id: 1, title: 'fresh start' })
      expect(await recreated.createSearchIndex({ fields: ['title'] })).toStrictEqual('default')
      expect(await recreated.searchText('fresh')).toHaveLength(1)
    })

    it('dropDatabase leaves no search table behind', async () => {
      const articles = await seedArticles()
      await articles.createSearchIndex({ fields: ['title'] })
      await db.collection('posts').insertOne({ _id: 1, text: 'hello' })
      await db.collection('posts').createSearchIndex({ fields: ['text'] })

      await db.dropDatabase()
      const leftovers = await db.sql.all`SELECT name FROM sqlite_master WHERE name LIKE 'fts_%'`
      expect(leftovers).toStrictEqual([])
    })

    it('follows a rename, data and triggers included', async () => {
      const articles = await seedArticles()
      await articles.createSearchIndex({ fields: ['title', 'body'] })

      const archive = await articles.rename('archive')
      // The FTS content moved with the table - no reindex happened, the five
      // documents are still searchable under the new name.
      expect((await archive.searchText('running')).map(hit => hit.document._id).toSorted()).toStrictEqual([1, 4])
      expect(await archive.listSearchIndexes().toArray())
        .toStrictEqual([{ name: 'default', fields: ['title', 'body'] }])

      // The triggers were recreated against the new table: writes keep tracking.
      await archive.insertOne({ _id: 6, title: 'Snowshoes' })
      expect(await archive.searchText('snowshoes')).toHaveLength(1)
      await archive.deleteOne({ _id: 6 })
      expect(await archive.searchText('snowshoes')).toHaveLength(0)

      // Nothing still refers to the old table name.
      const stale = await db.sql.all`
        SELECT name FROM sqlite_master WHERE name LIKE '%collection_articles%'`
      expect(stale).toStrictEqual([])
    })
  })
})
