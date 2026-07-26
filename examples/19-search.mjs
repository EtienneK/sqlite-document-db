// Full-text search, under this library's own name. $text and $search stay
// refused - $text cannot match MongoDB's stemmer, $search is Atlas-only - so
// createSearchIndex/searchText promise only what they can keep: SQLite's FTS5,
// with the tokenizer named by YOU.
import Db, { stringifyDocument } from '../dist/index.js'

const db = await Db.fromUrl(':memory:')
const articles = db.collection('articles')
await articles.insertMany([
  { _id: 1, title: 'Trail running shoes', body: 'Grippy soles for muddy trail runs.' },
  { _id: 2, title: 'Road cycling', body: 'A carbon frame for long road rides.' },
  { _id: 3, title: 'Walking boots', body: 'Comfortable boots for city walking.' },
  { _id: 4, title: 'Running socks', body: 'No blisters, however far you run.' },
  { _id: 5, title: 'Camping stoves', body: 'Boils a litre in ninety seconds.' },
  { _id: 6, title: 'Headlamps', body: 'Bright, light, and long-lived.' }
])

// ---------------------------------------------------------------------------
// The tokenizer is yours. 'porter' stems, so run/runs/running find each other;
// the default (unicode61) matches exact words only. Documents that already
// exist are indexed at creation.
await articles.createSearchIndex({ fields: ['title', 'body'], tokenizer: 'porter' })

console.log('running ->')
for (const { score, document } of await articles.searchText('running')) {
  console.log(`  ${score.toFixed(2)}  ${document.title}`) // BM25, best first
}

// FTS5 query syntax passes through verbatim: phrases, prefixes, boolean.
console.log('phrase  ->', (await articles.searchText('"city walking"')).map(h => h.document.title))
console.log('boolean ->', (await articles.searchText('run* NOT socks')).map(h => h.document.title))

// ---------------------------------------------------------------------------
// The index is kept in step by SQLite TRIGGERS, not by this library's write
// path - so even a raw db.sql write is searchable the moment it lands.
await db.sql.run`INSERT INTO ${db.table('articles')} (data)
  VALUES (json(${stringifyDocument({ _id: 7, title: 'Crampons', body: 'Bite into ice.' })}))`
console.log('raw insert ->', (await articles.searchText('crampons')).length, 'hit')

// ---------------------------------------------------------------------------
// $text still throws, and the error names this API as the alternative.
try {
  await articles.find({ $text: { $search: 'running' } }).toArray()
} catch (error) {
  console.log('\n$text ->', `${error.message.slice(0, 76)}...`)
}

console.log('\nindexes ->', await articles.listSearchIndexes().toArray())
await articles.dropSearchIndex('default')

await db.close()
