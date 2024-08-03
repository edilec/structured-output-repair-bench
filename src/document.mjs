/**
 * Reading a JSON document under declared bounds.
 *
 * Both inputs -- the corpus and the optional pipeline definitions -- arrive as
 * bytes and get the same treatment: decode strictly, refuse what is too large
 * before parsing it, parse without ever reproducing the text, and refuse what
 * nests too deeply. A limit that is reached refuses the whole document; nothing
 * is truncated, because a truncated document silently becomes a different,
 * smaller document that might pass.
 */

import { decodeUtf8, parseFailureDetail } from './text.mjs'

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The documented limits and their defaults.
 *
 * Every one of these is wired to the code that enforces it and to a test that
 * reaches it through the command line. A documented limit nobody enforces is a
 * configuration key that turns a real failure into a green run, which has
 * happened in this catalog.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 32,
  maxRecords: 1000,
  maxStrategies: 32,
  maxRawBytes: 65536,
  maxValueDepth: 24,
  maxEdits: 200,
  maxSteps: 5000000,
  maxMillis: 15000,
})

const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS))

/**
 * Accept only known limits, and only as positive integers.
 *
 * An unknown key throws rather than being ignored: `--max-record` instead of
 * `--max-records` must not quietly fall back to the default and report a green
 * run over a budget nobody set.
 */
export function validateLimits(given) {
  if (given === undefined || given === null) return { ...DEFAULT_LIMITS }
  if (!isRecord(given)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(given)) {
    if (!LIMIT_NAMES.includes(key)) throw new TypeError(`Unknown limit "${String(key).slice(0, 60)}"`)
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`Limit "${key}" must be a positive integer`)
    limits[key] = value
  }
  return limits
}

/** Depth of a parsed value, counting containers. */
export function measureDepth(value, ceiling) {
  let deepest = 0
  const stack = [[value, 1]]
  while (stack.length > 0) {
    const [current, depth] = stack.pop()
    if (depth > deepest) deepest = depth
    if (deepest > ceiling) return deepest
    if (Array.isArray(current)) {
      for (const item of current) stack.push([item, depth + 1])
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) stack.push([item, depth + 1])
    }
  }
  return deepest
}

/**
 * Decode and parse one input document.
 *
 * The failure shapes are distinguished because a consumer needs to know which
 * one happened: unreadable bytes, undecodable bytes, unparseable text and a
 * document that parses into the wrong kind of thing are four different problems
 * with four different fixes. Each returns `ok: false` with a rule suffix the
 * caller prefixes with the name of the input it was reading.
 */
export function readJsonDocument(bytes, limits) {
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, rule: 'unreadable', message: 'No bytes were supplied for this input.' }
  }
  if (bytes.byteLength > limits.maxBytes) {
    return {
      ok: false,
      rule: 'too-large',
      message: `The document is ${bytes.byteLength} bytes, over the maxBytes limit of ${limits.maxBytes}.`,
      suggestion: 'Raise --max-bytes deliberately, or split the input.',
    }
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      ok: false,
      rule: 'not-utf8',
      message: 'The document is not valid UTF-8, so none of it was read.',
      suggestion: 'Re-encode the file as UTF-8.',
    }
  }
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    return {
      ok: false,
      rule: 'not-json',
      // The detail never reproduces the document; see parseFailureDetail.
      message: `The document is not valid JSON: ${parseFailureDetail(error)}.`,
      suggestion: 'Fix the JSON syntax at the reported position.',
    }
  }
  const depth = measureDepth(parsed, limits.maxDepth)
  if (depth > limits.maxDepth) {
    return {
      ok: false,
      rule: 'too-deep',
      message: `The document nests deeper than the maxDepth limit of ${limits.maxDepth}.`,
      suggestion: 'Raise --max-depth deliberately, or flatten the input.',
    }
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      rule: 'malformed',
      message: 'The document must be a JSON object at the top level.',
      suggestion: 'Wrap the content in an object with the documented keys.',
    }
  }
  return { ok: true, document: parsed }
}
