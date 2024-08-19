/**
 * structured-output-repair-bench
 *
 * Runs a set of bounded JSON repair strategies over a labelled corpus of
 * malformed model responses, and measures four things per attempt: whether the
 * repaired text parses, whether it satisfies the declared schema, whether it is
 * still the record that was labelled, and how many edits it took. Nothing is
 * fetched, nothing is executed, and nothing is written.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **Schema validity is not fidelity.** A repair that produces text which
 *    parses and satisfies the schema, while no longer meaning what the model
 *    said, is the most dangerous thing a repair strategy can do -- it is the
 *    only failure that looks like a success downstream. It is an `error` here,
 *    and it is the reason the corpus is labelled at all.
 *
 * 2. **Unsuccessful repairs stay visible.** A record a strategy could not
 *    repair produces a finding, is counted in that strategy's `failed` column,
 *    and is never folded into a success rate. A strategy that fails loudly is a
 *    strategy you can choose against; a strategy whose failures vanish is not.
 *
 * 3. **An unlabelled record is not a passing record.** Fidelity is measured
 *    against the label. A record with no `expected` is reported as a question
 *    the run could not answer, and makes the whole run `incomplete`.
 *
 * 4. **Latency is measured but never printed to stdout.** Wall-clock
 *    milliseconds differ between runs by construction, and the report must be
 *    byte-identical for identical inputs so it can be diffed between machines.
 *    So stdout carries a deterministic cost in work units and stderr carries
 *    the measured milliseconds.
 */

import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import { DEFAULT_LIMITS, isRecord, measureDepth, readJsonDocument, validateLimits } from './document.mjs'
import { readCorpus, readPipelines } from './corpus.mjs'
import { PRESETS, PRESET_NAMES, runPipeline } from './repair.mjs'
import { firstDifference, validateAgainstSchema } from './schema.mjs'
import { EXCERPT_LIMIT, LABEL_LIMIT, MESSAGE_LIMIT, byCodeUnit, parseFailureDetail, renderValue, reportPointer, sanitize } from './text.mjs'

export const TOOL_ID = 'structured-output-repair-bench'
export const REPORT_SCHEMA_VERSION = '1'

const DEFAULT_CORPUS_SOURCE = 'corpus.json'
const DEFAULT_PIPELINES_SOURCE = 'pipelines.json'

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a run fails, so it lives in exactly one place and
 * every finding takes its severity from here. An id the table does not know
 * throws rather than defaulting.
 *
 * This table is the source of truth; it is not the guard. Asserting it against
 * the README and against a hand-written copy in a test is three declarations
 * agreeing with each other, and one coordinated edit satisfies all three.
 * `test/severity-behaviour.test.mjs` shares nothing with any of them: it drives
 * each rule through the real command line and states the exit code and the
 * printed severity word as literals.
 *
 * The policy encoded here: a repair that silently changed the data is an
 * `error`, because that is the defect the bench exists to find. A repair that
 * failed, or produced something the schema rejects, is a `warning` -- it is a
 * measurement, visible and counted, and a bench whose corpus is hard on purpose
 * should not fail because a strategy lost fairly. Everything the bench could
 * not evaluate is an `error` and additionally makes the run incomplete.
 */
export const RULE_SEVERITY = Object.freeze({
  'corpus-empty': 'error',
  'corpus-malformed': 'error',
  'corpus-not-json': 'error',
  'corpus-not-utf8': 'error',
  'corpus-too-deep': 'error',
  'corpus-too-large': 'error',
  'corpus-unreadable': 'error',
  'edit-budget-exceeded': 'error',
  'fidelity-violation': 'error',
  'label-invalid': 'error',
  'pipelines-malformed': 'error',
  'pipelines-not-json': 'error',
  'pipelines-not-utf8': 'error',
  'pipelines-too-deep': 'error',
  'pipelines-too-large': 'error',
  'pipelines-unreadable': 'error',
  'record-malformed': 'error',
  'record-too-deep': 'error',
  'record-too-large': 'error',
  'record-unlabelled': 'error',
  'record-unrepaired': 'warning',
  'repair-failed': 'warning',
  'schema-unsupported': 'error',
  'schema-violation': 'warning',
  'step-budget-exceeded': 'error',
  'strategy-below-floor': 'error',
  'strategy-unknown': 'error',
  'time-budget-exceeded': 'error',
  'too-many-records': 'error',
  'too-many-strategies': 'error',
})

