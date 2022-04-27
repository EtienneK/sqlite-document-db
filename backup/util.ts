export const updateSpecialKeys = ['$currentDate', '$inc', '$min', '$max', '$mul', '$rename', '$set', '$setOnInsert', '$unset', '$push', '$pull', '$pullAll', '$addToSet']

export function toJson1Extract (col: string, pathArr: string[]): string {
  if (pathArr === undefined || pathArr.length === 0) return quote2(col)
  return `json_extract(${quote2(col)}, ${toJson1PathString(pathArr)})`
}

export function toJson1PathString (pathArr: string[]): string | number {
  return quote(`$.${pathArr.join('.').replace(/\.(\d+)/g, '[$1]')}`)
}

export function countUpdateSpecialKeys (doc: object): number {
  return Object.keys(doc).filter(function (n) {
    return updateSpecialKeys.includes(n)
  }).length
}

export function quote (data: any): string | number {
  if (typeof data === 'string') return "'" + stringEscape(data) + "'"
  if (typeof data === 'number') return data
  return `json(${quote(JSON.stringify(data))})`
}

export function quote2 (data: string): string {
  return '"' + stringEscape2(data) + '"'
}

export function stringEscape (str: string): string {
  return str.replace(/'/g, '\'\'')
}

export function stringEscape2 (str: string): string {
  return str.replace(/"/g, '""')
}

export function pathToText (path: string[], isString: boolean): string {
  var text = stringEscape(path[0])
  if (isString && path.length === 1) {
    return text + ' #>>\'{}\''
  }
  for (var i = 1; i < path.length; i++) {
    text += (i === path.length - 1 && isString ? '->>' : '->')
    if (/^\d+$/.test(path[i])) text += path[i] // don't wrap numbers in  quotes
    else text += '\'' + stringEscape(path[i]) + '\''
  }
  return text
}

export function pathToObject (path: string[]): string {
  if (path.length === 1) {
    return quote2(path[0])
  }
  return '\'' + pathToObjectHelper(path) + '\''
}

export function pathToObjectHelper (path: string[]): string {
  if (path.length === 1) {
    if (typeof path[0] === 'string') {
      return `"${path[0]}"`
    } else {
      return path[0]
    }
  }
  const [head, ...tail] = path
  return `{ "${head}": ${pathToObjectHelper(tail)} }`
}

export function convertDotNotation (path: string, pathDotNotation: string): string {
  return pathToText([path].concat(pathDotNotation.split('.')), true)
}

export function toPostgresPath (path: string[]): string {
  return '\'{' + path.join(',') + '}\''
}

export function toNumeric (path: string): string {
  return 'COALESCE(Cast(' + path + ' as numeric),0)'
}

const typeMapping: { [key: number]: string } = {
  1: 'number',
  2: 'string',
  3: 'object',
  4: 'array',
  8: 'boolean',
  10: 'null',
  16: 'number',
  18: 'number',
  19: 'number'
}

export function getPostgresTypeName (type: any): any {
  if (!['string', 'number'].includes(typeof type)) {
    throw new Error('argument to $type is not a number or a string')
  }
  return typeMapping[type as number] ?? type
}
