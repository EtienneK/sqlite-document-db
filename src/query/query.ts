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
  return quote(`$.${pathArr.join('.').replace(/\.(\d+)/g, '[$1]')}`)
}

function toJson1Extract (col: string, pathArr: string[]): string {
  if (pathArr === undefined || pathArr.length === 0) return quote2(col)
  return `json_extract(${quote2(col)}, ${toJson1PathString(pathArr)})`
}

const OPS = {
  $eq: 'is',
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
  $ne: 'is not',
  $in: 'IN',
  $nin: 'NOT IN',
  $all: null,
  $size: null,
  $exists: null
}
const OPS_KEYS = Object.keys(OPS)

function countOps (keys: string[]): number {
  return keys.filter(k => OPS_KEYS.includes(k)).length
}

function convertOp (columnName: string, field: string, op: string, value: string | number | any[]): string {
  switch (op) {
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
    case '$ne':
    case '$eq': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'object' && typeof value !== 'boolean') {
        throw Error(`${op} expects value to be of type: number | string | boolean | object | null; but got: ${typeof value}`)
      }
      return `${toJson1Extract(columnName, [field])} ${OPS[op]} ${quote(value)}`
    }
    case '$in': {
      if (!Array.isArray(value)) throw Error('$in expects value to be of type: array')
      const valueIncludesNull = value.includes(null) ? `OR ${toJson1Extract(columnName, [field])} IS NULL` : ''
      return `(${toJson1Extract(columnName, [field])} ${OPS[op]} (${value.map(quote).join(',')}) ${valueIncludesNull})`
    }
    case '$nin': {
      if (!Array.isArray(value)) throw Error('$nin expects value to be of type: array')
      let valueWithoutNull = value
      let valueWithoutNullSql = `OR ${toJson1Extract(columnName, [field])} IS NULL`
      if (valueWithoutNull.includes(null)) {
        valueWithoutNull = valueWithoutNull.filter(v => v !== null)
        valueWithoutNullSql = `AND ${toJson1Extract(columnName, [field])} IS NOT NULL`
      }
      return `(${toJson1Extract(columnName, [field])} ${OPS[op]} (${valueWithoutNull.map(quote).join(',')}) ${valueWithoutNullSql})`
    }
    case '$all': {
      if (!Array.isArray(value)) throw Error('$all expects value to be of type: array')
      return `(select count(*) from json_each(${toJson1Extract(columnName, [field])}) where value in (select value from json_each(${quote(value)}))) = ${quote(new Set(value).size)}`
    }
    case '$size': {
      if (typeof value !== 'number') throw Error('$size expects value to be of type: number')
      return `json_array_length(${quote2(columnName)}, ${toJson1PathString([field])}) = ${quote(value)}`
    }
    case '$exists': {
      if (typeof value !== 'boolean') throw Error('$exists expects value to be of type: boolean')
      return `select count(*) ${value ? '>' : '='} 0 from json_each(${quote2(columnName)}, ${toJson1PathString([field])})`
    }
  }

  throw Error('could not convert to SQL string - invalid op: ' + op)
}

function convert (columnName: string, query: QueryFilterDocument): string {
  const entries = Object.entries(query)

  if (entries.length === 0) return 'TRUE'

  if (entries.length === 1) {
    const [field, valueOrOp] = entries[0]

    if (field === '$or') {
      if (!Array.isArray(valueOrOp)) throw Error('$or expects value to be an array')
      return `(${valueOrOp
        .map(q => convert(columnName, q))
        .join(') OR (')})`
    }

    if (field === '$and') {
      if (!Array.isArray(valueOrOp)) throw Error('$and expects value to be an array')
      return `(${valueOrOp
        .map(q => convert(columnName, q))
        .join(') AND (')})`
    }

    let op = '$eq'
    let value = valueOrOp
    if (typeof valueOrOp === 'object' && valueOrOp !== null) {
      const valueOrOpKeys = Object.keys(valueOrOp)
      if (valueOrOpKeys.length === 1 && countOps(valueOrOpKeys) === 1) {
        op = valueOrOpKeys[0]
        value = value[op]
      } else if (valueOrOpKeys.length > 1 && countOps(valueOrOpKeys) === valueOrOpKeys.length) {
        return `(${valueOrOpKeys.map(opKey => ({ [field]: { [opKey]: value[opKey] } }))
          .map(q => convert(columnName, q))
          .join(') AND (')})`
      }
    }
    return convertOp(columnName, field, op, value)
  }

  return `(${entries.map(([key, value]) => ({ [key]: value }))
    .map(q => convert(columnName, q))
    .join(') AND (')})`
}

export function toSql (columnName: string, query: QueryFilterDocument): string {
  return convert(columnName, query)
}
