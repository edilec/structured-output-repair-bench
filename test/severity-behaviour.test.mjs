import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { INCOMPLETE_RULES, RULE_SEVERITY } from '../src/index.mjs'

/**
 * Severity, pinned behaviourally.
 *
 * A severity table asserted against the README and against a hand-written copy
 * in a test is three declarations agreeing with each other: one coordinated
 * edit satisfies all three, and 40 of 52 error rules survived exactly that flip
 * elsewhere in this catalog.
 *
 * So this file shares nothing with the table. It drives a real corpus through
 * the real command line and states the observable outcome as a literal: the
 * process exit code, and the severity word the scoreboard prints. An exit code
 * cannot be edited into agreement.
 *
 * The distinction this pins is the one the whole tool turns on:
 * `fidelity-violation` is an error and `repair-failed` is a warning. Swap them
 * and a bench either fails every hard corpus or passes a corrupting strategy.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')

const SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' }, note: { type: 'string' } } }
const corpus = (records, schema = SCHEMA) => ({ corpusVersion: '1', schema, records })

const SCENARIOS = [
  {
    rule: 'fidelity-violation', exit: 1, word: 'error',
    corpus: corpus([{ id: 'r', raw: '{"n": 1, "note": "x,}",}', expected: { n: 1, note: 'x,}' } }]),
    flags: ['--strategies', 'naive-regex'],
  },
  {
    rule: 'label-invalid', exit: 1, word: 'error',
    corpus: corpus([{ id: 'r', raw: '{"n": 1}', expected: { n: 'not a number' } }]),
    flags: ['--strategies', 'strict'],
  },
  {
    rule: 'strategy-below-floor', exit: 1, word: 'error',
    corpus: corpus([{ id: 'r', raw: 'not json', expected: { n: 1 } }]),
    flags: ['--strategies', 'strict', '--min-fidelity', '50'],
  },
  {
    rule: 'schema-violation', exit: 1, word: 'warning',
    // The run fails for a DIFFERENT reason -- the repair also changed the data
    // -- so the exit code cannot pin this rule and the printed word does.
    corpus: corpus([{ id: 'r', raw: '{"n": "two",}', expected: { n: 2 } }]),
    flags: ['--strategies', 'scanner'],
  },
  {
    rule: 'repair-failed', exit: 0, word: 'warning',
    corpus: corpus([{ id: 'r', raw: '{"n": 1,}', expected: { n: 1 } }]),
    flags: ['--strategies', 'strict,scanner'],
  },
  {
    rule: 'record-unrepaired', exit: 0, word: 'warning',
    corpus: corpus([{ id: 'r', raw: 'not json at all', expected: { n: 1 } }]),
    flags: ['--strategies', 'strict'],
  },
  {
    rule: 'corpus-empty', exit: 2, word: 'error',
    corpus: corpus([]),
    flags: [],
  },
  {
    rule: 'corpus-malformed', exit: 2, word: 'error',
    corpus: { corpusVersion: '2', schema: SCHEMA, records: [] },
    flags: [],
  },
  {
    rule: 'corpus-not-json', exit: 2, word: 'error',
    bytes: '{ this is not json',
    flags: [],
  },
  {
    rule: 'record-malformed', exit: 2, word: 'error',
    corpus: corpus([{ raw: '{}', expected: {} }]),
    flags: [],
  },
  {
    rule: 'record-unlabelled', exit: 2, word: 'error',
    corpus: corpus([{ id: 'r', raw: '{"n": 1}' }]),
    flags: [],
  },
  {
    rule: 'schema-unsupported', exit: 2, word: 'error',
    corpus: corpus([{ id: 'r', raw: '{"n": 1}', expected: { n: 1 } }], { type: 'object', patternProperties: {} }),
    flags: ['--strategies', 'strict'],
  },
  {
    rule: 'strategy-unknown', exit: 2, word: 'error',
    corpus: corpus([{ id: 'r', raw: '{"n": 1}', expected: { n: 1 } }]),
    flags: ['--strategies', 'no-such-strategy'],
  },
  {
    rule: 'pipelines-malformed', exit: 2, word: 'error',
    corpus: corpus([{ id: 'r', raw: '{"n": 1}', expected: { n: 1 } }]),
    pipelines: { pipelinesVersion: '1', strategies: [{ name: 'mine', steps: ['no-such-step'] }] },
    flags: ['--strategies', 'strict'],
  },
]

async function runScenario(directory, scenario) {
  const corpusPath = join(directory, `${scenario.rule}-corpus.json`)
  await writeFile(corpusPath, scenario.bytes ?? JSON.stringify(scenario.corpus))
  const argv = [cli, '--corpus', corpusPath, ...(scenario.flags ?? [])]
  if (scenario.pipelines !== undefined) {
    const pipelinesPath = join(directory, `${scenario.rule}-pipelines.json`)
    await writeFile(pipelinesPath, JSON.stringify(scenario.pipelines))
    argv.push('--pipelines', pipelinesPath)
  }
  return execFileAsync('node', argv).then((ok) => ({ code: 0, ...ok }), (error) => error)
}

test('every rule reaches the command line with the exit code and severity word it is meant to have', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-severity-'))
  after(() => rm(directory, { recursive: true, force: true }))

  for (const scenario of SCENARIOS) {
    const outcome = await runScenario(directory, scenario)
    assert.equal(outcome.code, scenario.exit, `${scenario.rule}: exit ${outcome.code}, expected ${scenario.exit}\n${outcome.stdout}`)
    const line = outcome.stdout.split('\n').find((candidate) => candidate.includes(` ${scenario.rule}  `))
    assert.ok(line !== undefined, `${scenario.rule}: no finding line in the scoreboard\n${outcome.stdout}`)
    assert.equal(line.trim().split(/\s+/)[0], scenario.word, `${scenario.rule}: printed the wrong severity word`)
  }
})

test('a corrupting strategy fails the run and a failing one does not, on the same corpus', async () => {
  // The single most important severity fact in this tool, stated as two exit
  // codes over one corpus: the strategy that FAILED is a measurement, and the
  // strategy that silently CHANGED the data is a defect.
  const directory = await mkdtemp(join(tmpdir(), 'bench-severity-pair-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'corpus.json')
  await writeFile(corpusPath, JSON.stringify(corpus([{ id: 'r', raw: '{"n": 1, "note": "x,}",}', expected: { n: 1, note: 'x,}' } }])))

  const failing = await execFileAsync('node', [cli, '--corpus', corpusPath, '--strategies', 'strict'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(failing.code, 0, 'a strategy that could not repair the record must not fail the run')

  const corrupting = await execFileAsync('node', [cli, '--corpus', corpusPath, '--strategies', 'naive-regex'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(corrupting.code, 1, 'a strategy that changed the record must fail the run')
})

test('a clean comparison exits 0', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-severity-pass-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'corpus.json')
  await writeFile(corpusPath, JSON.stringify(corpus([{ id: 'r', raw: '{"n": 1,}', expected: { n: 1 } }])))
  const outcome = await execFileAsync('node', [cli, '--corpus', corpusPath, '--strategies', 'scanner', '--json'])
    .then((ok) => ({ code: 0, ...ok }), (error) => error)
  assert.equal(outcome.code, 0)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
})

test('every declared rule has a scenario, so no rule is severity-pinned only by the table', () => {
  const covered = new Set(SCENARIOS.map((scenario) => scenario.rule))
  const uncovered = Object.keys(RULE_SEVERITY).filter((rule) => !covered.has(rule))
  // The rules left out are reached by a limit or an unreadable input;
  // `test/limits.test.mjs` and `test/incompleteness.test.mjs` drive those
  // through the same command line, and this list keeps the division honest.
  assert.deepEqual(uncovered.sort(), [
    'corpus-not-utf8',
    'corpus-too-deep',
    'corpus-too-large',
    'corpus-unreadable',
    'edit-budget-exceeded',
    'pipelines-not-json',
    'pipelines-not-utf8',
    'pipelines-too-deep',
    'pipelines-too-large',
    'pipelines-unreadable',
    'record-too-deep',
    'record-too-large',
    'step-budget-exceeded',
    'time-budget-exceeded',
    'too-many-records',
    'too-many-strategies',
  ])
})

test('every rule that makes a run incomplete is a rule the table knows', () => {
  for (const rule of INCOMPLETE_RULES) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, rule), `${rule} has no declared severity`)
  }
})

test('the table is frozen, so no caller can flip a severity at run time', () => {
  assert.ok(Object.isFrozen(RULE_SEVERITY))
  // Modules are strict mode, so the write throws rather than being ignored.
  assert.throws(() => { RULE_SEVERITY['fidelity-violation'] = 'warning' }, TypeError)
  assert.equal(RULE_SEVERITY['fidelity-violation'], 'error')
  for (const [rule, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'info', 'warning'].includes(severity), `${rule} has severity "${severity}"`)
  }
})
