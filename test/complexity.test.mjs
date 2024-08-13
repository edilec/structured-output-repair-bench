import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS } from '../src/index.mjs'
import { PRESETS, PRESET_NAMES, runPipeline } from '../src/repair.mjs'

/**
 * Work that grows faster than its input.
 *
 * `src/repair.mjs` claims in its own header that no primitive is "a regular
 * expression whose work can grow faster than the length of its input". The
 * closing-fence pattern `/\r?\n?[ \t]*```[ \t]*$/` was exactly that: anchored
 * only at the end, so the engine retries it at every index, and greedy
 * `[ \t]*` walks a run of blanks to the end and backtracks over all of it
 * before failing. Measured in isolation: 29 ms at 5 kB, 108 ms at 10 kB,
 * 574 ms at 20 kB, 2175 ms at 40 kB -- four times the work for twice the input.
 *
 * `strip-code-fence` is the first step of three of the four built-in presets,
 * so ONE record at the documented-legal `maxRawBytes` made a whole run take ten
 * seconds. The header comment was the only thing defending the claim, and a
 * comment defends nothing.
 *
 * That the fence shapes are still recognised after the rewrite is
 * `test/repair.test.mjs`; a scan that stopped stripping fences would pass every
 * assertion here.
 */

/** A record at the largest size the documented limits accept. */
function paddedRecord(id, padding) {
  const note = ' '.repeat(padding)
  return { id, raw: `{"note": "${note}"}`, expected: { note } }
}

test('a record at the documented maxRawBytes does not cost seconds in any preset', () => {
  /*
   * An absolute bound, not a ratio, because the ratio between two sub-
   * millisecond measurements is noise. The margins are what make it safe: the
   * defect took ~10 s of pipeline work on this input and the fix takes single
   * -digit milliseconds, so 2000 ms sits five times under the broken case and
   * hundreds of times over the fixed one.
   */
  const record = paddedRecord('pad', 60_000)
  const rawBytes = Buffer.byteLength(record.raw, 'utf8')
  assert.ok(rawBytes <= DEFAULT_LIMITS.maxRawBytes, `the fixture is over the documented limit at ${rawBytes} bytes`)
  assert.ok(rawBytes > DEFAULT_LIMITS.maxRawBytes / 2, 'the fixture is too small to be near the limit')

  const meter = { steps: 0 }
  const openedAt = performance.now()
  for (const name of PRESET_NAMES) runPipeline([...PRESETS[name]], record.raw, DEFAULT_LIMITS, meter)
  const elapsed = performance.now() - openedAt
  assert.ok(elapsed < 2000, `every built-in preset over one legal record took ${elapsed.toFixed(0)} ms`)
})

test('the pipeline grows with its input, not with its square', () => {
  /*
   * A growth check over a 16x span. Quadratic work multiplies by ~256 across
   * it; linear work multiplies by ~16. The assertion allows 64 -- far above any
   * plausible linear run including its measurement noise, and far below what
   * the defect produced.
   */
  const steps = [...PRESETS.span]
  const time = (padding) => {
    const text = paddedRecord('x', padding).raw
    let best = Number.POSITIVE_INFINITY
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const openedAt = performance.now()
      runPipeline(steps, text, DEFAULT_LIMITS, { steps: 0 })
      best = Math.min(best, performance.now() - openedAt)
    }
    // A floor, so a fast machine cannot divide by something near zero.
    return Math.max(best, 0.05)
  }

  const small = time(2_000)
  const large = time(32_000)
  assert.ok(large / small < 64, `16x the input cost ${(large / small).toFixed(1)}x the time (${small.toFixed(2)} ms to ${large.toFixed(2)} ms)`)
})
