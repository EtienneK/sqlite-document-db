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

db = await Db.fromUrl(':memory:') // Can also be a path to your DB file

// Insert some users into a collection
db.collections('users').insertOne({ username: 'test_user', email: 'test@example.com' })

const user = db.collections('users').findAll({ username: 'test_user' })

console.log(user)
```

## Examples

## Missing Features

## Thanks

Thanks to <https://github.com/thomas4019/mongo-query-to-postgres-jsonb> for being a huge inspiration for this project.