/**
 * The rules that mean a question went unanswered.
 *
 * Membership here is what turns a run `incomplete` and makes the command line
 * exit 2 rather than 1. Every rule in this list is also `error` severity, so
 * the exit code changes from 2 to 1 the moment a rule is dropped from it --
 * which is what `test/incompleteness.test.mjs` asserts, rule by rule, through
 * the real command line.
 *
 * `fidelity-violation`, `label-invalid` and `strategy-below-floor` are
 * deliberately NOT here. Each is something the bench measured and knows.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'corpus-empty',
  'corpus-malformed',
  'corpus-not-json',
  'corpus-not-utf8',
  'corpus-too-deep',
  'corpus-too-large',
  'corpus-unreadable',
  'edit-budget-exceeded',
  'pipelines-malformed',
  'pipelines-not-json',
  'pipelines-not-utf8',
  'pipelines-too-deep',
  'pipelines-too-large',
  'pipelines-unreadable',
  'record-malformed',
  'record-too-deep',
  'record-too-large',
  'record-unlabelled',
  'schema-unsupported',
  'step-budget-exceeded',
  'strategy-unknown',
  'time-budget-exceeded',
  'too-many-records',
  'too-many-strategies',
])

const INCOMPLETE = new Set(INCOMPLETE_RULES)
const ALLOWED_OPTIONS = Object.freeze([
  'clock', 'corpusBytes', 'corpusSource', 'limits', 'minFidelityPercent',
  'pipelinesBytes', 'pipelinesSource', 'strategies',
])

/* -------------------------------------------------------------------------- */

function createCollector() {
  return { rows: [], seen: new Set(), incomplete: false }
}

/**
 * Add one finding.
 *
 * The deduplication key is built from the row as it arrived, BEFORE sanitising.
 * Sanitising is lossy on purpose -- two record ids differing only in a bidi
 * control render identically -- so keying on the rendered finding would let one
 * real position delete another and understate the counts.
 */
function record(collector, row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) throw new TypeError(`No severity is declared for rule "${row.ruleId}"`)
  if (INCOMPLETE.has(row.ruleId)) collector.incomplete = true
  const key = JSON.stringify([row.ruleId, row.file, row.parts, row.message, row.evidence ?? null])
  if (collector.seen.has(key)) return
  collector.seen.add(key)
  collector.rows.push({
    ruleId: row.ruleId,
    severity,
    message: sanitize(row.message, MESSAGE_LIMIT),
    file: sanitize(row.file, LABEL_LIMIT),
    position: row.position ?? -1,
    pointer: reportPointer(row.parts ?? []),
    evidence: row.evidence === undefined || row.evidence === null ? null : sanitize(row.evidence, EXCERPT_LIMIT),
    suggestion: row.suggestion === undefined || row.suggestion === null ? null : sanitize(row.suggestion, MESSAGE_LIMIT),
    order: collector.rows.length,
  })
}

/**
 * The documented sort key: `(location.file, record position, location.pointer,
 * ruleId, declaration order)`.
 *
 * `position` is the index of the record a finding is about, and `-1` for a
 * finding about a document or a strategy as a whole. It is carried separately
 * rather than read back out of the pointer because a pointer is text: comparing
 * `/records/10` with `/records/2` by code unit puts record ten before record
 * two, and a report read alongside a corpus should follow the corpus.
 *
 * Every string comparison here is by code unit. `localeCompare` and
 * `Intl.Collator` consult ICU data that differs between Node builds, so two
 * correct machines would disagree about the order of one scoreboard.
 */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.file, right.file)
    || (left.position - right.position)
    || byCodeUnit(left.pointer, right.pointer)
    || byCodeUnit(left.ruleId, right.ruleId)
    || (left.order - right.order)
}

