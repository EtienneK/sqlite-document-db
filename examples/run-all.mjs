// Runs every numbered example in order, in one process.
//
//   npm run examples            (builds first, so a fresh clone works)
//   node examples/run-all.mjs   (if dist/ is already built)
//   deno run --allow-read --allow-write --allow-env examples/run-all.mjs
//
// Each example is a self-contained module with top-level await, so importing
// it runs it. That works identically under Node and Deno, which is why this
// runner spawns nothing.
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const examples = (await readdir(here)).filter(name => /^\d\d-.+\.mjs$/.test(name)).toSorted()

for (const name of examples) {
  console.log(`\n${'─'.repeat(72)}\n  ${name}\n${'─'.repeat(72)}`)
  await import(new URL(name, import.meta.url).href)
}

console.log(`\n${examples.length} examples ran without error.`)
