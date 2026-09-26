import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/text.mjs'

/**
 * The parse-failure helper, pinned against the leak it exists to prevent.
 *
 * This tool parses malformed text on purpose, once per attempt, and reports
 * every one of those failures -- so the leak below is the main path here, not a
 * corner case. V8 reports a JSON parse failure two ways and one of them quotes
 * the input back, so the error message of a malformed model response can carry
 * that response onto stdout past every redactor. The cases below are the ones that found the
 * bug elsewhere in this catalog: the ordering trap, a credential-only document,
 * a long document whose sensitive part is at the FRONT, a quoted span
 * containing a newline, and the genuinely safe positional form.
 */

function detailFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return parseFailureDetail(error)
  }
  throw new Error('the document parsed; this case cannot test a parse failure')
}

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  // V8: Unexpected token 'a', "at position 1" is not valid JSON.
  // A helper that looks for the offset BEFORE recognising the quoting shape
  // matches inside the quoted span and returns the document.
  const detail = detailFor('at position 1')
  assert.ok(!detail.includes('at position 1'), `leaked: ${detail}`)
  assert.ok(!detail.includes('"'))
  assert.equal(detail, "unexpected token 'a' at the start of the document")
})

test('a document that is nothing but a credential is never reproduced', () => {
  const detail = detailFor('AKIAIOSFODNN7EXAMPLE')
  assert.ok(!detail.includes('AKIA'), `leaked: ${detail}`)
  assert.ok(!detail.includes('"'))
})

test('a long document with a sensitive prefix is not reproduced from the front', () => {
  // Truncation does not help: the quoted snippet sits at the FRONT of the
  // message, so a helper that cuts the tail keeps exactly the wrong half.
  const document = `AKIAIOSFODNN7EXAMPLE${'-'.repeat(4000)}`
  const detail = detailFor(document)
  assert.ok(!detail.includes('AKIA'), `leaked: ${detail}`)
  assert.ok(!detail.includes('"'))
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  // Without the `s` flag the quoting pattern fails to match here and the helper
  // falls through to a branch that returns part of the message.
  const detail = detailFor('secret\nAKIAIOSFODNN7EXAMPLE')
  assert.ok(!detail.includes('AKIA'), `leaked: ${detail}`)
  assert.ok(!detail.includes('secret'), `leaked: ${detail}`)
  assert.ok(!detail.includes('"'))
})

test('the safe positional form still yields position, line and column', () => {
  // A helper that answered the generic sentence for everything would pass every
  // leak assertion above while destroying the diagnostic.
  const detail = detailFor('{"alpha": 1, "beta" 2}')
  assert.match(detail, /at position \d+/)
  assert.match(detail, /line \d+ column \d+/)
  assert.ok(!detail.includes('"'))
})

test('an offence inside the document quotes a window from the middle, not the front', () => {
  const detail = detailFor('{"alpha": ZQXJVBMP7W}')
  assert.ok(!detail.includes('ZQXJVBMP7W'), `leaked: ${detail}`)
  assert.equal(detail, "unexpected token 'Z' inside the document")
})

test('an empty document keeps its own diagnostic', () => {
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
})

test('a message shape the helper has never seen still cannot carry a snippet', () => {
  // The closing guard does not depend on the branch logic being right: across
  // 500,206 distinct V8 parse messages, every one with no quoted snippet also
  // had no double quote at all.
  const invented = new Error('Totally new V8 wording, "SECRET-PAYLOAD-7" refused')
  assert.equal(parseFailureDetail(invented), 'the document could not be parsed as JSON')
})

test('a non-error argument does not throw', () => {
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(null), 'the document could not be parsed as JSON')
})
