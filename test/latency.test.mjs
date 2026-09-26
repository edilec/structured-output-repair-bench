import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { benchRepairs } from '../src/index.mjs'

/**
 * Latency: measured per strategy, injected rather than read, and reported on
 * stderr.
 *
 * The build asks for latency, and the report contract asks for byte-identical
 * stdout. Both are satisfiable, but only by putting them in different places:
 * the measurement is real and per-strategy, it goes to stderr where the
 * contract puts timing, and stdout carries a deterministic cost in work units
 * that stands in for it when two runs have to be compared.
 *
 * The clock is a parameter, so the measurement itself can be asserted exactly
 * rather than approximately -- a test that asserted "took more than 0ms" would
 * pass against a stopped clock.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

const CORPUS = {
  corpusVersion: '1',
  schema: { type: 'object' },
  records: [
    { id: 'r1', raw: '{"a": 1,}', expected: { a: 1 } },
    { id: 'r2', raw: '{"b": 2,}', expected: { b: 2 } },
  ],
}

/** A clock that advances by exactly one millisecond on every reading. */
function tickingClock() {
  let now = 0
  return () => {
    now += 1
    return now
  }
}

test('latency is measured for every selected strategy, by name', () => {
  const { latency } = benchRepairs({ corpusBytes: encode(CORPUS), clock: tickingClock() })
  assert.deepEqual(Object.keys(latency).sort(), ['naive-regex', 'scanner', 'span', 'strict'])
  for (const [name, millis] of Object.entries(latency)) {
    assert.ok(Number.isFinite(millis) && millis >= 0, `${name} has no measurement`)
  }
})

test('the measurement is the clock the caller supplied, exactly', () => {
  // Two records, one reading before and one after each attempt, and a clock
  // that ticks one millisecond per reading: every strategy must measure exactly
  // two milliseconds. A tool that read the host clock instead would not.
  const { latency } = benchRepairs({ corpusBytes: encode(CORPUS), clock: tickingClock() })
  for (const [name, millis] of Object.entries(latency)) {
    assert.equal(millis, 2, `${name} did not measure the injected clock`)
  }
})

test('a strategy that is not selected gets no measurement at all', () => {
  const { latency } = benchRepairs({ corpusBytes: encode(CORPUS), strategies: ['scanner'], clock: tickingClock() })
  assert.deepEqual(Object.keys(latency), ['scanner'])
})

test('latency scales with the number of attempts, not with wall-clock luck', () => {
  const one = benchRepairs({
    corpusBytes: encode({ ...CORPUS, records: [CORPUS.records[0]] }),
    strategies: ['scanner'],
    clock: tickingClock(),
  }).latency
  const four = benchRepairs({
    corpusBytes: encode({ ...CORPUS, records: [...CORPUS.records, { id: 'r3', raw: '{}', expected: {} }, { id: 'r4', raw: '{}', expected: {} }] }),
    strategies: ['scanner'],
    clock: tickingClock(),
  }).latency
  assert.equal(one.scanner, 1)
  assert.equal(four.scanner, 4)
})

test('the command line prints the measurement on stderr and never on stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-latency-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'corpus.json')
  await writeFile(corpusPath, JSON.stringify(CORPUS))

  const outcome = await execFileAsync('node', [cli, '--corpus', corpusPath, '--json'])
  assert.match(outcome.stderr, /^latency: strict [\d.]+ms, span [\d.]+ms, naive-regex [\d.]+ms, scanner [\d.]+ms$/m)
  assert.ok(!outcome.stdout.includes('ms'), 'a duration reached stdout')
  assert.doesNotThrow(() => JSON.parse(outcome.stdout))
})

test('two runs agree on stdout while each reports its own measurement on stderr', () => {
  /*
   * The reason latency lives on stderr, stated without a race.
   *
   * Asserting that two real runs disagree to the microsecond would be a test
   * that fails when a machine is quiet, so the disagreement is shown with an
   * injected clock instead: two identical corpora, two different clocks, two
   * different measurements -- and one identical report.
   */
  const slow = benchRepairs({ corpusBytes: encode(CORPUS), clock: tickingClock() })
  let fast = 0
  const faster = benchRepairs({ corpusBytes: encode(CORPUS), clock: () => (fast += 100) })

  assert.notDeepEqual(slow.latency, faster.latency, 'the measurement does not follow the clock')
  assert.equal(JSON.stringify(slow.report), JSON.stringify(faster.report), 'the report followed the clock')
})
