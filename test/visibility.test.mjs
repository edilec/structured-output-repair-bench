import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { benchRepairs, formatReport } from '../src/index.mjs'

/**
 * Acceptance: unsuccessful repairs stay visible.
 *
 * "Visible" is asserted in four places at once, because a bench can hide a
 * failure in any one of them and still look honest in the others:
 *
 * 1. a finding naming the record and the strategy;
 * 2. that strategy's `failed` column;
 * 3. the summary totals, where `parsed + failed + abandoned` has to account for
 *    every attempt;
 * 4. the human scoreboard printed on stdout.
 *
 * The strongest of these is the third. A bench that dropped a failed attempt
 * would still print a plausible table; it could not keep the columns adding up.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

const SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } }

const HOPELESS = { id: 'refusal', raw: 'Sorry, I cannot produce JSON for that request.', expected: { n: 1 } }
const REPAIRABLE = { id: 'comma', raw: '{"n": 1,}', expected: { n: 1 } }

function bench(records, strategies = ['strict', 'scanner'], options = {}) {
  return benchRepairs({
    corpusBytes: encode({ corpusVersion: '1', schema: SCHEMA, records }),
    strategies,
    ...options,
  })
}

test('a repair that did not parse is reported, per record and per strategy', () => {
  const { report } = bench([HOPELESS], ['strict', 'span', 'naive-regex', 'scanner'])
  const failures = report.findings.filter((finding) => finding.ruleId === 'repair-failed')
  assert.equal(failures.length, 4, 'every strategy that failed must be named')
  assert.deepEqual(
    failures.map((finding) => finding.location.pointer).sort(),
    ['/records/0/naive-regex', '/records/0/scanner', '/records/0/span', '/records/0/strict'],
  )
  for (const finding of failures) assert.equal(finding.severity, 'warning')
})

test('the columns account for every attempt, so a dropped failure cannot balance', () => {
  const { report } = bench([HOPELESS, REPAIRABLE], ['strict', 'scanner'])
  assert.equal(report.summary.attempts, 4)
  for (const score of report.strategies) {
    assert.equal(
      score.parsed + score.failed + score.abandoned,
      score.attempted,
      `${score.strategy}: ${score.attempted} attempts do not add up`,
    )
    assert.equal(score.faithful + score.altered, score.parsed, `${score.strategy}: parsed attempts do not add up`)
  }
  assert.equal(report.summary.parsed + report.summary.failed + report.summary.abandoned, report.summary.attempts)
})

test('a failed repair is never counted as faithful, parsed or schema-valid', () => {
  const { report } = bench([HOPELESS], ['strict'])
  const score = report.strategies[0]
  assert.deepEqual(
    { attempted: score.attempted, parsed: score.parsed, schemaValid: score.schemaValid, faithful: score.faithful, failed: score.failed },
    { attempted: 1, parsed: 0, schemaValid: 0, faithful: 0, failed: 1 },
  )
})

test('a record no strategy could repair is rolled up as well as reported per attempt', () => {
  // Per-attempt findings say which strategies failed. The roll-up says the
  // record is out of reach of the whole selection, which is the fact a reader
  // choosing a strategy actually needs.
  const { report } = bench([HOPELESS, REPAIRABLE])
  const rollups = report.findings.filter((finding) => finding.ruleId === 'record-unrepaired')
  assert.equal(rollups.length, 1)
  assert.equal(rollups[0].location.pointer, '/records/0')
  assert.match(rollups[0].message, /No selected strategy repaired record "refusal"/)
})

test('a record one strategy repaired is not rolled up as unrepaired', () => {
  const { report } = bench([REPAIRABLE])
  assert.ok(!report.findings.some((finding) => finding.ruleId === 'record-unrepaired'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'repair-failed'), 'strict still failed, and still says so')
})

test('the human scoreboard prints the failed column for every strategy', () => {
  const result = bench([HOPELESS, REPAIRABLE])
  const text = formatReport(result)
  assert.match(text, /strategy\s+attempted\s+parsed\s+valid\s+faithful\s+altered\s+failed\s+edits/)
  const strict = text.split('\n').find((line) => line.trim().startsWith('strict'))
  assert.deepEqual(strict.trim().split(/\s+/), ['strict', '2', '0', '0', '0', '0', '2', '0'])
  const scanner = text.split('\n').find((line) => line.trim().startsWith('scanner'))
  assert.deepEqual(scanner.trim().split(/\s+/), ['scanner', '2', '1', '1', '1', '0', '1', '1'])
})

test('a failed repair never reproduces the response it failed on', () => {
  // The failure message carries a V8 parse diagnostic, and V8 quotes the input
  // back in one of its two message shapes. A bench that reports hundreds of
  // parse failures would otherwise print the corpus.
  const { report } = bench([{ id: 'secret', raw: 'AKIAIOSFODNN7EXAMPLE', expected: { n: 1 } }], ['strict'])
  const finding = report.findings.find((entry) => entry.ruleId === 'repair-failed')
  assert.ok(!finding.message.includes('AKIA'), `leaked: ${finding.message}`)
  assert.ok(!JSON.stringify(report).includes('AKIA'), 'the response reached the report')
})

test('a failure is a warning, so a hard corpus does not fail the run on difficulty alone', () => {
  // The bench's verdict is about corruption, not coverage: a strategy that
  // loses fairly is a measurement. The scoreboard is where difficulty is read.
  const { report } = bench([HOPELESS], ['strict', 'span', 'naive-regex', 'scanner'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 5)
  assert.equal(report.summary.failed, 4)
})

test('every failure survives the command line, on stdout and in the exit code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-visibility-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'corpus.json')
  await writeFile(corpusPath, JSON.stringify({ corpusVersion: '1', schema: SCHEMA, records: [HOPELESS, REPAIRABLE] }))

  const outcome = await execFileAsync('node', [cli, '--corpus', corpusPath, '--strategies', 'strict,scanner', '--json'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(outcome.code, 0)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.summary.failed, 3)
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'repair-failed').length, 3)

  const human = await execFileAsync('node', [cli, '--corpus', corpusPath, '--strategies', 'strict,scanner'])
  assert.match(human.stdout, /repair-failed/)
  assert.match(human.stdout, /record-unrepaired/)
})

test('a strategy that falls under an explicit fidelity floor fails the run', () => {
  // The floor is off by default: a bench is for comparing, not for gatekeeping.
  // When it is set, it has to bite.
  const off = bench([HOPELESS, REPAIRABLE], ['strict']).report
  assert.equal(off.status, 'pass')

  const { report } = bench([HOPELESS, REPAIRABLE], ['strict'], { minFidelityPercent: 50 })
  assert.equal(report.status, 'fail')
  const finding = report.findings.find((entry) => entry.ruleId === 'strategy-below-floor')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/strategies/strict')
  assert.match(finding.message, /repaired 0 of 2 record\(s\) faithfully, under the 50% floor/)
})

test('the columns still account for every attempt on the record-too-deep path', () => {
  /*
   * The identities above were asserted on a corpus that never reached this
   * branch, so they could not fail on the one path that broke them.
   *
   * `scoreAttempt` incremented `parsed` and then ran the `maxValueDepth` check,
   * which incremented `abandoned` as well. Measured: attempted 1, parsed 1,
   * abandoned 1, faithful 0, altered 0 -- so `parsed + failed + abandoned` was
   * 2 against 1 attempt, and `faithful + altered` was 0 against 1 parsed. The
   * verdict was right (incomplete, exit 2) and the scoreboard a reader is told
   * to trust did not add up.
   *
   * docs/measurement-model.md puts `record-too-deep` in the `abandoned` column
   * alone, so `parsed` counts attempts carried forward to scoring.
   */
  const deep = { id: 'deep', raw: '{"a": {"b": {"c": 1}}}', expected: { a: { b: { c: 1 } } } }
  const { report } = benchRepairs({
    corpusBytes: encode({ corpusVersion: '1', schema: { type: 'object' }, records: [deep] }),
    strategies: ['strict'],
    limits: { maxValueDepth: 2 },
  })

  assert.ok(
    report.findings.some((finding) => finding.ruleId === 'record-too-deep'),
    'the fixture no longer reaches the branch this test exists for',
  )
  for (const score of report.strategies) {
    assert.equal(
      score.parsed + score.failed + score.abandoned,
      score.attempted,
      `${score.strategy}: ${score.attempted} attempt(s) do not add up: ${JSON.stringify(score)}`,
    )
    assert.equal(score.faithful + score.altered, score.parsed, `${score.strategy}: parsed attempts do not add up: ${JSON.stringify(score)}`)
  }
  assert.equal(report.summary.parsed + report.summary.failed + report.summary.abandoned, report.summary.attempts)
  // And the same record inside the limit is scored normally, so the fix is not
  // "stop counting things".
  const within = benchRepairs({
    corpusBytes: encode({ corpusVersion: '1', schema: { type: 'object' }, records: [deep] }),
    strategies: ['strict'],
  }).report
  assert.equal(within.status, 'pass')
  assert.deepEqual(
    { parsed: within.strategies[0].parsed, faithful: within.strategies[0].faithful, abandoned: within.strategies[0].abandoned },
    { parsed: 1, faithful: 1, abandoned: 0 },
  )
})

