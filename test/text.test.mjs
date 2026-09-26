import assert from 'node:assert/strict'
import test from 'node:test'

import { EXCERPT_LIMIT, byCodeUnit, decodeUtf8, renderValue, reportPointer, sanitize } from '../src/text.mjs'

/** Code points written as escapes, never as literals: a literal U+2028 breaks the module at load. */
const NEL = String.fromCharCode(0x85)
const CSI = String.fromCharCode(0x9b)
const RLO = String.fromCharCode(0x202e)
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const DEL = String.fromCharCode(0x7f)
const ISOLATE = String.fromCharCode(0x2066)

test('byCodeUnit orders by UTF-16 code unit, not by collation', () => {
  // A collator folds case and ignores punctuation weight; code units do not.
  assert.deepEqual(['assets', 'README', 'Z', 'a_b', 'a-b'].sort(byCodeUnit), ['README', 'Z', 'a-b', 'a_b', 'assets'])
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('a', 'b'), -1)
  assert.equal(byCodeUnit('b', 'a'), 1)
})

test('decodeUtf8 refuses undecodable bytes instead of inventing replacement characters', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x7b, 0x7d])), { ok: true, text: '{}' })
  assert.equal(decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd])).ok, false)
})

test('decodeUtf8 accepts a document that legitimately contains U+FFFD', () => {
  // The replacement character is a valid code point. A tool that infers "not
  // UTF-8" from its presence in decoded text refuses a readable document, and
  // the inverse mistake lets an unreadable one pass.
  const bytes = new TextEncoder().encode('{"note":"�"}')
  assert.equal(decodeUtf8(bytes).ok, true)
})

test('sanitize removes every class of forging and hiding character', () => {
  for (const [name, character] of [
    ['C0 newline', '\n'],
    ['C0 escape', String.fromCharCode(27)],
    ['DEL', DEL],
    ['C1 NEL', NEL],
    ['C1 CSI', CSI],
    ['line separator', LINE_SEPARATOR],
    ['paragraph separator', PARAGRAPH_SEPARATOR],
    ['bidi override', RLO],
    ['bidi isolate', ISOLATE],
  ]) {
    const cleaned = sanitize(`left${character}right`)
    assert.equal(cleaned, 'left right', `${name} survived sanitising`)
  }
})

test('sanitize bounds what one string contributes and marks the cut', () => {
  const long = 'x'.repeat(EXCERPT_LIMIT + 50)
  const cleaned = sanitize(long)
  assert.equal(cleaned.length, EXCERPT_LIMIT + 3)
  assert.ok(cleaned.endsWith('...'))
  assert.throws(() => sanitize('x', 0), TypeError)
})

test('reportPointer escapes RFC 6901 characters after sanitising', () => {
  assert.equal(reportPointer([]), '')
  assert.equal(reportPointer(['calls', '0', 'tool']), '/calls/0/tool')
  assert.equal(reportPointer(['a/b']), '/a~1b')
  assert.equal(reportPointer(['a~b']), '/a~0b')
  // Sanitising first, escaping second: a newline in a key cannot forge a line
  // and cannot then be read back as a separator.
  assert.equal(reportPointer([`a${LINE_SEPARATOR}b`]), '/a b')
})

test('renderValue survives values JSON.stringify cannot represent', () => {
  assert.equal(renderValue({ a: 1 }), '{"a":1}')
  assert.equal(renderValue(undefined), 'undefined')
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(renderValue(cyclic), '[object Object]')
})
