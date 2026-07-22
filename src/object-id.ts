import { randomBytes } from 'node:crypto'

/**
 * Generates MongoDB-compatible ObjectId hex strings.
 *
 * The 12-byte layout is the one MongoDB has used since 3.4:
 *
 *   bytes 0-3   seconds since the Unix epoch, big-endian
 *   bytes 4-8   a 5-byte value generated once per process
 *   bytes 9-11  a counter, randomly seeded and incremented per id
 *
 * That makes ids monotonically increasing within a process and unlikely to
 * collide across them, which is all we rely on for `_id`.
 */

const PROCESS_RANDOM = randomBytes(5)

const COUNTER_MAX = 0xffffff
let counter = randomBytes(3).readUIntBE(0, 3)

export function objectIdHexString (): string {
  counter = (counter + 1) % (COUNTER_MAX + 1)

  const buffer = Buffer.allocUnsafe(12)
  buffer.writeUInt32BE(Math.floor(Date.now() / 1000), 0)
  PROCESS_RANDOM.copy(buffer, 4)
  buffer.writeUIntBE(counter, 9, 3)

  return buffer.toString('hex')
}

/** True if `value` looks like a 24-character ObjectId hex string. */
export function isObjectIdHexString (value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)
}
