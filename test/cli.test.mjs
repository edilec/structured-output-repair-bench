import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * The command-line surface, including the two shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout is EMPTY
 * and the message goes to stderr. An input that could not be read means the run
 * had a subject and failed to obtain evidence about it, so stdout carries an
 * `incomplete` report naming which input. A consumer that pipes stdout has to
 * handle both, which is why both are pinned here.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'structured-output-repair-bench.mjs')
const examples = join(projectDirectory, 'examples')

const run = (argv, options = {}) => execFileAsync('node', [cli, ...argv], options)
  .then((ok) => ({ code: 0, ...ok }), (error) => error)

const good = ['--corpus', join(examples, 'corpus.json')]

test('--help prints the usage and exits 0', async () => {
  const outcome = await run(['--help'])
  assert.equal(outcome.code, 0)
  assert.match(outcome.stdout, /Usage:/)
  assert.match(outcome.stdout, /--corpus FILE/)
  assert.match(outcome.stdout, /Exit codes:/)
  assert.match(outcome.stdout, /Latency is measured and reported on stderr/)
})

test('the help text documents every flag the parser accepts', async () => {
  const { stdout } = await run(['--help'])
  for (const flag of [
    '--corpus', '--pipelines', '--strategies', '--min-fidelity', '--json',
    '--max-bytes', '--max-depth', '--max-records', '--max-strategies',
    '--max-raw-bytes', '--max-value-depth', '--max-edits', '--max-steps', '--max-millis', '--help',
  ]) {
    assert.ok(stdout.includes(flag), `${flag} is not documented`)
    if (flag === '--help') continue
    const outcome = await run([flag, '1'])
    assert.ok(!(outcome.stderr ?? '').includes(`Unknown option "${flag}"`), `${flag} is documented but not accepted`)
  }
})

test('the help text names every built-in strategy, and each one runs', async () => {
  const { stdout } = await run(['--help'])
  for (const name of ['strict', 'span', 'naive-regex', 'scanner']) {
    assert.ok(stdout.includes(name), `${name} is not named in the help`)
    const outcome = await run([...good, '--strategies', name, '--json'])
    const report = JSON.parse(outcome.stdout)
    assert.equal(report.strategies.length, 1)
    assert.equal(report.strategies[0].strategy, name)
  }
})

test('a clean comparison exits 0 and prints the scoreboard by default', async () => {
  const outcome = await run(good)
  assert.equal(outcome.code, 0)
  assert.match(outcome.stdout, /status pass/)
  assert.match(outcome.stdout, /strategy\s+attempted/)
  assert.throws(() => JSON.parse(outcome.stdout), 'the default output is the scoreboard, not JSON')
})

test('a configuration error writes nothing to stdout and exits 2', async () => {
  for (const argv of [
    [],
    ['--pipelines', join(examples, 'pipelines.json')],
    [...good, '--nonsense'],
    [...good, '--max-records'],
    [...good, '--max-records', 'lots'],
    [...good, '--max-records', '-1'],
    [...good, '--min-fidelity', '101'],
    [...good, '--min-fidelity', 'half'],
    [...good, '--strategies'],
    [...good, '--strategies', 'a,,b'],
    [...good, '--corpus', join(examples, 'corpus.json')],
    [...good, '--json', '--json'],
  ]) {
    const outcome = await run(argv)
    assert.equal(outcome.code, 2, `${argv.join(' ')}: exit ${outcome.code}`)
    assert.equal(outcome.stdout, '', `${argv.join(' ')}: stdout was not empty`)
    assert.ok(outcome.stderr.length > 0, `${argv.join(' ')}: no message on stderr`)
  }
})

test('a repeated flag is refused rather than silently last-wins', async () => {
  const outcome = await run([...good, '--corpus', join(examples, 'corpus-altered.json')])
  assert.equal(outcome.code, 2)
  assert.match(outcome.stderr, /given more than once/)
})

test('an unreadable input writes an incomplete REPORT to stdout and exits 2', async () => {
  const outcome = await run(['--corpus', join(examples, 'absent.json'), '--json'])
  assert.equal(outcome.code, 2)
  assert.notEqual(outcome.stdout, '')
  assert.equal(JSON.parse(outcome.stdout).status, 'incomplete')
})

test('location.file is relative to the working directory, never an absolute host path', async () => {
  const outcome = await run(['--corpus', 'examples/corpus-altered.json', '--json'], { cwd: projectDirectory })
  const report = JSON.parse(outcome.stdout)
  for (const finding of report.findings) {
    assert.ok(!finding.location.file.startsWith('/'))
    assert.ok(!finding.location.file.includes(projectDirectory))
  }
  assert.equal(report.findings[0].location.file, 'examples/corpus-altered.json')
})

test('an input outside the working directory is named by its base name alone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-label-'))
  after(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'elsewhere.json')
  await writeFile(corpusPath, JSON.stringify({
    corpusVersion: '1',
    schema: { type: 'object' },
    records: [{ id: 'r', raw: 'not json', expected: {} }],
  }))
  const outcome = await run(['--corpus', corpusPath, '--json'], { cwd: projectDirectory })
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.findings[0].location.file, 'elsewhere.json')
})

test('the shipped examples behave as the README says', async () => {
  const passing = await run([...good, '--json'])
  assert.equal(passing.code, 0)
  assert.equal(JSON.parse(passing.stdout).status, 'pass')

  const failing = await run(['--corpus', join(examples, 'corpus-altered.json'), '--json'])
  assert.equal(failing.code, 1)
  assert.equal(JSON.parse(failing.stdout).status, 'fail')

  const custom = await run([
    ...good, '--pipelines', join(examples, 'pipelines.json'),
    '--strategies', 'strict,span-then-close,commas-only-naive', '--json',
  ])
  assert.equal(custom.code, 0)
  const report = JSON.parse(custom.stdout)
  assert.deepEqual(report.strategies.map((score) => score.strategy), ['strict', 'span-then-close', 'commas-only-naive'])
})

test('--pipelines is optional, and omitting it leaves the presets available', async () => {
  const outcome = await run([...good, '--json'])
  const report = JSON.parse(outcome.stdout)
  assert.deepEqual(report.strategies.map((score) => score.strategy), ['strict', 'span', 'naive-regex', 'scanner'])
})