function defaultClock() {
  return performance.now()
}

/* -------------------------------------------------------------------------- */

function readInput(bytes, limits, prefix, source, collector) {
  const document = readJsonDocument(bytes, limits)
  if (document.ok) return document.document
  record(collector, {
    ruleId: `${prefix}-${document.rule}`,
    file: source,
    parts: [],
    message: document.message,
    suggestion: document.suggestion,
  })
  return null
}

/**
 * Resolve the strategies to run, in the order the caller asked for them.
 *
 * The order is the caller's and is never sorted. A scoreboard is read top to
 * bottom against the order the reader chose, and re-sorting it would silently
 * answer a different question from the one that was asked.
 */
function selectStrategies(selection, defined, limits, collector, pipelinesSource) {
  const custom = new Map(defined.map((entry) => [entry.name, entry.steps]))
  const chosen = []
  for (const name of selection) {
    if (Object.hasOwn(PRESETS, name)) {
      chosen.push({ name, steps: [...PRESETS[name]] })
      continue
    }
    if (custom.has(name)) {
      chosen.push({ name, steps: [...custom.get(name)] })
      continue
    }
    record(collector, {
      ruleId: 'strategy-unknown',
      file: pipelinesSource,
      parts: ['strategies'],
      message: `No strategy named ${renderValue(name, 60)} is built in or defined, so it was not measured.`,
      evidence: `built in: ${PRESET_NAMES.join(', ')}`,
      suggestion: 'Name a built-in preset, or define the strategy in the --pipelines document.',
    })
  }
  if (chosen.length > limits.maxStrategies) {
    record(collector, {
      ruleId: 'too-many-strategies',
      file: pipelinesSource,
      parts: ['strategies'],
      message: `${chosen.length} strategies were selected, over the maxStrategies limit of ${limits.maxStrategies}; none were run.`,
      suggestion: 'Raise --max-strategies deliberately, or select fewer strategies.',
    })
    return []
  }
  return chosen
}

/* -------------------------------------------------------------------------- */

/**
 * Run the bench over a corpus supplied as bytes.
 *
 * Configuration errors -- an unknown option, an unknown limit, a fidelity floor
 * outside 0-100 -- throw. They mean the run never had a subject, so there is
 * nothing to report about, and the command line turns them into exit 2 with an
 * empty stdout. Everything that is a fact about an input becomes a finding.
 */
