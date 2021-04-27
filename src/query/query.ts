export type Query = Record<string, any>

function stringEscape(str: string): string {
  return str.replace(/'/g, '\'\'')
}

function stringEscape2(str: string): string {
  return str.replace(/"/g, '""')
}

function quote(data: any): string | number {
  if (typeof data === 'string') return "'" + stringEscape(data) + "'"
  if (typeof data === 'number') return data
  return `json(${quote(JSON.stringify(data))})`
}

function quote2(data: string): string {
  return '"' + stringEscape2(data) + '"'
}

function toJson1PathString (pathArr: string[]): string | number {
  return quote(`$.${pathArr.join('.').replace(/\.(\d+)/g, '[$1]')}`)
}

function toJson1Extract(col: string, pathArr: string[]): string {
  if (pathArr === undefined || pathArr.length === 0) return quote2(col)
  return `json_extract(${quote2(col)}, ${toJson1PathString(pathArr)})`
}

function convert(columnName: string, query: Query): string {
  const entries = Object.entries(query)

  if (entries.length === 0) return 'TRUE'

  if (entries.length === 1) {
    const [field, value] = entries[0]
    return `${toJson1Extract(columnName, [ field ])} = ${quote(value)}`
  }

  throw Error('could not convert to SQL string')
}

export default function toSql(columnName: string, query: Query): string {
  return convert(columnName, query)
}
