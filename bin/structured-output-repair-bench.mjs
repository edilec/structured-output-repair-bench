#!/usr/bin/env node

import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { PRESET_NAMES, benchRepairsFromFiles, formatReport } from '../src/index.mjs'

const HELP = `structured-output-repair-bench

Run bounded JSON repair strategies over a labelled corpus of malformed model
responses, and measure four things per attempt: whether the repaired text
parses, whether it satisfies the declared schema, whether it is still the record
that was labelled, and how many edits it took.

Schema validity is not fidelity. A repair that parses and satisfies the schema
while no longer meaning what the model said is the one failure that looks like a
success downstream, so it is an error here -- and it is why the corpus carries a
label at all. A repair that simply failed is a warning: visible, counted, and
never folded into a success rate.

Latency is measured and reported on stderr. It is deliberately absent from
stdout: wall-clock milliseconds differ between runs by construction, and the
report has to be byte-identical for identical inputs so it can be diffed between
machines. Stdout carries a deterministic cost in work units instead.

Usage:
  structured-output-repair-bench --corpus FILE [--pipelines FILE] [options]

Options:
  --corpus FILE            Labelled corpus, as JSON (required)
  --pipelines FILE         Extra strategy definitions, as JSON (optional)
  --strategies a,b,c       Strategies to run, in this order
                           (default: ${PRESET_NAMES.join(',')})
  --min-fidelity N         Fail any strategy whose faithful share is under N
                           percent (0-100, default 0 = no floor)
  --json                   Emit the machine-readable report on stdout
  --max-bytes N            Maximum size of either input (default 4194304)
  --max-depth N            Maximum JSON nesting in either input (default 32)
  --max-records N          Maximum corpus records (default 1000)
  --max-strategies N       Maximum strategies in one run (default 32)
  --max-raw-bytes N        Maximum size of one raw response (default 65536)
  --max-value-depth N      Maximum nesting in one repaired value (default 24)
  --max-edits N            Maximum edits one attempt may apply (default 200)
  --max-steps N            Total repair and validation work budget (default 5000000)
  --max-millis N           Time budget in milliseconds (default 15000)
  -h, --help               Show this help

Every option is accepted once: a repeated flag is a configuration error, not a
silent last-wins. An unknown option is refused rather than ignored, because a
typo that falls back to a default turns a real failure into a green run.

A limit that is reached is reported by name and makes the run incomplete. What
exceeded it is refused whole -- a document-level limit refuses the document, an
attempt-level limit abandons that attempt rather than applying a repair halfway.
Nothing is truncated.

Exit codes:
  0  every strategy that repaired a record preserved its meaning
  1  a repair altered a record's meaning, or a strategy fell under --min-fidelity
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, unreadable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-bytes', 'maxBytes'],
  ['--max-depth', 'maxDepth'],
  ['--max-edits', 'maxEdits'],
  ['--max-millis', 'maxMillis'],
  ['--max-raw-bytes', 'maxRawBytes'],
  ['--max-records', 'maxRecords'],
  ['--max-steps', 'maxSteps'],
  ['--max-strategies', 'maxStrategies'],
  ['--max-value-depth', 'maxValueDepth'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { corpus: null, pipelines: null, strategies: undefined, minFidelityPercent: 0, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--corpus a --corpus b` benches a corpus nobody named.
   */
  const once = (flag) => {
    if (given.has(flag)) throw new Error(`Option "${flag}" was given more than once`)
    given.add(flag)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      once(argument)
      options.json = true
    } else if (argument === '--corpus' || argument === '--pipelines') {
      once(argument)
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`Option "${argument}" needs a file path`)
      options[argument.slice(2)] = value
      index += 1
    } else if (argument === '--strategies') {
      once(argument)
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('Option "--strategies" needs a comma-separated list of names')
      const names = value.split(',').map((name) => name.trim())
      if (names.length === 0 || names.some((name) => name === '')) throw new Error('Option "--strategies" needs non-empty names')
      options.strategies = names
      index += 1
    } else if (argument === '--min-fidelity') {
      once(argument)
      const raw = argv[index + 1]
      index += 1
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) > 100) throw new Error('Option "--min-fidelity" needs an integer percent between 0 and 100')
      options.minFidelityPercent = Number(raw)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = argv[index + 1]
      index += 1
      if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`Option "${argument}" needs a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else {
      throw new Error(`Unknown option "${argument}"`)
    }
  }

  if (options.corpus === null) throw new Error('--corpus is required')
  return options
}

/**
 * The label a finding carries.
 *
 * `location.file` is never an absolute host path: a report is an artifact
 * people paste into issues and diff between machines. A file inside the working
 * directory is named relative to it, and anything else by its base name alone.
 */
function sourceLabel(path) {
  const absolute = resolve(path)
  const fromHere = relative(process.cwd(), absolute)
  if (fromHere === '' || fromHere.startsWith('..') || isAbsolute(fromHere)) return absolute.split(/[\\/]/).pop()
  return fromHere.split('\\').join('/')
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let result
  try {
    result = await benchRepairsFromFiles({
      corpus: options.corpus,
      pipelines: options.pipelines,
      corpusSource: sourceLabel(options.corpus),
      pipelinesSource: options.pipelines === null ? undefined : sourceLabel(options.pipelines),
      strategies: options.strategies,
      minFidelityPercent: options.minFidelityPercent,
      limits: options.limits,
      // The wall clock the documented time budget and the latency measurement
      // are taken with. Wiring it here is the difference between a limit that
      // is enforced and one that is merely written down. Neither reading ever
      // reaches stdout.
      clock: () => performance.now(),
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const { report, latency } = result
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(result))

  const timings = Object.entries(latency)
    .map(([name, millis]) => `${name} ${millis.toFixed(3)}ms`)
    .join(', ')
  if (timings !== '') process.stderr.write(`latency: ${timings}\n`)

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.attempts} attempt(s) were scored and `
      + `${report.summary.unknown} question(s) went unanswered; this run is not a verdict.\n`,
    )
    return 2
  }
  process.stderr.write(
    `${report.summary.attempts} attempt(s) scored, ${report.summary.faithful} faithful, `
    + `${report.summary.altered} altered; status ${report.status}.\n`,
  )
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