export function benchRepairs(input = {}) {
  if (!isRecord(input)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(input)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${String(key).slice(0, 60)}"`)
  }
  const limits = validateLimits(input.limits)
  const corpusSource = sanitize(input.corpusSource ?? DEFAULT_CORPUS_SOURCE, LABEL_LIMIT) || DEFAULT_CORPUS_SOURCE
  const pipelinesSource = sanitize(input.pipelinesSource ?? DEFAULT_PIPELINES_SOURCE, LABEL_LIMIT) || DEFAULT_PIPELINES_SOURCE
  const clock = input.clock ?? defaultClock
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')
  const minFidelityPercent = input.minFidelityPercent ?? 0
  if (!Number.isInteger(minFidelityPercent) || minFidelityPercent < 0 || minFidelityPercent > 100) {
    throw new TypeError('minFidelityPercent must be an integer between 0 and 100')
  }
  const selection = input.strategies ?? [...PRESET_NAMES]
  if (!Array.isArray(selection) || selection.some((name) => typeof name !== 'string' || name === '')) {
    throw new TypeError('strategies must be an array of non-empty names')
  }

  const started = clock()
  if (typeof started !== 'number' || !Number.isFinite(started)) {
    throw new TypeError('clock must return a finite number of milliseconds')
  }
  const deadline = { exceeded: () => clock() - started >= limits.maxMillis }

  const collector = createCollector()
  const state = { records: 0, attempts: 0, checked: 0 }
  const budget = { steps: 0, spent: false }
  const latency = {}

  let pipelineDefinitions = []
  if (input.pipelinesBytes !== undefined && input.pipelinesBytes !== null) {
    const document = readInput(input.pipelinesBytes, limits, 'pipelines', pipelinesSource, collector)
    if (document !== null) {
      const parsed = readPipelines(document)
      for (const problem of parsed.faults) {
        record(collector, {
          ruleId: 'pipelines-malformed',
          file: pipelinesSource,
          parts: problem.parts,
          message: problem.message,
          suggestion: problem.suggestion,
        })
      }
      pipelineDefinitions = parsed.strategies
    }
  }

  const corpusDocument = readInput(input.corpusBytes, limits, 'corpus', corpusSource, collector)
  if (corpusDocument === null) return finish(collector, state, [], latency, corpusSource)

  const corpus = readCorpus(corpusDocument, limits)
  for (const problem of corpus.envelopeFaults) {
    record(collector, {
      ruleId: corpus.overRecordLimit === true ? 'too-many-records' : 'corpus-malformed',
      file: corpusSource,
      parts: problem.parts,
      message: problem.message,
      suggestion: problem.suggestion,
    })
  }
  for (const problem of corpus.recordFaults) {
    record(collector, {
      ruleId: 'record-malformed',
      file: corpusSource,
      position: problem.index,
      parts: problem.parts,
      message: problem.message,
      suggestion: problem.suggestion,
    })
  }
  for (const problem of corpus.unlabelled) {
    record(collector, {
      ruleId: 'record-unlabelled',
      file: corpusSource,
      position: problem.index,
      parts: [...problem.parts, 'expected'],
      message: `Record "${sanitize(problem.id, 60)}" carries no "expected" label, so its fidelity could not be measured and it was not scored.`,
      suggestion: 'Label the record with the value a correct repair must produce, or remove it from the corpus.',
    })
  }
  if (corpus.envelopeFaults.length > 0) return finish(collector, state, [], latency, corpusSource)

  const strategies = selectStrategies(selection, pipelineDefinitions, limits, collector, pipelinesSource)
  if (strategies.length === 0) return finish(collector, state, [], latency, corpusSource)

  const scores = strategies.map((strategy) => ({
    strategy: sanitize(strategy.name, LABEL_LIMIT),
    steps: strategy.steps.map((step) => sanitize(step, LABEL_LIMIT)),
    attempted: 0,
    parsed: 0,
    schemaValid: 0,
    faithful: 0,
    altered: 0,
    failed: 0,
    abandoned: 0,
    edits: 0,
    cost: 0,
  }))
  for (const score of scores) latency[score.strategy] = 0

  runCorpus({ collector, corpus, strategies, scores, limits, state, budget, deadline, clock, latency, corpusSource })

  if (minFidelityPercent > 0) {
    for (const score of scores) {
      if (score.attempted === 0) continue
      if (score.faithful * 100 >= minFidelityPercent * score.attempted) continue
      record(collector, {
        ruleId: 'strategy-below-floor',
        file: corpusSource,
        parts: ['strategies', score.strategy],
        message: `Strategy "${score.strategy}" repaired ${score.faithful} of ${score.attempted} record(s) faithfully, under the ${minFidelityPercent}% floor.`,
        suggestion: 'Lower --min-fidelity deliberately, improve the strategy, or drop it from the selection.',
      })
    }
  }

  return finish(collector, state, scores, latency, corpusSource)
}

/* -------------------------------------------------------------------------- */

