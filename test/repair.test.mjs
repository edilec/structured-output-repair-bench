import assert from 'node:assert/strict'
import test from 'node:test'

import { PRESETS, PRESET_NAMES, PRIMITIVE_IDS, analyse, runPipeline } from '../src/repair.mjs'

/**
 * The repair primitives, each pinned by what it produces.
 *
 * Two of them are the naive, string-unaware regular expressions, and their
 * damage is asserted here rather than apologised for: a bench that shipped a
 * "naive" primitive which quietly behaved like the careful one would be
 * measuring nothing. The pairs below are the whole point of the corpus.
 */

const limits = { maxEdits: 200, maxSteps: 10_000_000 }

function run(steps, text, overrides = {}) {
  const meter = { steps: 0 }
  return runPipeline(steps, text, { ...limits, ...overrides }, meter)
}

function repaired(steps, text) {
  const outcome = run(steps, text)
  assert.equal(outcome.ok, true)
  return outcome.text
}

function parsedBy(steps, text) {
  return JSON.parse(repaired(steps, text))
}

test('analyse tracks string context, open containers and the first balanced span', () => {
  const state = analyse('prefix {"a": "}", "b": [1')
  assert.equal(state.start, 7)
  assert.equal(state.end, -1)
  assert.deepEqual(state.openers, ['}', ']'])
  assert.equal(state.endedInString, false)
  // The `}` at index 14 is inside a string and did not close anything.
  assert.equal(state.inString[14], 1)
  assert.equal(analyse('{"a": "x').endedInString, true)
  assert.equal(analyse('{"a": "x\\').danglingEscape, true)
})

