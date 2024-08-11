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
 * Byte-identical stdout for identical inputs.
 *
 * This is the constraint that decides where latency is reported. A bench
 * measures milliseconds by definition, and milliseconds differ between runs by
 * construction -- so they go to stderr, and stdout carries a deterministic cost
 * in work units instead. A report is diffed between machines and pasted into
 * issues; a number that changes every run makes every diff noise.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')
const examples = join(projectDirectory, 'examples')

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

const CORPUS = {
  corpusVersion: '1',
  schema: { type: 'object', properties: { b: { type: 'number' }, a: { type: 'number' } } },
  records: [
    { id: 'r1', raw: '{"b": 1, "a": 2,}', expected: { a: 2, b: 1 } },
    { id: 'r2', raw: 'not json', expected: { a: 1 } },
    { id: 'r3', raw: '{"a": "x", "b": 9,}', expected: { a: 1, b: 9 } },
  ],
}

test('the same inputs produce the same report in the same process', () => {
  const first = benchRepairs({ corpusBytes: encode(CORPUS) }).report
  const second = benchRepairs({ corpusBytes: encode(CORPUS) }).report
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('key insertion order in the corpus does not change the report', () => {
  // Object key order is preserved by JSON.parse, so a tool that iterated it
  // would emit different reports for two corpora that mean the same thing.
  const reordered = {
    corpusVersion: '1',
    schema: CORPUS.schema,
    records: CORPUS.records.map((entry) => ({
      expected: Object.fromEntries(Object.entries(entry.expected).reverse()),
      raw: entry.raw,
      id: entry.id,
    })),
  }
  const straight = benchRepairs({ corpusBytes: encode(CORPUS) }).report
  const shuffled = benchRepairs({ corpusBytes: encode(reordered) }).report
  assert.equal(JSON.stringify(straight), JSON.stringify(shuffled))
})

test('a moving wall clock does not change the report', () => {
  let now = 0
  const moving = benchRepairs({ corpusBytes: encode(CORPUS), clock: () => { now += 7; return now } }).report
  const frozen = benchRepairs({ corpusBytes: encode(CORPUS), clock: () => 0 }).report
  assert.equal(JSON.stringify(moving), JSON.stringify(frozen))
})

test('no measured duration appears anywhere in the report', () => {
  /*
   * The structural version of the rule: a duration in stdout would have to
   * change between runs, so there must not be one. Two independent checks --
   * every number in the report is an integer, and no measured value appears in
   * its text -- because either alone can be satisfied by accident. The clock
   * ticks by a fraction so a latency reading cannot coincide with a count.
   */
  let now = 0
  const { report, latency } = benchRepairs({ corpusBytes: encode(CORPUS), clock: () => { now += 13.25; return now } })
  assert.ok(Object.values(latency).some((millis) => millis > 0), 'latency was not measured at all')

  const numbers = []
  const collect = (value) => {
    if (typeof value === 'number') numbers.push(value)
    else if (Array.isArray(value)) for (const item of value) collect(item)
    else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collect(item)
  }
  collect(report)
  assert.ok(numbers.length > 0)
  for (const value of numbers) assert.ok(Number.isInteger(value), `${value} is not an integer`)

  const serialised = JSON.stringify(report)
  for (const millis of Object.values(latency)) {
    assert.ok(!serialised.includes(String(millis)), `a measured duration (${millis}) reached the report`)
  }
})

test('the deterministic cost is reported instead, and is the same every run', () => {
  const first = benchRepairs({ corpusBytes: encode(CORPUS), clock: () => 0 }).report
  const second = benchRepairs({ corpusBytes: encode(CORPUS), clock: () => 5000 }).report
  assert.ok(first.summary.cost > 0)
  assert.equal(first.summary.cost, second.summary.cost)
  assert.deepEqual(first.strategies.map((score) => score.cost), second.strategies.map((score) => score.cost))
})

test('two command-line runs over the shipped examples are byte-identical', async () => {
  for (const corpus of ['corpus.json', 'corpus-altered.json']) {
    const run = () => execFileAsync('node', [cli, '--corpus', join(examples, corpus), '--json'])
      .then((ok) => ok.stdout, (error) => error.stdout)
    const first = await run()
    const second = await run()
    assert.equal(first, second)
    assert.notEqual(first, '')
  }
})

test('the report parses as JSON and carries the documented envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-envelope-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'corpus.json')
  await writeFile(corpusPath, JSON.stringify(CORPUS))
  const outcome = await execFileAsync('node', [cli, '--corpus', corpusPath, '--json'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'structured-output-repair-bench')
  assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
  for (const key of ['checked', 'errors', 'warnings']) assert.equal(typeof report.summary[key], 'number')
  for (const finding of report.findings) {
    assert.equal(typeof finding.ruleId, 'string')
    assert.ok(['error', 'info', 'warning'].includes(finding.severity))
    assert.equal(typeof finding.message, 'string')
    assert.equal(typeof finding.location.file, 'string')
    assert.ok(!finding.location.file.startsWith('/'), 'location.file must never be an absolute host path')
  }
})

test('stdout carries the report and stderr carries the timing', async () => {
  const outcome = await execFileAsync('node', [cli, '--corpus', join(examples, 'corpus.json'), '--json'])
  assert.doesNotThrow(() => JSON.parse(outcome.stdout))
  assert.match(outcome.stderr, /^latency: /m)
  assert.match(outcome.stderr, /ms/)
  assert.ok(!outcome.stdout.includes('latency'), 'timing reached stdout')
})