function runCorpus(context) {
  const { collector, corpus, strategies, scores, limits, state, budget, deadline, corpusSource } = context
  let lastScored = null

  for (const entry of corpus.records) {
    if (deadline.exceeded()) {
      record(collector, {
        ruleId: 'time-budget-exceeded',
        file: corpusSource,
        position: entry.index,
        parts: entry.parts,
        message: `The bench passed the maxMillis budget of ${limits.maxMillis} before this record; the records from here on were not scored.`,
        suggestion: 'Raise --max-millis deliberately, or shorten the corpus.',
      })
      return
    }
    const rawBytes = Buffer.byteLength(entry.raw, 'utf8')
    if (rawBytes > limits.maxRawBytes) {
      record(collector, {
        ruleId: 'record-too-large',
        file: corpusSource,
        position: entry.index,
        parts: [...entry.parts, 'raw'],
        message: `Record "${sanitize(entry.id, 60)}" holds ${rawBytes} bytes of raw response, over the maxRawBytes limit of ${limits.maxRawBytes}; it was not scored.`,
        suggestion: 'Raise --max-raw-bytes deliberately, or shorten the record.',
      })
      continue
    }

    state.records += 1
    lastScored = entry
    const labelProblems = validateAgainstSchema(entry.expected, corpus.schema, limits, budget)
    reportLabelProblems(collector, labelProblems, entry, corpusSource)

    let repairedFaithfully = false
    for (let index = 0; index < strategies.length; index += 1) {
      const outcome = scoreAttempt({ ...context, entry, strategy: strategies[index], score: scores[index] })
      if (outcome === 'faithful') repairedFaithfully = true
    }
    if (!repairedFaithfully) {
      record(collector, {
        ruleId: 'record-unrepaired',
        file: corpusSource,
        position: entry.index,
        parts: entry.parts,
        message: `No selected strategy repaired record "${sanitize(entry.id, 60)}" back to its label.`,
        suggestion: 'Add a strategy that handles this shape, or accept the record as out of reach and say so.',
      })
    }
  }

  /*
   * The budget, sampled once more after the loop.
   *
   * The check at the top of the loop only ever asks "had the budget run out
   * before this record?", so it cannot see a budget blown DURING the last
   * record -- there is no next iteration to ask in. Measured: one record at the
   * documented-legal maxRawBytes, `--max-millis 1`, twelve seconds of wall
   * clock, and a report saying `pass` with no findings. A limit is not enforced
   * if the only run that can exceed it is the run that never gets checked.
   */
  if (lastScored !== null && deadline.exceeded()) {
    record(collector, {
      ruleId: 'time-budget-exceeded',
      file: corpusSource,
      position: lastScored.index,
      parts: lastScored.parts,
      message: `The bench passed the maxMillis budget of ${limits.maxMillis} while scoring this record; a run that overran its budget is not a measurement to compare another run against.`,
      suggestion: 'Raise --max-millis deliberately, or shorten the corpus.',
    })
  }
}

function reportLabelProblems(collector, problems, entry, corpusSource) {
  for (const problem of problems) {
    record(collector, {
      ruleId: problem.kind === 'mismatch' ? 'label-invalid' : 'schema-unsupported',
      file: corpusSource,
      position: entry.index,
      parts: [...entry.parts, 'expected', ...problem.path],
      message: `The LABEL of record "${sanitize(entry.id, 60)}" ${problem.kind === 'mismatch' ? 'contradicts the corpus schema' : 'could not be checked'}: ${problem.message}`,
      suggestion: problem.kind === 'mismatch'
        ? 'Correct the label or the schema; a bench cannot measure validity against a contradiction.'
        : 'Express the constraint with a modelled keyword, or accept that validity is unmeasured here.',
    })
  }
}

/* -------------------------------------------------------------------------- */

