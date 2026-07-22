import { isObjectIdHexString, objectIdHexString } from '../src/object-id.js'

describe('objectIdHexString', () => {
  it('should generate a 24-character hex string', () => {
    expect(objectIdHexString()).toMatch(/^[0-9a-f]{24}$/)
  })

  it('should not repeat itself', () => {
    const ids = new Set(Array.from({ length: 10_000 }, objectIdHexString))
    expect(ids.size).toStrictEqual(10_000)
  })

  it('should increase monotonically within a process', () => {
    const ids = Array.from({ length: 1_000 }, objectIdHexString)
    expect(ids.toSorted()).toStrictEqual(ids)
  })

  it('should encode the current time in the leading 4 bytes', () => {
    const seconds = parseInt(objectIdHexString().slice(0, 8), 16)
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(5)
  })

  it('should share a per-process random section across ids', () => {
    expect(objectIdHexString().slice(8, 18)).toStrictEqual(objectIdHexString().slice(8, 18))
  })
})

describe('isObjectIdHexString', () => {
  it('should accept generated ids', () => {
    expect(isObjectIdHexString(objectIdHexString())).toStrictEqual(true)
  })

  it('should reject anything else', () => {
    for (const value of ['', 'nope', 'A'.repeat(24), '0'.repeat(23), '0'.repeat(25), null, undefined, 12345]) {
      expect(isObjectIdHexString(value)).toStrictEqual(false)
    }
  })
})
