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
 * Acceptance: a syntactically repaired but semantically altered record fails
 * fidelity.
 *
 * The case that matters is the one where everything else looks fine. The
 * repaired text parses. It satisfies the declared schema. A tool that measured
 * only those two would call it a success -- and it is the one failure that a
 * downstream consumer cannot see, because what it receives is a well-formed
 * record that no longer says what the model said.
 *
 * So each case below asserts all four facts together: parsed, schema-valid,
 * NOT faithful, and an `error` that fails the run. Asserting only the finding
 * would pass even if the attempt had been quietly counted as faithful.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

const SCHEMA = {
  type: 'object',
  required: ['n', 'note'],
  properties: { n: { type: 'number' }, note: { type: 'string' } },
  additionalProperties: false,
}

function bench(records, strategies, schema = SCHEMA) {
  return benchRepairs({
    corpusBytes: encode({ corpusVersion: '1', schema, records }),
    strategies,
  }).report
}

function scoreFor(report, name) {
  return report.strategies.find((entry) => entry.strategy === name)
}

/**
 * The record the whole bench is built around: a trailing comma INSIDE a string.
 * A string-unaware regular expression deletes it, and the result parses.
 */
const COMMA_IN_STRING = {
  id: 'comma-inside-a-string',
  raw: '{"note": "totals: 1,}", "n": 1,}',
  expected: { note: 'totals: 1,}', n: 1 },
}

test('a repair that parses and satisfies the schema but changed the data fails fidelity', () => {
  const report = bench([COMMA_IN_STRING], ['naive-regex'])
  const score = scoreFor(report, 'naive-regex')

  assert.equal(score.parsed, 1, 'the premise is a repair that PARSES')
  assert.equal(score.schemaValid, 1, 'the premise is a repair the schema ACCEPTS')
  assert.equal(score.faithful, 0, 'a record whose meaning changed is not faithful')
  assert.equal(score.altered, 1)
  assert.equal(score.failed, 0, 'this repair did not fail; that is what makes it dangerous')

  assert.equal(report.status, 'fail')
  const finding = report.findings.find((entry) => entry.ruleId === 'fidelity-violation')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/records/0/naive-regex/note')
  assert.equal(finding.evidence, 'labelled "totals: 1,}", repaired to "totals: 1}"')
  assert.match(finding.message, /schema-valid repair/)
})

test('the string-aware strategy repairs the same record faithfully', () => {
  // Without this the case above could be satisfied by a bench that calls every
  // repair unfaithful.
  const report = bench([COMMA_IN_STRING], ['scanner'])
  const score = scoreFor(report, 'scanner')
  assert.equal(score.faithful, 1)
  assert.equal(score.altered, 0)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
})

test('the two strategies are measured side by side in one run', () => {
  const report = bench([COMMA_IN_STRING], ['naive-regex', 'scanner'])
  assert.equal(scoreFor(report, 'naive-regex').altered, 1)
  assert.equal(scoreFor(report, 'scanner').faithful, 1)
  assert.equal(report.summary.altered, 1)
  assert.equal(report.summary.faithful, 1)
  assert.equal(report.status, 'fail', 'one strategy altering a record fails the run even when another did not')
})

test('fidelity is checked field by field, and names the field that changed', () => {
  const cases = [
    // A truncated value closed at the wrong place: parses, wrong string.
    [{ id: 'cut', raw: '{"n": 1, "note": "EUR', expected: { n: 1, note: 'EURO' } }, '/records/0/scanner/note', 'labelled "EURO", repaired to "EUR"'],
    // A number that came back as a different number.
    [{ id: 'num', raw: '{"n": 2, "note": "x",}', expected: { n: 1, note: 'x' } }, '/records/0/scanner/n', 'labelled 1, repaired to 2'],
    // A property the label does not have at all.
    [{ id: 'extra', raw: '{"n": 1, "note": "x", "z": 3,}', expected: { n: 1, note: 'x' } }, '/records/0/scanner/z', 'labelled undefined, repaired to 3'],
  ]
  for (const [entry, pointer, evidence] of cases) {
    const report = bench([entry], ['scanner'])
    const finding = report.findings.find((candidate) => candidate.ruleId === 'fidelity-violation')
    assert.ok(finding !== undefined, `${entry.id}: no fidelity violation reported`)
    assert.equal(finding.location.pointer, pointer, entry.id)
    assert.equal(finding.evidence, evidence, entry.id)
  }
})

test('a repair that is faithful but schema-invalid is not a fidelity violation', () => {
  // The two measurements are independent. Here the corpus schema is wrong about
  // the record, not the repair: the label itself is refused, and the repair
  // matches the label exactly.
  const narrow = { type: 'object', required: ['n', 'note'], properties: { n: { type: 'string' }, note: { type: 'string' } } }
  const report = bench([{ id: 'ok', raw: '{"n": 1, "note": "x",}', expected: { n: 1, note: 'x' } }], ['scanner'], narrow)
  assert.equal(scoreFor(report, 'scanner').faithful, 1)
  assert.equal(scoreFor(report, 'scanner').schemaValid, 0)
  assert.ok(!report.findings.some((finding) => finding.ruleId === 'fidelity-violation'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'schema-violation'))
  // And the corpus's own label is reported as contradicting its own schema.
  assert.ok(report.findings.some((finding) => finding.ruleId === 'label-invalid'))
})

test('a record with no label is not scored, and never counted as faithful', () => {
  // Fidelity is measured against the label. With nothing to compare against,
  // reporting the attempt as faithful would be inventing the evidence.
  const report = benchRepairs({
    corpusBytes: encode({ corpusVersion: '1', schema: SCHEMA, records: [{ id: 'bare', raw: '{"n": 1, "note": "x"}' }] }),
    strategies: ['scanner'],
  }).report
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.faithful, 0)
  assert.equal(report.summary.attempts, 0)
  const finding = report.findings.find((entry) => entry.ruleId === 'record-unlabelled')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /fidelity could not be measured/)
})

test('the shipped altered corpus exits 1 through the command line', async () => {
  const outcome = await execFileAsync('node', [cli, '--corpus', join(projectDirectory, 'examples', 'corpus-altered.json'), '--json'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(outcome.code, 1)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.status, 'fail')
  const violations = report.findings.filter((finding) => finding.ruleId === 'fidelity-violation')
  assert.ok(violations.length >= 1)
  assert.ok(violations.some((finding) => finding.location.pointer === '/records/0/naive-regex/note'))
})

test('a corpus whose repairs all preserve meaning exits 0, warnings and all', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-fidelity-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'corpus.json')
  await writeFile(corpusPath, JSON.stringify({
    corpusVersion: '1',
    schema: SCHEMA,
    records: [COMMA_IN_STRING],
  }))
  const outcome = await execFileAsync('node', [cli, '--corpus', corpusPath, '--strategies', 'strict,scanner', '--json'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(outcome.code, 0)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.status, 'pass')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'repair-failed'), 'strict still fails visibly')
})