test('an attempt the step budget never validated is not counted as schema-valid', () => {
  /*
   * `walk` short-circuits once `budget.spent` is set, so every validation after
   * the budget runs out returns an empty list -- and "no problems" is then
   * indistinguishable from "never asked". Measured with `--max-steps 4`:
   * `schemaValid` rose to 2 of 2, the higher number, and the record it counted
   * holds {"n": "oops"} against {"n": {"type": "number"}}. The only finding was
   * about the label, and said nothing about the attempt.
   */
  const records = [
    { id: 'r1', raw: '{"n": 1}', expected: { n: 1 } },
    { id: 'r2', raw: '{"n": "oops"}', expected: { n: 'oops' } },
  ]
  const schema = { type: 'object', properties: { n: { type: 'number' } } }
  const run = (limits) => benchRepairs({
    corpusBytes: encode({ corpusVersion: '1', schema, records }),
    strategies: ['strict'],
    limits,
  }).report

  // With a full budget the second record really is invalid, and is named.
  const full = run(undefined)
  assert.equal(full.status, 'fail')
  assert.equal(full.strategies[0].schemaValid, 1)
  assert.ok(full.findings.some((finding) => finding.ruleId === 'schema-violation'))

  const starved = run({ maxSteps: 4 })
  assert.equal(starved.status, 'incomplete')
  assert.ok(
    starved.strategies[0].schemaValid <= full.strategies[0].schemaValid,
    `starving the budget RAISED schemaValid to ${starved.strategies[0].schemaValid}: ${JSON.stringify(starved.strategies[0])}`,
  )
  const named = starved.findings.filter((finding) => finding.ruleId === 'step-budget-exceeded')
  assert.ok(
    named.some((finding) => finding.location.pointer === '/records/1/strict'),
    `no finding names the attempt that was not validated\n${JSON.stringify(starved.findings, null, 2)}`,
  )
})
