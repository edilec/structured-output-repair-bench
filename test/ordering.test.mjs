import assert from 'node:assert/strict'
import test from 'node:test'

import { RULE_SEVERITY, benchRepairs } from '../src/index.mjs'

/**
 * Ordering, pinned by what the tool emits rather than by how it is spelled.
 *
 * Grepping the source for `.localeCompare(` is not a determinism test: an
 * `Intl.Collator` drops the forbidden literal and collates exactly as badly, so
 * the grep stays green while the scoreboard order starts depending on the ICU
 * data of whichever host ran it. Every identifier below is chosen so that
 * code-unit order and collation order genuinely disagree:
 *
 * - a collator folds case, so it puts `assets` before `README` and before `Z`;
 * - a collator treats `-` and `_` as ignorable punctuation, so it reads `a-b`
 *   and `a_b` as `ab` and puts both before `assets`, while the code units put
 *   `a-b` before `a_b` and both after `a`.
 *
 * Code units give one answer: R(0x52), Z(0x5A), a(0x61), then `a` before `a-b`
 * because it is a prefix, then `-`(0x2D) before `_`(0x5F) before `s`(0x73).
 *
 * Substituting `new Intl.Collator('en').compare` for `byCodeUnit` turns these
 * assertions red. The rule-id comparison is the one site that cannot be pinned
 * this way, and the last test in this file says why in an executable form.
 */

const CODE_UNIT_ORDER = ['README', 'Z', 'a', 'a-b', 'a_b', 'assets']
// Declaration order is deliberately the reverse of the answer.
const DECLARED = [...CODE_UNIT_ORDER].reverse()

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

function bench(options) {
  return benchRepairs(options).report
}

test('attempts on one record are ordered by strategy name in code-unit order', () => {
  // Each custom strategy repairs nothing, so each produces one repair-failed
  // finding at `/records/0/<name>`.
  const report = bench({
    corpusBytes: encode({
      corpusVersion: '1',
      schema: { type: 'object' },
      records: [{ id: 'r', raw: 'not json at all', expected: {} }],
    }),
    pipelinesBytes: encode({
      pipelinesVersion: '1',
      strategies: DECLARED.map((name) => ({ name, steps: [] })),
    }),
    strategies: DECLARED,
  })
  const names = report.findings
    .filter((finding) => finding.ruleId === 'repair-failed')
    .map((finding) => finding.location.pointer.split('/').pop())
  assert.deepEqual(names, CODE_UNIT_ORDER)
})

test('findings are grouped by file in code-unit order, not by collation', () => {
  // `Zebra.json` before `apple.json`: Z is 0x5A and a is 0x61. A collator folds
  // case and answers the other way round.
  const report = bench({
    corpusBytes: encode({
      corpusVersion: '1',
      schema: { type: 'object' },
      records: [{ id: 'r', raw: 'not json', expected: {} }],
    }),
    pipelinesBytes: encode({ pipelinesVersion: '1', strategies: [{ name: 'broken', steps: ['no-such-step'] }] }),
    corpusSource: 'Zebra.json',
    pipelinesSource: 'apple.json',
    strategies: ['strict', 'broken'],
  })
  const files = report.findings.map((finding) => finding.location.file)
  assert.deepEqual(files, ['Zebra.json', 'Zebra.json', 'apple.json', 'apple.json'])
})

test('fields inside one attempt are ordered by the whole pointer, in code-unit order', () => {
  const properties = {}
  for (const key of DECLARED) properties[key] = { type: 'number' }
  const expected = {}
  const emitted = {}
  for (const key of DECLARED) {
    expected[key] = 1
    emitted[key] = 'wrong'
  }
  const report = bench({
    corpusBytes: encode({
      corpusVersion: '1',
      schema: { type: 'object', properties },
      records: [{ id: 'r', raw: `${JSON.stringify(emitted).slice(0, -1)},}`, expected }],
    }),
    strategies: ['scanner'],
  })
  const keys = report.findings
    .filter((finding) => finding.ruleId === 'schema-violation')
    .map((finding) => finding.location.pointer.split('/').pop())
  assert.deepEqual(keys, CODE_UNIT_ORDER)
})

test('a fidelity violation in two places at once is reported at the code-unit-first key', () => {
  // Both `Z` and `a` differ. Code units answer `Z`; a collator answers `a`.
  const report = bench({
    corpusBytes: encode({
      corpusVersion: '1',
      schema: { type: 'object' },
      records: [{ id: 'r', raw: '{"Z": 2, "a": 2,}', expected: { Z: 1, a: 1 } }],
    }),
    strategies: ['scanner'],
  })
  const finding = report.findings.find((entry) => entry.ruleId === 'fidelity-violation')
  assert.equal(finding.location.pointer, '/records/0/scanner/Z')
})

test('records are ordered by their position in the corpus, not by the text of the pointer', () => {
  // `/records/10` sorts before `/records/2` by code unit. A report read
  // alongside a corpus should follow the corpus, so position is carried apart.
  const records = Array.from({ length: 12 }, (unused, index) => ({ id: `r${index}`, raw: 'not json', expected: {} }))
  const report = bench({
    corpusBytes: encode({ corpusVersion: '1', schema: { type: 'object' }, records }),
    strategies: ['strict'],
  })
  const positions = report.findings
    .filter((finding) => finding.ruleId === 'repair-failed')
    .map((finding) => Number(/\/records\/(\d+)\//.exec(finding.location.pointer)[1]))
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
  assert.deepEqual(positions.slice(0, 4), [0, 1, 2, 3])
})

test('the scoreboard keeps the order the caller asked for, and never sorts it', () => {
  // A scoreboard is read top to bottom against the order the reader chose.
  // Re-sorting it would silently answer a different question.
  const corpusBytes = encode({
    corpusVersion: '1',
    schema: { type: 'object' },
    records: [{ id: 'r', raw: '{"a": 1,}', expected: { a: 1 } }],
  })
  const forwards = bench({ corpusBytes, strategies: ['scanner', 'naive-regex', 'strict'] })
  assert.deepEqual(forwards.strategies.map((score) => score.strategy), ['scanner', 'naive-regex', 'strict'])
  const backwards = bench({ corpusBytes, strategies: ['strict', 'naive-regex', 'scanner'] })
  assert.deepEqual(backwards.strategies.map((score) => score.strategy), ['strict', 'naive-regex', 'scanner'])
})

test('the rule-id comparison is unobservable, and stays that way only while this holds', () => {
  /*
   * Honesty about a site that cannot be pinned behaviourally.
   *
   * `compareFindingRows` falls through to the rule id only for two findings
   * alike in file, position and pointer. For the rule ids this tool declares,
   * code-unit order and collation order agree on every pair -- so no input can
   * make that comparison observable, and claiming a behavioural pin for it
   * would be claiming coverage that does not exist.
   *
   * `Intl.Collator` appears HERE, in a test, precisely because it must never
   * appear in `src/`. If a future rule id makes the two orders disagree, this
   * assertion fails and the site becomes pinnable -- and must then be pinned.
   */
  const collate = new Intl.Collator('en').compare
  const ids = Object.keys(RULE_SEVERITY)
  for (const left of ids) {
    for (const right of ids) {
      if (left === right) continue
      const byUnit = left < right ? -1 : 1
      const byCollation = collate(left, right) < 0 ? -1 : 1
      assert.equal(byUnit, byCollation, `rule ids "${left}" and "${right}" now order differently; pin this site`)
    }
  }
})