function scoreAttempt(context) {
  const { collector, corpus, entry, strategy, score, limits, state, budget, clock, latency, corpusSource } = context
  const parts = [...entry.parts, strategy.name]
  score.attempted += 1
  state.attempts += 1

  const meter = { steps: budget.steps }
  const openedAt = clock()
  const repaired = runPipeline(strategy.steps, entry.raw, limits, meter)
  const closedAt = clock()
  score.cost += meter.steps - budget.steps
  budget.steps = meter.steps
  latency[score.strategy] += Math.max(0, closedAt - openedAt)

  if (!repaired.ok) {
    score.abandoned += 1
    record(collector, {
      ruleId: repaired.reason === 'edit-budget' ? 'edit-budget-exceeded' : 'step-budget-exceeded',
      file: corpusSource,
      position: entry.index,
      parts,
      message: repaired.reason === 'edit-budget'
        ? `Strategy "${score.strategy}" needed more than the maxEdits limit of ${limits.maxEdits} on record "${sanitize(entry.id, 60)}"; the attempt was abandoned, not partly applied.`
        : `Strategy "${score.strategy}" passed the maxSteps budget of ${limits.maxSteps} on record "${sanitize(entry.id, 60)}"; the attempt was abandoned.`,
      evidence: `abandoned at step "${sanitize(repaired.step, 40)}"`,
      suggestion: 'Raise the limit deliberately, or accept that this strategy is out of budget for this record.',
    })
    return 'abandoned'
  }
  score.edits += repaired.edits

  let parsed
  try {
    parsed = JSON.parse(repaired.text)
  } catch (error) {
    score.failed += 1
    state.checked += 1
    record(collector, {
      ruleId: 'repair-failed',
      file: corpusSource,
      position: entry.index,
      parts,
      // The detail never reproduces the record; see parseFailureDetail.
      message: `Strategy "${score.strategy}" did not make record "${sanitize(entry.id, 60)}" parse: ${parseFailureDetail(error)}.`,
      evidence: `${repaired.edits} edit(s) applied`,
      suggestion: 'This is a measurement, not a defect: it is what this strategy costs on this shape.',
    })
    return 'failed'
  }

  /*
   * The depth gate comes BEFORE `parsed` is counted, and that ordering is the
   * whole point.
   *
   * The documented model puts `record-too-deep` in the `abandoned` column
   * alone, and states two identities a reader is told to trust:
   * `parsed + failed + abandoned == attempted` and
   * `faithful + altered == parsed`. Counting this attempt as parsed AND
   * abandoned broke both -- measured as attempted 1, parsed 1, abandoned 1,
   * faithful 0, altered 0 -- so the scoreboard printed a strategy whose columns
   * did not add up. `parsed` therefore means "parsed and carried forward to
   * scoring"; that the text itself parsed is what the `record-too-deep` finding
   * says, naming the record and the strategy.
   */
  const depth = measureDepth(parsed, limits.maxValueDepth)
  if (depth > limits.maxValueDepth) {
    score.abandoned += 1
    record(collector, {
      ruleId: 'record-too-deep',
      file: corpusSource,
      position: entry.index,
      parts,
      message: `The repair of record "${sanitize(entry.id, 60)}" by "${score.strategy}" parsed but nests deeper than the maxValueDepth limit of ${limits.maxValueDepth}; it was not scored.`,
      suggestion: 'Raise --max-value-depth deliberately.',
    })
    return 'abandoned'
  }
  score.parsed += 1

  state.checked += 1
  const schemaProblems = validateAgainstSchema(parsed, corpus.schema, limits, budget)
  const mismatches = schemaProblems.filter((problem) => problem.kind === 'mismatch')
  const unanswered = schemaProblems.filter((problem) => problem.kind !== 'mismatch')
  for (const problem of mismatches) {
    record(collector, {
      ruleId: 'schema-violation',
      file: corpusSource,
      position: entry.index,
      parts: [...parts, ...problem.path],
      message: `Strategy "${score.strategy}" repaired record "${sanitize(entry.id, 60)}" into something the schema rejects: ${problem.message}`,
      suggestion: 'This is a measurement: the repair parsed but does not satisfy the contract.',
    })
  }
  for (const problem of unanswered) {
    record(collector, {
      ruleId: 'schema-unsupported',
      file: corpusSource,
      position: entry.index,
      parts: [...parts, ...problem.path],
      message: `Schema validity for record "${sanitize(entry.id, 60)}" under "${score.strategy}" could not be decided: ${problem.message}`,
      suggestion: 'Express the constraint with a modelled keyword, or accept that validity is unmeasured here.',
    })
  }
  const schemaValid = mismatches.length === 0 && unanswered.length === 0
  if (schemaValid) score.schemaValid += 1

  /*
   * Fidelity, and why it is separate from validity.
   *
   * A repair can satisfy every declared constraint and still not be the record
   * that was labelled -- a string-unaware regular expression that deletes a
   * comma from INSIDE a string produces text that parses, satisfies a schema
   * asking for a string, and says something the model did not. That attempt is
   * the one this bench exists to catch, so it is an error while a repair that
   * merely failed is a warning.
   */
  const difference = firstDifference(entry.expected, parsed)
  if (difference === null) {
    score.faithful += 1
    return 'faithful'
  }
  score.altered += 1
  record(collector, {
    ruleId: 'fidelity-violation',
    file: corpusSource,
    position: entry.index,
    parts: [...parts, ...difference.path],
    message: `Strategy "${score.strategy}" ${schemaValid ? 'produced a schema-valid repair of' : 'repaired'} record "${sanitize(entry.id, 60)}" that no longer matches its label at this field.`,
    evidence: `labelled ${renderValue(difference.left, 80)}, repaired to ${renderValue(difference.right, 80)}`,
    suggestion: 'Use a string-aware repair for this shape; a repair that parses is not a repair that preserved the data.',
  })
  return 'altered'
}

