import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * A rule id and its remedy have to move together.
 *
 * Splitting `step-budget-exceeded` and `record-too-deep` out of
 * `schema-unsupported` was done so a reader is not sent to fix a schema that is
 * fine. Half of that was landed: the rule id changed and the `suggestion` did
 * not, so the report said "step-budget-exceeded" and then advised "Express the
 * constraint with a modelled keyword" -- the exact advice the split exists to
 * stop, now under a rule id that contradicts it.
 *
 * Everything here is asserted through the real command line, on the emitted
 * finding, because a `ruleId -> suggestion` map in the tests is a second
 * declaration that a coordinated edit satisfies.
 *
 * The last case is the reason this is not "map everything to the budget
 * remedy": a schema keyword this validator genuinely does not model must still
 * be `schema-unsupported`, and must still advise rewriting the schema.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')

const BUDGET_REMEDY = 'Raise --max-steps deliberately, or shorten the corpus.'
const DEPTH_REMEDY = 'Raise --max-value-depth deliberately, or flatten the labelled value.'
const UNSUPPORTED_REMEDY =
  'Express the constraint with a modelled keyword, or accept that validity is unmeasured here.'

const directories = []

after(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
})

async function runCli(corpus, extraArguments = []) {
  const directory = await mkdtemp(join(tmpdir(), 'repair-bench-remedy-'))
  directories.push(directory)
  const corpusPath = join(directory, 'corpus.json')
  await writeFile(corpusPath, JSON.stringify(corpus), 'utf8')

  const argv = [cli, '--corpus', corpusPath, '--json', ...extraArguments]
  try {
    const { stdout } = await execFileAsync(process.execPath, argv)
    return { code: 0, report: JSON.parse(stdout) }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout) }
  }
}

function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

/** A label nested five levels deep, with a schema that follows it all the way down. */
const nest = (depth) => (depth === 0 ? 1 : { a: nest(depth - 1) })
const nestSchema = (depth) => (
  depth === 0
    ? { type: 'number' }
    : { type: 'object', properties: { a: nestSchema(depth - 1) } }
)

test('a spent step budget carries the budget remedy, not the rewrite-your-schema one', async () => {
  const corpus = {
    corpusVersion: '1',
    schema: { type: 'object', properties: { n: { type: 'number' } } },
    records: [
      { id: 'r1', raw: '{"n": 1}', expected: { n: 1 } },
      { id: 'r2', raw: '{"n": "oops"}', expected: { n: 'oops' } },
    ],
  }

  const starved = await runCli(corpus, ['--strategies', 'strict', '--max-steps', '4'])
  assert.equal(starved.code, 2)
  assert.equal(starved.report.status, 'incomplete')

  const budgeted = findingsFor(starved.report, 'step-budget-exceeded')
  assert.ok(budgeted.length > 0, 'the spent budget must be named under its own rule')
  for (const finding of budgeted) {
    assert.equal(
      finding.suggestion,
      BUDGET_REMEDY,
      `step-budget-exceeded at ${finding.location.pointer} advises: ${finding.suggestion}`,
    )
  }
  assert.equal(
    findingsFor(starved.report, 'schema-unsupported').length,
    0,
    'a spent budget is not an unsupported keyword',
  )
})

test('a spent step budget inside an ATTEMPT walk carries the budget remedy too', async () => {
  /*
   * A budget spent part-way through the run reaches the reporting site in
   * scoreAttempt rather than the label one, and that site had its own copy of
   * the unsupported-keyword advice.
   */
  const corpus = {
    corpusVersion: '1',
    schema: { type: 'object', properties: { n: { type: 'number' } } },
    records: [
      { id: 'r1', raw: '{"n": 1}', expected: { n: 1 } },
      { id: 'r2', raw: '{"n": "oops"}', expected: { n: 'oops' } },
    ],
  }

  const starved = await runCli(corpus, ['--strategies', 'strict', '--max-steps', '6'])
  assert.equal(starved.code, 2)

  const attemptScoped = findingsFor(starved.report, 'step-budget-exceeded')
    .filter((finding) => finding.location.pointer === '/records/1/strict')
  assert.ok(
    attemptScoped.length > 0,
    `no step-budget-exceeded finding at /records/1/strict\n${JSON.stringify(starved.report.findings, null, 2)}`,
  )
  for (const finding of attemptScoped) {
    assert.equal(finding.suggestion, BUDGET_REMEDY, `advises: ${finding.suggestion}`)
  }
})

test('a depth limit reached inside the validator carries the depth remedy', async () => {
  const label = { n: nest(4) }
  const corpus = {
    corpusVersion: '1',
    schema: { type: 'object', properties: { n: nestSchema(4) } },
    records: [{ id: 'deep-label', raw: '{"n": 1}', expected: label }],
  }

  const bounded = await runCli(corpus, ['--strategies', 'strict', '--max-value-depth', '3'])
  assert.equal(bounded.code, 2)

  const tooDeep = findingsFor(bounded.report, 'record-too-deep')
  assert.ok(
    tooDeep.some((finding) => finding.location.pointer.startsWith('/records/0/expected')),
    `the depth limit inside the label walk was not reported as record-too-deep\n${JSON.stringify(bounded.report.findings, null, 2)}`,
  )
  for (const finding of tooDeep) {
    assert.equal(finding.suggestion, DEPTH_REMEDY, `advises: ${finding.suggestion}`)
  }
})

test('a keyword this validator really does not model keeps the rewrite-your-schema remedy', async () => {
  /*
   * The anti-suppression half. A mapping that answered "Raise --max-steps" for
   * every non-mismatch problem would satisfy the three tests above and be
   * wrong here, where the schema genuinely is the thing to change.
   */
  const corpus = {
    corpusVersion: '1',
    schema: { type: 'object', properties: { n: { type: 'string', pattern: '^a+$' } } },
    records: [{ id: 'r1', raw: '{"n": "aaa"}', expected: { n: 'aaa' } }],
  }

  const run = await runCli(corpus, ['--strategies', 'strict'])
  assert.equal(run.code, 2)

  const unsupported = findingsFor(run.report, 'schema-unsupported')
  assert.ok(
    unsupported.length > 0,
    `an unmodelled keyword must still be schema-unsupported\n${JSON.stringify(run.report.findings, null, 2)}`,
  )
  for (const finding of unsupported) {
    assert.equal(finding.suggestion, UNSUPPORTED_REMEDY, `advises: ${finding.suggestion}`)
  }
  assert.equal(
    findingsFor(run.report, 'step-budget-exceeded').length,
    0,
    'no budget was spent, so no budget rule may be emitted',
  )
})
