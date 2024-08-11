import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { INCOMPLETE_RULES, benchRepairs } from '../src/index.mjs'

/**
 * Unknown is never a pass.
 *
 * Every rule in `INCOMPLETE_RULES` is driven through the real command line and
 * asserted to produce status `incomplete` and exit 2. Membership in that list
 * is the ONLY thing that separates exit 2 from exit 1 here, so dropping any one
 * rule from it turns the matching assertion red -- which is what makes this a
 * guard rather than a restatement of the list.
 *
 * For a bench the distinction is sharp. `fail` says "a strategy changed a
 * record's meaning". `incomplete` says "this comparison did not happen", and a
 * reader choosing a repair strategy on the strength of an incomplete run would
 * be choosing on numbers that were never measured.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')

const SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } }
const RECORD = { id: 'r', raw: '{"n": 1,}', expected: { n: 1 } }
const corpus = (records, schema = SCHEMA) => ({ corpusVersion: '1', schema, records })

function nest(depth) {
  let value = 1
  for (let index = 0; index < depth; index += 1) value = { n: value }
  return value
}

function deepRaw(depth) {
  let value = '1'
  for (let index = 0; index < depth; index += 1) value = `{"n": ${value}}`
  return `${value},`
}

const CASES = {
  'corpus-empty': { corpus: corpus([]) },
  'corpus-malformed': { corpus: { corpusVersion: '9', schema: SCHEMA, records: [] } },
  'corpus-not-json': { corpusBytes: '{ not json' },
  'corpus-not-utf8': { corpusBytes: Buffer.from([0xff, 0xfe, 0xfd]) },
  'corpus-too-deep': { corpus: corpus([{ id: 'r', raw: '{}', expected: nest(40) }]), flags: ['--max-depth', '5'] },
  'corpus-too-large': { corpus: corpus([RECORD]), flags: ['--max-bytes', '10'] },
  'corpus-unreadable': { missingCorpus: true },
  'edit-budget-exceeded': {
    corpus: corpus([{ id: 'r', raw: '```json\n{"n": 1, "a": [1,],}\n```', expected: { n: 1, a: [1] } }]),
    flags: ['--strategies', 'scanner', '--max-edits', '2'],
  },
  'pipelines-malformed': {
    corpus: corpus([RECORD]),
    pipelines: { pipelinesVersion: '1', strategies: [{ name: 'x', steps: ['nope'] }] },
    flags: ['--strategies', 'scanner'],
  },
  'pipelines-not-json': { corpus: corpus([RECORD]), pipelinesBytes: 'nope', flags: ['--strategies', 'scanner'] },
  'pipelines-not-utf8': { corpus: corpus([RECORD]), pipelinesBytes: Buffer.from([0xc3, 0x28]), flags: ['--strategies', 'scanner'] },
  'pipelines-too-deep': {
    corpus: corpus([RECORD]),
    pipelines: { pipelinesVersion: '1', strategies: [{ name: 'x', steps: [], note: nest(40) }] },
    flags: ['--strategies', 'scanner', '--max-depth', '5'],
  },
  'pipelines-too-large': { corpus: corpus([RECORD]), pipelines: { pipelinesVersion: '1', strategies: [] }, flags: ['--strategies', 'scanner', '--max-bytes', '10'] },
  'pipelines-unreadable': { corpus: corpus([RECORD]), missingPipelines: true, flags: ['--strategies', 'scanner'] },
  'record-malformed': { corpus: corpus([{ raw: '{}', expected: {} }]) },
  'record-too-deep': { corpus: corpus([{ id: 'r', raw: deepRaw(10), expected: nest(10) }]), flags: ['--strategies', 'scanner', '--max-value-depth', '4'] },
  'record-too-large': { corpus: corpus([{ id: 'r', raw: `{"n": "${'x'.repeat(200)}",}`, expected: { n: 1 } }]), flags: ['--max-raw-bytes', '32'] },
  'record-unlabelled': { corpus: corpus([{ id: 'r', raw: '{"n": 1}' }]) },
  'schema-unsupported': { corpus: corpus([RECORD], { type: 'object', patternProperties: {} }), flags: ['--strategies', 'strict'] },
  'step-budget-exceeded': { corpus: corpus([RECORD]), flags: ['--strategies', 'scanner', '--max-steps', '1'] },
  'strategy-unknown': { corpus: corpus([RECORD]), flags: ['--strategies', 'nope'] },
  'time-budget-exceeded': {
    corpus: corpus(Array.from({ length: 1000 }, (unused, index) => ({ ...RECORD, id: `r${index}` }))),
    flags: ['--max-millis', '1'],
  },
  'too-many-records': { corpus: corpus([RECORD, { ...RECORD, id: 's' }]), flags: ['--max-records', '1'] },
  'too-many-strategies': { corpus: corpus([RECORD]), flags: ['--strategies', 'strict,scanner', '--max-strategies', '1'] },
}

test('every rule that means "unanswered" has a case here, and every case names a real rule', () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...INCOMPLETE_RULES].sort())
})

test('every unanswered question produces status incomplete and exit 2, never a pass', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-incomplete-'))
  after(() => rm(directory, { recursive: true, force: true }))

  for (const [rule, scenario] of Object.entries(CASES)) {
    const corpusPath = join(directory, `${rule}-corpus.json`)
    if (!scenario.missingCorpus) {
      await writeFile(corpusPath, scenario.corpusBytes ?? JSON.stringify(scenario.corpus))
    }
    const argv = [cli, '--corpus', corpusPath, '--json', ...(scenario.flags ?? [])]
    if (scenario.pipelines !== undefined || scenario.pipelinesBytes !== undefined || scenario.missingPipelines) {
      const pipelinesPath = join(directory, `${rule}-pipelines.json`)
      if (!scenario.missingPipelines) {
        await writeFile(pipelinesPath, scenario.pipelinesBytes ?? JSON.stringify(scenario.pipelines))
      }
      argv.push('--pipelines', pipelinesPath)
    }
    const outcome = await execFileAsync('node', argv).then((ok) => ({ code: 0, ...ok }), (error) => error)

    assert.equal(outcome.code, 2, `${rule}: exit ${outcome.code}; unknown evidence must never exit 0 or 1\n${outcome.stdout}`)
    assert.notEqual(outcome.stdout, '', `${rule}: an unreadable input still owes the consumer a report`)
    const report = JSON.parse(outcome.stdout)
    assert.equal(report.status, 'incomplete', `${rule}: status ${report.status}`)
    assert.ok(report.findings.some((finding) => finding.ruleId === rule), `${rule}: not reported\n${outcome.stdout}`)
    assert.ok(report.summary.unknown > 0, `${rule}: summary.unknown is 0`)
    assert.match(outcome.stderr, /this run is not a verdict/, `${rule}: stderr did not say the run is not a verdict`)
  }
})

test('an incomplete run counts only the attempts it actually scored', async () => {
  // Two records, one bounded out. `records` must be 1, not 2: the second
  // produced no evidence, and counting it would be the bench reporting a
  // comparison it never made.
  const directory = await mkdtemp(join(tmpdir(), 'bench-incomplete-counted-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'corpus.json')
  await writeFile(corpusPath, JSON.stringify(corpus([
    RECORD,
    { id: 'big', raw: `{"n": "${'x'.repeat(400)}",}`, expected: { n: 1 } },
  ])))
  const outcome = await execFileAsync('node', [cli, '--corpus', corpusPath, '--json', '--strategies', 'scanner', '--max-raw-bytes', '64'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(outcome.code, 2)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.records, 1)
  assert.equal(report.summary.attempts, 1)
  assert.equal(report.summary.checked, 1)
})

test('an unreadable input still yields a report naming WHICH input was not read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-unreadable-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const outcome = await execFileAsync('node', [cli, '--corpus', join(directory, 'absent.json'), '--json'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(outcome.code, 2)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.status, 'incomplete')
  const finding = report.findings.find((entry) => entry.ruleId === 'corpus-unreadable')
  assert.equal(finding.location.file, 'absent.json')
  assert.equal(finding.evidence, 'ENOENT')
})

test('a directory given where a file was expected is reported, not crashed on', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-directory-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const outcome = await execFileAsync('node', [cli, '--corpus', directory, '--json'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(outcome.code, 2)
  assert.equal(JSON.parse(outcome.stdout).status, 'incomplete')
})

test('the library reports the same incompleteness without the command line', () => {
  const report = benchRepairs({
    corpusBytes: new TextEncoder().encode(JSON.stringify(corpus([]))),
  }).report
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'corpus-empty'))
})
