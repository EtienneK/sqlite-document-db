import { assert } from 'chai'
import convert from '../../src/query/filter'

describe('string equality', function () {
  it('should work with single', function () {
    assert.equal(convert('data', { name: 'thomas' }), 'json_extract("data", \'$.name\') = \'thomas\'')
    assert.equal(convert('data', { count: 5 }), 'json_extract("data", \'$.count\') = 5')
    assert.equal(convert('da"ta', { "na'me": 'th\'omas' }), 'json_extract("da""ta", \'$.na\'\'me\') = \'th\'\'omas\'')
  })
  it('should work with multiple', function () {
    assert.equal(convert('data', { a: 'a', b: 8 }), '(json_extract("data", \'$.a\') = \'a\' and json_extract("data", \'$.b\') = 8)')
    assert.equal(convert('dat"a', { "'a": 'a\'', "b'": '\'b' }), '(json_extract("dat""a", \'$.\'\'a\') = \'a\'\'\' and json_extract("dat""a", \'$.b\'\'\') = \'\'\'b\')')
  })
  it('nesting does exact document matching', function () {
    assert.equal(convert('data', { test: { cat: { name: 'oscar' } } }), 'json_extract("data", \'$.test\') = json(\'{"cat":{"name":"oscar"}}\')')
    assert.equal(convert('data', { test: { cat: { age: 10 } } }), 'json_extract("data", \'$.test\') = json(\'{"cat":{"age":10}}\')')
    assert.equal(convert('dat"a', { "t''est": { "cat'": { name: 'o\'scar' } } }), 'json_extract("dat""a", \'$.t\'\'\'\'est\') = json(\'{"cat\'\'":{"name":"o\'\'scar"}}\')')
  })
  it('should support nesting using the dot operator', function () {
    assert.equal(convert('data', { 'test.cat.name': 'oscar' }), 'json_extract("data", \'$.test.cat.name\') = \'oscar\'')
    assert.equal(convert('d"ata', { 'test\'.c\'at.\'name': 'osca\'\'r' }), 'json_extract("d""ata", \'$.test\'\'.c\'\'at.\'\'name\') = \'osca\'\'\'\'r\'')
  })
})

describe('array equality', function () {
  it('should use =', function () {
    assert.equal(convert('data', { roles: ['Admin'] }), 'json_extract("data", \'$.roles\') = json(\'["Admin"]\')')
    assert.equal(convert('data', { levels: [7] }), 'json_extract("data", \'$.levels\') = json(\'[7]\')')
  })
  it('should matching numeric indexes', function () {
    assert.equal(convert('data', { 'roles.0': 'Admin' }), 'json_extract("data", \'$.roles[0]\') = \'Admin\'')
  })
  it('support element matching', function () {
    assert.equal(
      convert('data', { roles: { $elemMatch: 'Admin' } }),
      'EXISTS (select "id" from json_each(json_extract("data", \'$.roles\')) where value = \'Admin\')'
    )
    assert.equal(
      convert('dat"a', { 'ro\'les': { $elemMatch: 'Admi\'\'n' } }),
      'EXISTS (select "id" from json_each(json_extract("dat""a", \'$.ro\'\'les\')) where value = \'Admi\'\'\'\'n\')'
    )
  })
})

