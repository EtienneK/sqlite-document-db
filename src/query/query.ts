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
  $eq: '=',
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
  $ne: ' <> '
}

function convertOp (columnName: string, field: string, op: string, value: string | number | any[]): string {
  switch (op) {
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
    case '$ne':
    case '$eq': {
      if (typeof value !== 'string' && typeof value !== 'number') { throw Error(`${op} expects value to be a number or a string`) }
      return `${toJson1Extract(columnName, [field])} ${OPS[op]} ${quote(value)}`
    }
    case '$in': {
      if (!Array.isArray(value)) throw Error('$in expects value to be an array')
      return `${toJson1Extract(columnName, [field])} IN (${value.map(quote).join(',')})`
    }
  }

  throw Error('could not convert to SQL string')
}

function convert (columnName: string, query: QueryFilterDocument): string {
  const entries = Object.entries(query)

  if (entries.length === 0) return 'TRUE'

  if (entries.length === 1) {
    const [field, valueOrOp] = entries[0]

    let op = '$eq'
    let value = valueOrOp
    if (typeof valueOrOp === 'object' && valueOrOp !== null) {
      op = Object.keys(value)[0]
      value = value[op]
    }
    return convertOp(columnName, field, op, value)
  }

  return `(${entries.map(([key, value]) => ({ [key]: value }))
    .map(entry => convert(columnName, entry))
    .join(') AND (')})`
}

export default function toSql (columnName: string, query: QueryFilterDocument): string {
  return convert(columnName, query)
}