/* -------------------------------------------------------------------------- */

function finish(collector, state, scores, latency, corpusSource) {
  /*
   * The vacuous-pass guard.
   *
   * A report that says `pass` with `checked: 0` is green on no evidence. It is
   * reachable -- a corpus with an empty `records` array parses and validates --
   * so it is named rather than left to look like success.
   */
  const hasError = collector.rows.some((row) => row.severity === 'error')
  if (!hasError && state.checked === 0) {
    record(collector, {
      ruleId: 'corpus-empty',
      file: corpusSource,
      parts: ['records'],
      message: 'No record was scored, so this run is green on no evidence.',
      suggestion: 'Add at least one labelled record before treating a green run as a comparison.',
    })
  }

  collector.rows.sort(compareFindingRows)
  const findings = collector.rows.map((row) => {
    const finding = {
      ruleId: row.ruleId,
      severity: row.severity,
      message: row.message,
      location: { file: row.file, pointer: row.pointer },
    }
    if (row.evidence !== null) finding.evidence = row.evidence
    if (row.suggestion !== null) finding.suggestion = row.suggestion
    return finding
  })
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  const total = (key) => scores.reduce((sum, score) => sum + score[key], 0)

  return {
    report: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      tool: TOOL_ID,
      status,
      summary: {
        checked: state.checked,
        errors,
        warnings,
        info: findings.length - errors - warnings,
        records: state.records,
        strategies: scores.length,
        attempts: state.attempts,
        parsed: total('parsed'),
        schemaValid: total('schemaValid'),
        faithful: total('faithful'),
        altered: total('altered'),
        failed: total('failed'),
        abandoned: total('abandoned'),
        edits: total('edits'),
        cost: total('cost'),
        unknown: collector.rows.filter((row) => INCOMPLETE.has(row.ruleId)).length,
      },
      strategies: scores,
      findings,
    },
    latency,
  }
}

/* -------------------------------------------------------------------------- */

async function readBytes(path) {
  try {
    const buffer = await readFile(path)
    return { ok: true, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) }
  } catch (error) {
    return { ok: false, code: error.code ?? 'read-failed' }
  }
}

