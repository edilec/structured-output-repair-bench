import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS } from '../src/document.mjs'
import { SUPPORTED_KEYWORDS, SUPPORTED_TYPES, deepEqual, firstDifference, validateAgainstSchema } from '../src/schema.mjs'

const limits = { ...DEFAULT_LIMITS }

function problems(value, schema, overrides = {}) {
  return validateAgainstSchema(value, schema, { ...limits, ...overrides })
}

test('a value that satisfies every modelled keyword produces no problem', () => {
  const schema = {
    type: 'object',
    required: ['sku', 'tags'],
    properties: {
      sku: { type: 'string', minLength: 3, maxLength: 10 },
      quantity: { type: 'integer', minimum: 1, maximum: 5 },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 3 },
      mode: { const: 'fast' },
    },
    additionalProperties: false,
  }
  assert.deepEqual(problems({ mode: 'fast', quantity: 2, sku: 'DESK-1', tags: ['a'] }, schema), [])
})

test('each modelled constraint is actually applied', () => {
  const cases = [
    [{ type: 'string' }, 7, /Expected string but found number/],
    [{ type: 'integer' }, 1.5, /Expected integer but found number/],
    [{ type: 'null' }, 0, /Expected null but found number/],
    [{ type: 'array' }, {}, /Expected array but found object/],
    [{ type: 'string', minLength: 3 }, 'ab', /under minLength 3/],
    [{ type: 'string', maxLength: 1 }, 'ab', /over maxLength 1/],
    [{ type: 'number', minimum: 1 }, 0, /below minimum 1/],
    [{ type: 'number', maximum: 1 }, 2, /above maximum 1/],
    [{ type: 'array', minItems: 2 }, [1], /under minItems 2/],
    [{ type: 'array', maxItems: 1 }, [1, 2], /over maxItems 1/],
    [{ enum: ['a'] }, 'b', /is not one of the 1 enumerated/],
    [{ const: 3 }, 4, /Expected the constant 3/],
    [{ type: 'object', required: ['a'] }, {}, /required property "a" is absent/],
    [{ type: 'object', additionalProperties: false }, { z: 1 }, /not declared and additionalProperties is false/],
  ]
  for (const [schema, value, pattern] of cases) {
    const found = problems(value, schema)
    assert.equal(found.length, 1, `${JSON.stringify(schema)} did not produce exactly one problem for ${JSON.stringify(value)}`)
    assert.equal(found[0].kind, 'mismatch')
    assert.match(found[0].message, pattern)
  }
})

test('an unmodelled keyword is refused by name rather than ignored', () => {
  // Silently ignoring a keyword is a constraint written down, never applied,
  // and reported as satisfied. The subset is refused loudly instead.
  const found = problems({ a: 1 }, { type: 'object', patternProperties: { '^a$': { type: 'string' } } })
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'unsupported')
  assert.match(found[0].message, /"patternProperties" is not modelled/)
})

test('an unmodelled type name is refused rather than treated as satisfied', () => {
  const found = problems('x', { type: 'uuid' })
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'schema')
})

test('the supported sets are non-empty and sorted, so the refusal message is stable', () => {
  assert.ok(SUPPORTED_KEYWORDS.length > 0)
  assert.deepEqual([...SUPPORTED_KEYWORDS].sort(), [...SUPPORTED_KEYWORDS])
  assert.deepEqual([...SUPPORTED_TYPES].sort(), [...SUPPORTED_TYPES])
})

test('problems address the exact position inside the value', () => {
  const schema = {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } } },
  }
  const found = problems({ items: [{ n: 1 }, { n: 'two' }] }, schema)
  assert.equal(found.length, 1)
  assert.deepEqual(found[0].path, ['items', '1', 'n'])
})

test('the shared step budget bounds total validation work', () => {
  const found = problems({ a: [1, 2, 3, 4, 5, 6] }, { type: 'object', properties: { a: { type: 'array', items: { type: 'integer' } } } }, { maxSteps: 3 })
  assert.equal(found.at(-1).kind, 'budget')
})

test('a value deeper than maxValueDepth is refused, not walked', () => {
  const deep = { a: { b: { c: { d: 1 } } } }
  const schema = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object' } } } } } } }
  const found = problems(deep, schema, { maxValueDepth: 2 })
  assert.ok(found.some((problem) => problem.kind === 'depth'))
})

test('firstDifference reports where two values first disagree, in code-unit key order', () => {
  assert.equal(firstDifference({ a: 1 }, { a: 1 }), null)
  assert.deepEqual(firstDifference({ a: 1, b: 2 }, { a: 1, b: 3 }).path, ['b'])
  // Both keys differ; the answer is the code-unit-first key, not the insertion
  // order V8 happens to hand back.
  const difference = firstDifference({ Z: 1, a: 1 }, { Z: 2, a: 2 })
  assert.deepEqual(difference.path, ['Z'])
  assert.deepEqual(firstDifference([1, 2], [1, 2, 3]).path, [])
  assert.deepEqual(firstDifference({ a: 1 }, { b: 1 }).path, ['a'])
  assert.equal(firstDifference(1, '1').path.length, 0)
})

test('deepEqual agrees with firstDifference', () => {
  assert.equal(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }), true)
  assert.equal(deepEqual({ a: [1] }, { a: [1, 2] }), false)
})
