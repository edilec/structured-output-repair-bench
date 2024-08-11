import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_LIMITS, benchRepairs } from '../src/index.mjs'

/**
 * Every documented limit, enforced and reachable from the command line.
 *
 * A limit that only exists in the help text is a configuration key that turns a
 * real failure into a green run -- which has happened in this catalog, when a
 * time budget was accepted and then never wired to a clock. So each limit is
 * driven twice: once through the library, and once through its actual flag.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

const SCHEMA = { type: 'object' }
const RECORD = { id: 'r', raw: '{"a": 1,}', expected: { a: 1 } }

function corpusOf(records, schema = SCHEMA) {
  return { corpusVersion: '1', schema, records }
}

function bench(corpus, options = {}) {
  return benchRepairs({ corpusBytes: encode(corpus), strategies: ['scanner'], ...options }).report
}

function nest(depth) {
  let value = '1'
  for (let index = 0; index < depth; index += 1) value = `{"n": ${value}}`
  return value
}

const CASES = [
  { limit: 'maxBytes', flag: '--max-bytes', value: 20, rule: 'corpus-too-large', corpus: corpusOf([RECORD]) },
  { limit: 'maxDepth', flag: '--max-depth', value: 3, rule: 'corpus-too-deep', corpus: corpusOf([{ id: 'r', raw: '{}', expected: JSON.parse(nest(8)) }]) },
  { limit: 'maxRecords', flag: '--max-records', value: 1, rule: 'too-many-records', corpus: corpusOf([RECORD, { ...RECORD, id: 's' }]) },
  { limit: 'maxStrategies', flag: '--max-strategies', value: 1, rule: 'too-many-strategies', corpus: corpusOf([RECORD]), strategies: ['strict', 'scanner'] },
  { limit: 'maxRawBytes', flag: '--max-raw-bytes', value: 4, rule: 'record-too-large', corpus: corpusOf([RECORD]) },
  { limit: 'maxValueDepth', flag: '--max-value-depth', value: 3, rule: 'record-too-deep', corpus: corpusOf([{ id: 'r', raw: `${nest(8)},`, expected: JSON.parse(nest(8)) }]) },
  { limit: 'maxEdits', flag: '--max-edits', value: 1, rule: 'edit-budget-exceeded', corpus: corpusOf([{ id: 'r', raw: '```json\n{"a": [1,], "b": [2,],}\n```', expected: { a: [1], b: [2] } }]) },
  { limit: 'maxSteps', flag: '--max-steps', value: 1, rule: 'step-budget-exceeded', corpus: corpusOf([RECORD]) },
  {
    limit: 'maxMillis',
    flag: '--max-millis',
    value: 1,
    rule: 'time-budget-exceeded',
    corpus: corpusOf([RECORD]),
    // A clock that has already passed the budget when the first record is reached.
    clock: (() => { let calls = 0; return () => (calls += 1) > 1 ? 10_000 : 0 })(),
  },
]

test('the defaults are all positive integers, and every one has a case here', () => {
  for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.ok(Number.isInteger(value) && value > 0, `${name} is not a positive integer`)
  }
  assert.deepEqual(CASES.map((entry) => entry.limit).sort(), Object.keys(DEFAULT_LIMITS).sort())
})

test('every documented limit is enforced, by name, and refuses rather than truncates', () => {
  for (const entry of CASES) {
    const permissive = bench(entry.corpus, entry.strategies === undefined ? {} : { strategies: entry.strategies })
    assert.notEqual(permissive.status, 'incomplete', `${entry.limit}: the input already failed without the limit`)

    const report = bench(entry.corpus, {
      limits: { [entry.limit]: entry.value },
      ...(entry.strategies === undefined ? {} : { strategies: entry.strategies }),
      ...(entry.clock === undefined ? {} : { clock: entry.clock }),
    })
    assert.equal(report.status, 'incomplete', `${entry.limit} did not make the run incomplete`)
    const finding = report.findings.find((candidate) => candidate.ruleId === entry.rule)
    assert.ok(finding !== undefined, `${entry.limit} did not report ${entry.rule}: ${JSON.stringify(report.findings)}`)
    assert.match(finding.message, new RegExp(entry.limit), `${entry.rule} does not name the limit it enforced`)
  }
})

test('every documented limit is reachable from its command-line flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-limits-'))
  after(() => rm(directory, { recursive: true, force: true }))

  for (const entry of CASES) {
    if (entry.limit === 'maxMillis') continue
    const corpusPath = join(directory, `${entry.limit}.json`)
    await writeFile(corpusPath, JSON.stringify(entry.corpus))
    const argv = [cli, '--corpus', corpusPath, '--json', entry.flag, String(entry.value),
      '--strategies', (entry.strategies ?? ['scanner']).join(',')]
    const outcome = await execFileAsync('node', argv).then((ok) => ({ code: 0, ...ok }), (error) => error)
    assert.equal(outcome.code, 2, `${entry.flag} did not make the run incomplete through the CLI`)
    const report = JSON.parse(outcome.stdout)
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === entry.rule), `${entry.flag} did not report ${entry.rule}`)
  }
})

test('the CLI wires a real clock to the time budget', async () => {
  // The defect this pins: a documented time budget accepted by the flag parser
  // and then never handed a clock, so it could never fire. Four thousand
  // attempts cannot be scored inside one millisecond.
  const directory = await mkdtemp(join(tmpdir(), 'bench-deadline-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'corpus.json')
  const records = Array.from({ length: 1000 }, (unused, index) => ({ ...RECORD, id: `r${index}` }))
  await writeFile(corpusPath, JSON.stringify(corpusOf(records)))

  const outcome = await execFileAsync('node', [cli, '--corpus', corpusPath, '--json', '--max-millis', '1'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(outcome.code, 2)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'time-budget-exceeded'))
  assert.ok(report.summary.records < 1000, 'the budget did not stop the bench')
})

test('an unknown limit key is a configuration error, not a default', () => {
  assert.throws(() => bench(corpusOf([RECORD]), { limits: { maxRecord: 1 } }), /Unknown limit "maxRecord"/)
})

test('a limit that is not a positive integer is refused', () => {
  for (const value of [0, -1, 1.5, '10', null, Number.NaN]) {
    assert.throws(() => bench(corpusOf([RECORD]), { limits: { maxRecords: value } }), TypeError)
  }
})

test('an unknown option is a configuration error, not a default', () => {
  assert.throws(() => benchRepairs({ corpusBytes: encode(corpusOf([RECORD])), verbose: true }), /Unknown option "verbose"/)
})

test('a fidelity floor outside 0-100 is a configuration error', () => {
  for (const value of [-1, 101, 1.5, '50', true]) {
    assert.throws(() => bench(corpusOf([RECORD]), { minFidelityPercent: value }), /minFidelityPercent must be an integer between 0 and 100/)
  }
  // `null` and `undefined` mean "not given", which is the documented default.
  for (const value of [null, undefined]) {
    assert.equal(bench(corpusOf([RECORD]), { minFidelityPercent: value }).status, 'pass')
  }
  assert.equal(bench(corpusOf([RECORD]), { minFidelityPercent: 100 }).status, 'pass')
})

test('a bounded-out record is refused whole, and the records around it are still scored', () => {
  const corpus = corpusOf([RECORD, { id: 'big', raw: `{"a": "${'x'.repeat(400)}",}`, expected: { a: 'x'.repeat(400) } }, { ...RECORD, id: 'last' }])
  const report = bench(corpus, { limits: { maxRawBytes: 64 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.records, 2)
  assert.equal(report.summary.attempts, 2)
})

test('an abandoned attempt is counted as abandoned, never as parsed or faithful', () => {
  const corpus = corpusOf([{ id: 'r', raw: '{"a": [1,], "b": [2,],}', expected: { a: [1], b: [2] } }])
  const report = bench(corpus, { limits: { maxEdits: 1 } })
  const score = report.strategies[0]
  assert.equal(score.abandoned, 1)
  assert.equal(score.parsed, 0)
  assert.equal(score.faithful, 0)
  assert.equal(report.summary.checked, 0)
})