test('strip-code-fence removes a fence and leaves unfenced text alone', () => {
  assert.equal(repaired(['strip-code-fence'], '```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(repaired(['strip-code-fence'], '```\n{"a":1}\n```'), '{"a":1}')
  assert.equal(repaired(['strip-code-fence'], '{"a":1}'), '{"a":1}')
  assert.equal(run(['strip-code-fence'], '{"a":1}').edits, 0)
})

test('extract-json-span keeps the first balanced object and drops the prose', () => {
  assert.equal(repaired(['extract-json-span'], 'Sure: {"a":1} hope that helps'), '{"a":1}')
  assert.equal(repaired(['extract-json-span'], 'Sure: [1,2] done'), '[1,2]')
  // A brace inside a string does not close the span.
  assert.equal(repaired(['extract-json-span'], 'x {"a":"}"} y'), '{"a":"}"}')
  // Nothing container-shaped: left exactly as it is rather than guessed at.
  assert.equal(repaired(['extract-json-span'], 'no json here'), 'no json here')
  assert.equal(run(['extract-json-span'], '{"a":1}').edits, 0)
})

test('close-delimiters closes what a truncated response left open', () => {
  assert.deepEqual(parsedBy(['close-delimiters'], '{"a": [1, 2'), { a: [1, 2] })
  assert.deepEqual(parsedBy(['close-delimiters'], '{"a": "unterminated'), { a: 'unterminated' })
  assert.equal(run(['close-delimiters'], '{"a":1}').edits, 0)
})

test('close-delimiters refuses a dangling escape rather than patching one', () => {
  // Appending a quote after a lone backslash either gets swallowed by the
  // escape or changes the string. Leaving the record unrepaired is honest; the
  // bench then counts it as a failure, visibly.
  const outcome = run(['close-delimiters'], '{"a": "x\\')
  assert.equal(outcome.text, '{"a": "x\\')
  assert.equal(outcome.edits, 0)
  assert.throws(() => JSON.parse(outcome.text))
})

test('single-to-double-quotes re-serialises rather than swapping quotes in place', () => {
  assert.deepEqual(parsedBy(['single-to-double-quotes'], "{'a': 'b'}"), { a: 'b' })
  // An apostrophe inside the span is why swapping in place does not work.
  assert.deepEqual(parsedBy(['single-to-double-quotes'], "{'a': 'it\\'s fine'}"), { a: "it's fine" })
  // A double quote inside the span has to come back out escaped.
  assert.deepEqual(parsedBy(['single-to-double-quotes'], "{'a': 'say \"hi\"'}"), { a: 'say "hi"' })
  // A double-quoted string is left alone, apostrophes and all.
  assert.deepEqual(parsedBy(['single-to-double-quotes'], '{"a": "it\'s fine"}'), { a: "it's fine" })
  // An unterminated single-quoted span is copied out verbatim from where it
  // opened: guessing where it ended would be inventing content. Spans that
  // closed before it are still converted, so the primitive does as much as it
  // honestly can and no more.
  assert.equal(repaired(['single-to-double-quotes'], "{'a': 'open"), `{"a": 'open`)
  assert.equal(run(['single-to-double-quotes'], "{'a': 'open").edits, 1)
})

test('the naive comma strip edits data inside a string, and the aware one does not', () => {
  // This pair is the measurement the bench exists to make.
  const raw = '{"note": "totals: 1,}", "n": 1,}'
  const naive = parsedBy(['strip-trailing-commas'], raw)
  const aware = parsedBy(['strip-trailing-commas-aware'], raw)
  assert.deepEqual(naive, { note: 'totals: 1}', n: 1 }, 'the naive form no longer damages the string; the pair is meaningless')
  assert.deepEqual(aware, { note: 'totals: 1,}', n: 1 })
  assert.notDeepEqual(naive, aware)
})

test('both comma strips remove a real trailing comma', () => {
  for (const step of ['strip-trailing-commas', 'strip-trailing-commas-aware']) {
    assert.deepEqual(parsedBy([step], '{"a": 1,}'), { a: 1 }, step)
    assert.deepEqual(parsedBy([step], '[1, 2,]'), [1, 2], step)
    assert.deepEqual(parsedBy([step], '{"a": [1,],}'), { a: [1] }, step)
  }
})

test('the naive key quoter edits data inside a string, and quotes real bare keys', () => {
  assert.deepEqual(parsedBy(['quote-bare-keys'], '{a: 1, b: 2}'), { a: 1, b: 2 })
  // The same pattern inside a string is rewritten too, because the regex has no
  // idea it is inside one.
  const damaged = repaired(['quote-bare-keys'], '{"note": "x, total: 1"}')
  assert.ok(damaged.includes('"total"'), 'the naive quoter no longer reaches inside strings; it is no longer naive')
})

test('edits are counted, and an edit budget abandons the attempt whole', () => {
  assert.equal(run(['strip-trailing-commas-aware'], '{"a": [1,], "b": [2,],}').edits, 3)
  const abandoned = run(['strip-trailing-commas-aware'], '{"a": [1,], "b": [2,],}', { maxEdits: 2 })
  assert.equal(abandoned.ok, false)
  assert.equal(abandoned.reason, 'edit-budget')
  assert.equal(abandoned.step, 'strip-trailing-commas-aware')
  // Nothing partly applied: the text handed back is the text going in.
  assert.equal(abandoned.text, '{"a": [1,], "b": [2,],}')
})

test('a step budget abandons the attempt and names the step it stopped at', () => {
  const abandoned = run(['strip-code-fence', 'extract-json-span'], '{"a": 1}', { maxSteps: 9 })
  assert.equal(abandoned.ok, false)
  assert.equal(abandoned.reason, 'step-budget')
  assert.equal(abandoned.step, 'extract-json-span')
})

test('the shipped presets are built only from implemented primitives', () => {
  for (const [name, steps] of Object.entries(PRESETS)) {
    for (const step of steps) {
      assert.ok(PRIMITIVE_IDS.includes(step), `preset ${name} names an unimplemented step ${step}`)
    }
  }
  assert.deepEqual(PRESET_NAMES, ['strict', 'span', 'naive-regex', 'scanner'])
  assert.deepEqual(PRESETS.strict, [])
})

test('every primitive is reachable from a pipeline and is a pure function of its text', () => {
  for (const step of PRIMITIVE_IDS) {
    const text = '{"a": [1,], "b": \'x\', c: 2,'
    const first = run([step], text)
    const second = run([step], text)
    assert.deepEqual(first, second, `${step} is not a pure function of its text`)
  }
})

test('the scanner preset repairs the shapes it claims, end to end', () => {
  const cases = [
    ['```json\n{"a": 1}\n```', { a: 1 }],
    ['Here: {"a": 1} thanks', { a: 1 }],
    ['{"a": [1, 2', { a: [1, 2] }],
    ["{'a': 'b'}", { a: 'b' }],
    ['{"a": 1,}', { a: 1 }],
    ['{"a": "x', { a: 'x' }],
  ]
  for (const [raw, expected] of cases) {
    assert.deepEqual(parsedBy(PRESETS.scanner, raw), expected, raw)
  }
})

test('the scanner preset leaves a bare-key response unrepaired rather than guessing', () => {
  // It ships no bare-key quoter, and a strategy that cannot fix a shape must
  // fail visibly rather than approximate it.
  assert.throws(() => parsedBy(PRESETS.scanner, '{a: 1}'))
})
