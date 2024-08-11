import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS } from '../src/document.mjs'
import { readCorpus, readPipelines } from '../src/corpus.mjs'

/**
 * The corpus envelope, the shape of one record, and the pipeline definitions.
 *
 * A corpus is model output: the least trustworthy input this catalog handles,
 * because every byte of it is text a language model emitted. Nothing in it can
 * change what the bench does -- these functions check that a record has an id,
 * a raw response and a label, and nothing else.
 */

const limits = { ...DEFAULT_LIMITS }
const schema = { type: 'object' }

function read(document) {
  return readCorpus(document, limits)
}

test('a well-formed corpus yields records in the order they were written', () => {
  const corpus = read({
    corpusVersion: '1',
    schema,
    records: [{ id: 'a', raw: '{}', expected: {} }, { id: 'b', raw: '[]', expected: [] }],
  })
  assert.deepEqual(corpus.recordFaults, [])
  assert.deepEqual(corpus.records.map((entry) => entry.id), ['a', 'b'])
  assert.equal(corpus.declared, 2)
})

test('a corpus of the wrong version is refused whole', () => {
  const corpus = read({ corpusVersion: '2', schema, records: [] })
  assert.equal(corpus.records.length, 0)
  assert.match(corpus.envelopeFaults[0].message, /this bench reads version "1"/)
})

test('a corpus with no schema is refused, because validity cannot be measured without one', () => {
  // Reporting a "schema valid" column computed against nothing would be a
  // number the bench never calculated.
  for (const value of [undefined, null, 'object', []]) {
    const corpus = read({ corpusVersion: '1', schema: value, records: [] })
    assert.match(corpus.envelopeFaults[0].message, /must declare a "schema" object/)
  }
})

test('records must be an array', () => {
  const corpus = read({ corpusVersion: '1', schema, records: {} })
  assert.match(corpus.envelopeFaults[0].message, /must declare "records" as an array/)
})

test('a record missing an id or a raw response is refused, and named at that field', () => {
  const cases = [
    [{ raw: '{}', expected: {} }, '/records/0/id'],
    [{ id: '', raw: '{}', expected: {} }, '/records/0/id'],
    [{ id: 'a', expected: {} }, '/records/0/raw'],
    [{ id: 'a', raw: 7, expected: {} }, '/records/0/raw'],
  ]
  for (const [entry, pointer] of cases) {
    const corpus = read({ corpusVersion: '1', schema, records: [entry] })
    assert.equal(corpus.records.length, 0, `${JSON.stringify(entry)} was accepted`)
    assert.equal(`/${corpus.recordFaults[0].parts.join('/')}`, pointer)
  }
})

test('a duplicate record id is refused, because a finding against it would not be addressable', () => {
  const corpus = read({
    corpusVersion: '1',
    schema,
    records: [{ id: 'a', raw: '{}', expected: {} }, { id: 'a', raw: '[]', expected: [] }],
  })
  assert.deepEqual(corpus.records.map((entry) => entry.id), ['a'])
  assert.match(corpus.recordFaults[0].message, /appears more than once/)
})

test('an unlabelled record is reported apart from a malformed one', () => {
  // The difference matters: this record could have been scored, and was not,
  // for want of the one thing fidelity is measured against.
  const corpus = read({ corpusVersion: '1', schema, records: [{ id: 'a', raw: '{}' }] })
  assert.deepEqual(corpus.records, [])
  assert.deepEqual(corpus.recordFaults, [])
  assert.deepEqual(corpus.unlabelled.map((entry) => entry.id), ['a'])
})

test('a label of null, false or zero is a label, not an absent one', () => {
  // `Object.hasOwn`, not truthiness: a record whose correct repair really is
  // `null` must not be read as unlabelled.
  for (const value of [null, false, 0, '']) {
    const corpus = read({ corpusVersion: '1', schema, records: [{ id: 'a', raw: '{}', expected: value }] })
    assert.deepEqual(corpus.unlabelled, [], `expected ${JSON.stringify(value)} was read as absent`)
    assert.equal(corpus.records.length, 1)
  }
})

test('one refused record does not refuse the records around it', () => {
  const corpus = read({
    corpusVersion: '1',
    schema,
    records: [{ id: 'a', raw: '{}', expected: {} }, { id: '', raw: '{}', expected: {} }, { id: 'c', raw: '{}', expected: {} }],
  })
  assert.deepEqual(corpus.records.map((entry) => entry.id), ['a', 'c'])
  assert.equal(corpus.recordFaults.length, 1)
})

test('a corpus over the record limit is refused whole, not truncated', () => {
  const records = Array.from({ length: 5 }, (unused, index) => ({ id: `r${index}`, raw: '{}', expected: {} }))
  const corpus = readCorpus({ corpusVersion: '1', schema, records }, { ...limits, maxRecords: 3 })
  assert.equal(corpus.records.length, 0)
  assert.equal(corpus.overRecordLimit, true)
  assert.match(corpus.envelopeFaults[0].message, /over the maxRecords limit of 3/)
})

test('a pipeline document defines strategies from implemented steps', () => {
  const parsed = readPipelines({
    pipelinesVersion: '1',
    strategies: [{ name: 'mine', steps: ['extract-json-span', 'close-delimiters'] }],
  })
  assert.deepEqual(parsed.faults, [])
  assert.deepEqual(parsed.strategies, [{ name: 'mine', steps: ['extract-json-span', 'close-delimiters'] }])
})

test('a pipeline naming a step this bench does not implement is refused by name', () => {
  // Accepting it and skipping it would put a number next to a strategy that
  // never ran the repair its own definition claims.
  const parsed = readPipelines({ pipelinesVersion: '1', strategies: [{ name: 'mine', steps: ['fix-everything'] }] })
  assert.deepEqual(parsed.strategies, [])
  assert.match(parsed.faults[0].message, /step\(s\) this bench does not implement, beginning with "fix-everything"/)
})

test('a pipeline may define an empty strategy, which is a baseline and not an error', () => {
  const parsed = readPipelines({ pipelinesVersion: '1', strategies: [{ name: 'nothing', steps: [] }] })
  assert.deepEqual(parsed.strategies, [{ name: 'nothing', steps: [] }])
})

test('a pipeline cannot redefine a built-in preset, or itself', () => {
  const preset = readPipelines({ pipelinesVersion: '1', strategies: [{ name: 'scanner', steps: [] }] })
  assert.match(preset.faults[0].message, /is a built-in preset and cannot be redefined/)

  const twice = readPipelines({
    pipelinesVersion: '1',
    strategies: [{ name: 'mine', steps: [] }, { name: 'mine', steps: ['close-delimiters'] }],
  })
  assert.deepEqual(twice.strategies.map((entry) => entry.name), ['mine'])
  assert.match(twice.faults[0].message, /declared more than once/)
})

test('a pipeline document of the wrong version or shape is refused', () => {
  assert.match(readPipelines({ pipelinesVersion: '0', strategies: [] }).faults[0].message, /this bench reads version "1"/)
  assert.match(readPipelines({ pipelinesVersion: '1', strategies: {} }).faults[0].message, /must declare "strategies" as an array/)
  assert.match(readPipelines({ pipelinesVersion: '1', strategies: [{ name: 'a' }] }).faults[0].message, /must declare "steps" as an array/)
})