/*
describe('boolean equality', function () {
  it('should use ->', function () {
    assert.equal('data @> \'{ "hidden": false }\'', convert('data', {'hidden': false}))
  })
})

describe('number equality', function () {
  it('should use ->', function () {
    assert.equal('data @> \'{ "age": 5 }\'', convert('data', {'age': 5}))
  })
})

describe('$or', function () {
  it('errors with no parameters', function () {
    assert.throws(() => convert('data', { $or: [] }), '$and/$or/$nor must be a nonempty array')
  })
  it('work with one parameter', function () {
    assert.equal('(data @> \'{ "name": "thomas" }\')', convert('data', {$or: [{name: 'thomas'}]}))
  })
  it('work with two parameters', function () {
    assert.equal('(data @> \'{ "name": "thomas" }\' OR data @> \'{ "name": "hansen" }\')', convert('data', {$or: [{name: 'thomas'}, {name: 'hansen'}]}))
  })
})
describe('$nor', function () {
  it('work with two parameters', function () {
    assert.equal('((NOT data @> \'{ "name": "thomas" }\') AND (NOT data @> \'{ "name": "hansen" }\'))', convert('data', { $nor: [{ name: 'thomas' }, { name: 'hansen' }] }))
  })
})

describe('$and', function () {
  it('errors with no parameters', function () {
    assert.throws(() => convert('data', { $and: [] }), '$and/$or/$nor must be a nonempty array')
  })
  it('work with one parameter', function () {
    assert.equal('(data @> \'{ "name": "thomas" }\')', convert('data', {$and: [{name: 'thomas'}]}))
  })
  it('work with two parameters', function () {
    assert.equal('(data @> \'{ "name": "thomas" }\' AND data @> \'{ "name": "hansen" }\')', convert('data', {$and: [{name: 'thomas'}, {name: 'hansen'}]}))
  })
  it('should work implicitly', function () {
    assert.equal('(data @> \'{ "type": "food" }\' and data->\'price\'<\'9.95\'::jsonb)', convert('data', { type: 'food', price: { $lt: 9.95 } }))
  })
})

describe('$in', function () {
  it('should work with strings', function () {
    assert.equal('data->>\'type\' IN (\'food\', \'snacks\')', convert('data', { type: { $in: [ 'food', 'snacks' ] } }))
  })
  it('should work with numbers', function () {
    assert.equal('data->\'count\' IN (\'1\'::jsonb, \'5\'::jsonb)', convert('data', { count: { $in: [ 1, 5 ] } }))
  })
})

describe('$nin', function () {
  it('should work with strings', function () {
    assert.equal('data->>\'type\' NOT IN (\'food\', \'snacks\')', convert('data', { type: { $nin: [ 'food', 'snacks' ] } }))
  })
  it('should work with numbers', function () {
    assert.equal('data->\'count\' NOT IN (\'1\'::jsonb, \'5\'::jsonb)', convert('data', { count: { $nin: [ 1, 5 ] } }))
  })
})

describe('$not', function () {
  it('should add NOT and wrap in paratheses', function () {
    assert.equal('(NOT data->>\'name\' IN (\'thomas\', \'test\'))', convert('data', { name: { $not : {$in: ['thomas', 'test'] } } }))
  })
  xit('should use != for string comparison', function () {
    assert.equal('data->>\'name\'!=\'thomas\'', convert('data', { $not : {name: 'thomas'} }))
  })
})

describe('comparision operators', function() {
  it('$eq', function () {
    assert.equal('data @> \'{ "type": "food" }\'', convert('data', { type: { $eq : 'food' } }))
    assert.equal('data @> \'{ "type": "food" }\'', convert('data', { type : 'food' }))
    assert.equal('data @> \'{ "address": { "city": "provo" } }\'', convert('data', { 'address.city': 'provo' }))
  })
  it('$eq inside array', function () {
    assert.equal('data->\'types\'->>0=\'food\'', convert('data', { 'types.0': { $eq : 'food' } }))
  })
  it('$ne', function () {
    assert.equal('NOT data @> \'{ "type": "food" }\'', convert('data', { type: { $ne : 'food' } }))
  })
  it('$gt', function () {
    assert.equal('data->\'count\'>\'5\'::jsonb', convert('data', { count: { $gt : 5 } }))
  })
  it('$gte', function () {
    assert.equal('data->\'count\'>=\'5\'::jsonb', convert('data', { count: { $gte : 5 } }))
  })
  it('$lt', function () {
    assert.equal('data->\'count\'<\'5\'::jsonb', convert('data', { count: { $lt : 5 } }))
  })
  it('$lte', function () {
    assert.equal('data->\'count\'<=\'5\'::jsonb', convert('data', { count: { $lte : 5 } }))
  })
})

describe('regular expressions', function() {
  it('basic', function () {
    assert.equal('data->>\'type\' ~ \'(?p)food\'', convert('data', { type: { $regex : 'food' } }))
  })
  it('case insensitive', function () {
    assert.equal('data->>\'type\' ~* \'(?p)food\'', convert('data', { type: { $regex : 'food', $options: 'i' } }))
  })
  it('js RegExp', function () {
    assert.equal('data->>\'type\' ~ \'food\'', convert('data', { type: /food/ }))
  })
  it('js RegExp using regex', function () {
    assert.equal('data->>\'type\' ~ \'(?p)food\'', convert('data', { type: { $regex: /food/ }}))
  })
  it('make dot match multiline', function () {
    assert.equal('data->>\'type\' ~* \'food\'', convert('data', { type: { $regex : 'food', $options: 'si' } }))
  })
})

describe('combined tests', function () {
  it('should handle ANDs and ORs together', function() {
    assert.equal('(data @> \'{ "type": "food" }\' and (data->\'qty\'>\'100\'::jsonb OR data->\'price\'<\'9.95\'::jsonb))', convert('data', {
      type: 'food',
      $or: [ { qty: { $gt: 100 } }, { price: { $lt: 9.95 } } ]
    }))
  })
  it('should add NOT and wrap in paratheses', function () {
    assert.equal('(data @> \'{ "city": "provo" }\' and data->\'pop\'>\'1000\'::jsonb)', convert('data', {city: 'provo', pop : { $gt : 1000 } }))
  })
})

describe('$size', function () {
  it('match array sizes', function() {
    assert.equal('jsonb_array_length(data->\'arr\')=3', convert('data', { arr: { $size: 3 } }))
  })
  it('fail for strings', function() {
    assert.throws(() => convert('data', { arr: { $size: 'abc' } }), '$size only supports positive integer')
  })
  it('fail for decimals', function() {
    assert.throws(() => convert('data', { arr: { $size: 3.5 } }), '$size only supports positive integer')
  })
})

describe('$type', function () {
  it('match strings', function() {
    assert.equal('jsonb_typeof(data->\'var\')=\'string\'', convert('data', { var: { $type : 'string' } }))
  })
})

describe('$exists', function () {
  it('work at top level', function() {
    assert.equal('data ? \'name\'', convert('data', { name: { $exists: true } }))
  })
  it('with dot paths', function() {
    assert.equal('data->\'name\' ? \'first\'', convert('data', { 'name.first': { $exists: true } }))
  })
})

describe('$mod', function () {
  it('basic support', function() {
    assert.equal('cast(data->>\'age\' AS numeric) % 2=1', convert('data', { age: { $mod: [2, 1] } }))
  })
})

describe('Match a Field Without Specifying Array Index', function () {
  it('basic case', function() {
    assert.equal('(data @> \'{ "courses": { "distance": "5K" } }\' OR EXISTS (SELECT * FROM jsonb_array_elements' +
        '(data->\'courses\') WHERE jsonb_typeof(data->\'courses\')=\'array\' AND value @> \'{ "distance": "5K" }\'))',
    convert('data', { 'courses.distance': '5K' }, ['courses', 'other']))
  })
  it('basic case matching object', function() {
    assert.equal('(data->\'courses\'=\'{"distance":"5K","loop":true}\'::jsonb OR EXISTS (SELECT * FROM' +
        ' jsonb_array_elements(data->\'courses\') WHERE jsonb_typeof(data->\'courses\')=\'array\' AND' +
        ' value=\'{"distance":"5K","loop":true}\'::jsonb))',
    convert('data', { 'courses': { distance: '5K', loop: true } }, ['courses']))
  })
  it('basic deep case', function() {
    assert.equal('(data @> \'{ "courses": { "distance": "5K" } }\' OR EXISTS (SELECT * FROM jsonb_array_elements' +
        '(data->\'courses\'->\'distance\') WHERE jsonb_typeof(data->\'courses\'->\'distance\')=\'array\' AND value @> \'"5K"\'))',
    convert('data', { 'courses.distance': '5K' }, ['courses.distance']))
  })
  it('direct match', function() {
    assert.equal('(data @> \'{ "roles": "Admin" }\' OR EXISTS (SELECT * FROM jsonb_array_elements(' +
        'data->\'roles\') WHERE jsonb_typeof(data->\'roles\')=\'array\' AND value @> \'"Admin"\'))',
    convert('data', { 'roles': 'Admin' }, ['roles']))
  })
  it('$in', function() {
    assert.equal('(data->>\'roles\' IN (\'Test\', \'Admin\') OR EXISTS (SELECT * FROM jsonb_array_elements(' +
        'data->\'roles\') WHERE jsonb_typeof(data->\'roles\')=\'array\' AND value #>>\'{}\' IN (\'Test\', \'Admin\')))',
    convert('data', { 'roles': { $in: ['Test', 'Admin'] } }, ['roles']))
  })
})
*/
describe('special cases', function () {
  it('should return true when passed no parameters', function () {
    assert.equal('TRUE', convert('data', {}))
  })
})