/**
 * Read the corpus (and any pipeline definitions) from the filesystem and run.
 *
 * A file that cannot be read is a subject the run had and failed to obtain
 * evidence about, so it produces a report with status `incomplete` -- not a
 * thrown error and never an empty stdout. A consumer needs to know WHICH input
 * was not read.
 */
export async function benchRepairsFromFiles(options = {}) {
  // Validate the limits before touching the filesystem: a bad limit is a
  // configuration error, and a configuration error must not first produce an
  // unreadable-file report about a run that was never going to happen.
  validateLimits(options.limits)
  const corpusSource = options.corpusSource ?? DEFAULT_CORPUS_SOURCE
  const pipelinesSource = options.pipelinesSource ?? DEFAULT_PIPELINES_SOURCE
  const corpus = await readBytes(options.corpus)
  const pipelines = options.pipelines === undefined || options.pipelines === null
    ? { ok: true, bytes: undefined }
    : await readBytes(options.pipelines)

  if (!corpus.ok || !pipelines.ok) {
    const collector = createCollector()
    if (!corpus.ok) {
      record(collector, {
        ruleId: 'corpus-unreadable',
        file: corpusSource,
        parts: [],
        message: 'The corpus could not be read, so no record was scored.',
        evidence: corpus.code,
        suggestion: 'Check the path and the permissions on the file.',
      })
    }
    if (!pipelines.ok) {
      record(collector, {
        ruleId: 'pipelines-unreadable',
        file: pipelinesSource,
        parts: [],
        message: 'The pipeline definitions could not be read, so the strategies they define were not measured.',
        evidence: pipelines.code,
        suggestion: 'Check the path and the permissions on the file.',
      })
    }
    return finish(collector, { records: 0, attempts: 0, checked: 0 }, [], {}, corpusSource)
  }

  return benchRepairs({
    corpusBytes: corpus.bytes,
    pipelinesBytes: pipelines.bytes,
    corpusSource,
    pipelinesSource,
    limits: options.limits,
    clock: options.clock,
    strategies: options.strategies,
    minFidelityPercent: options.minFidelityPercent,
  })
}

/** The human-readable scoreboard. Machine-readable output goes to `--json`. */
export function formatReport(result) {
  const { summary, strategies, findings, status } = result.report
  const lines = [
    `${TOOL_ID}: ${summary.records} record(s) x ${summary.strategies} strategy(ies) = ${summary.attempts} attempt(s), `
    + `${summary.faithful} faithful, ${summary.altered} altered, ${summary.failed} failed, `
    + `${summary.unknown} unanswered; status ${status}.`,
    '',
    '  strategy              attempted  parsed  valid  faithful  altered  failed  edits',
  ]
  for (const score of strategies) {
    lines.push(
      `  ${score.strategy.padEnd(20).slice(0, 20)}  ${String(score.attempted).padStart(9)}`
      + `  ${String(score.parsed).padStart(6)}  ${String(score.schemaValid).padStart(5)}`
      + `  ${String(score.faithful).padStart(8)}  ${String(score.altered).padStart(7)}`
      + `  ${String(score.failed).padStart(6)}  ${String(score.edits).padStart(5)}`,
    )
  }
  lines.push('')
  for (const finding of findings) {
    const where = finding.location.pointer === '' ? finding.location.file : `${finding.location.file}${finding.location.pointer}`
    lines.push(`  ${finding.severity.padEnd(7)} ${finding.ruleId}  ${where}`)
    lines.push(`          ${finding.message}`)
    if (finding.evidence !== undefined) lines.push(`          evidence: ${finding.evidence}`)
    if (finding.suggestion !== undefined) lines.push(`          try: ${finding.suggestion}`)
  }
  if (findings.length === 0) lines.push('  no findings')
  return `${lines.join('\n')}\n`
}

export { DEFAULT_LIMITS, PRESET_NAMES }
