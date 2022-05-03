export type QueryFilterDocument = Record<string, any>

function stringEscape (str: string): string {
  return str.replace(/'/g, '\'\'')
}

function stringEscape2 (str: string): string {
  return str.replace(/"/g, '""')
}

function quote (data: any): string | number {
  if (typeof data === 'string') return "'" + stringEscape(data) + "'"
  if (typeof data === 'number') return data
  if (data === null) return 'null'
  if (data === true) return 'TRUE'
  if (data === false) return 'FALSE'
  return `json(${quote(JSON.stringify(data))})`
}

function quote2 (data: string): string {
  return '"' + stringEscape2(data) + '"'
}

function toJson1PathString (pathArr: string[]): string | number {
  const firstDot = (pathArr.length === 1 && pathArr[0] === '') ? '' : '.'
  return quote(`$${firstDot}${pathArr.join('.').replace(/\.(\d+)/g, '[$1]')}`)
}

function toJson1Extract (col: string, pathArr: string[]): string {
  if (pathArr === undefined || pathArr.length === 0) return quote2(col)
  return `json_extract(${quote2(col)}, ${toJson1PathString(pathArr)})`
}

const OPS = {
  // Comparison Query Operators
  $eq: 'is',
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
  $ne: 'is not',
  $in: 'IN',
  $nin: 'NOT IN',
  // Logical Query Operators
  $and: 'AND',
  $or: 'OR',
  $not: 'NOT',
  $nor: 'OR',
  // Element Query Operators
  $exists: null,
  // Array Query Operators
  $all: null,
  $elemMatch: null,
  $size: null
}
const OPS_KEYS = Object.keys(OPS)

function countOps (keys: string[]): number {
  return keys.filter(k => OPS_KEYS.includes(k)).length
}

function convertOp (columnName: string, field: string, op: string, value: string | number | any[]): string {
  switch (op) {
    // ---------------------- Comparison Query Operators ----------------------
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
    case '$ne':
    case '$eq': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'object' && typeof value !== 'boolean') {
        throw Error(`$${op} expects value to be of type: number | string | boolean | object | null; but got: ${typeof value}`)
      }
      // Have to put this in for $not operator, otherwise $not doesn't work for null/undefined fields
      const notNull = op === '$eq' || op === '$ne' ? '' : `AND ${toJson1Extract(columnName, [field])} IS NOT NULL`
      return `${toJson1Extract(columnName, [field])} ${OPS[op]} ${quote(value)} ${notNull}`
    }
    case '$in': {
      if (!Array.isArray(value)) throw Error(`$in expects value to be of type: array; but got: ${typeof value}`)
      const valueIncludesNull = value.includes(null) ? `OR ${toJson1Extract(columnName, [field])} IS NULL` : ''
      return `(${toJson1Extract(columnName, [field])} ${OPS[op]} (${value.map(quote).join(',')}) ${valueIncludesNull})`
    }
    case '$nin': {
      if (!Array.isArray(value)) throw Error(`$nin expects value to be of type: array; but got: ${typeof value}`)
      let valueWithoutNull = value
      let valueWithoutNullSql = `OR ${toJson1Extract(columnName, [field])} IS NULL`
      if (valueWithoutNull.includes(null)) {
        valueWithoutNull = valueWithoutNull.filter(v => v !== null)
        valueWithoutNullSql = `AND ${toJson1Extract(columnName, [field])} IS NOT NULL`
      }
      return `(${toJson1Extract(columnName, [field])} ${OPS[op]} (${valueWithoutNull.map(quote).join(',')}) ${valueWithoutNullSql})`
    }
    // ---------------------- Logical Query Operators ----------------------
    case '$nor':
    case '$or':
    case '$and': {
      if (!Array.isArray(value)) throw Error(`$${op} expects value to be of type: array; but got: ${typeof value}`)
      return `${op === '$nor' ? 'NOT' : ''} ((${value
        .map(q => convert(columnName, q))
        .join(`) ${OPS[op]} (`)}))`
    }
    case '$not': {
      if (Array.isArray(value) || typeof value !== 'object') throw Error(`$${op} expects value to be of type: non-array-object; but got: ${typeof value}`)
      return `${OPS[op]}(${convert(columnName, { [field]: value })})`
    }
    // ---------------------- Element Query Operators ----------------------
    case '$exists': {
      if (typeof value !== 'boolean') throw Error(`$exists expects value to be of type: boolean; but got: ${typeof value}`)
      return `select count(*) ${value ? '>' : '='} 0 from json_each(${quote2(columnName)}, ${toJson1PathString([field])})`
    }
    // ---------------------- Array Query Operators ----------------------
    case '$all': {
      if (!Array.isArray(value)) throw Error(`$all expects value to be of type: array; but got: ${typeof value}`)
      return `(select count(*) from json_each(${toJson1Extract(columnName, [field])}) where value in (select value from json_each(${quote(value)}))) = ${quote(new Set(value).size)}`
    }
    case '$elemMatch': {
      if (Array.isArray(value) || typeof value !== 'object') throw Error(`$${op} expects value to be of type: non-array-object; but got: ${typeof value}`)
      const $and = Object.entries(value).map(([key, value]) => ({ [key]: value })).map(o => ({ f: o }))
      return `EXISTS (select json_object('f', json(value)) as valueJson from json_each(${toJson1Extract(columnName, [field])}) where (${convert('valueJson', { $and })}))`
    }
    case '$size': {
      if (typeof value !== 'number') throw Error(`$size expects value to be of type: number; but got: ${typeof value}`)
      return `json_array_length(${quote2(columnName)}, ${toJson1PathString([field])}) = ${quote(value)}`
    }
  }

  throw Error('could not convert to SQL string - invalid op: ' + op)
}

function convert (columnName: string, query: QueryFilterDocument): string {
  const entries = Object.entries(query)

  if (entries.length === 0) return 'TRUE'

  const [field, valueOrOp] = entries[0]
  let value = valueOrOp
  if (entries.length === 1) {
    const opEqualsField = OPS_KEYS.includes(field)
    let op = opEqualsField ? field : '$eq'

    if (!opEqualsField && typeof valueOrOp === 'object' && valueOrOp !== null) {
      const valueOrOpKeys = Object.keys(valueOrOp)
      if (valueOrOpKeys.length === 1 && countOps(valueOrOpKeys) === 1) {
        // Expressions in the form: { field: { $operator: value } }, where field is not an operator and value is an object
        op = valueOrOpKeys[0]
        value = value[op]
      } else if (valueOrOpKeys.length > 1 && countOps(valueOrOpKeys) === valueOrOpKeys.length) {
        // Expressions in the form: { field: { $operator1: value, $operator2: value } }
        return `(${valueOrOpKeys.map(opKey => ({ [field]: { [opKey]: value[opKey] } }))
          .map(q => convert(columnName, q))
          .join(') AND (')})`
      }
    }

    // Expressions in the form: { field: { $operator: value } } OR { field: value }, where field could be an operator
    return convertOp(columnName, field, op, value)
  }

  // Expressions in the form: { field1: value1, field2: value2 }
  return `(${entries.map(([key, value]) => ({ [key]: value }))
    .map(q => convert(columnName, q))
    .join(') AND (')})`
}

export function toSql (columnName: string, query: QueryFilterDocument): string {
  return convert(columnName, query)
}
