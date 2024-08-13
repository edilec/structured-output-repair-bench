/**
 * The repair primitives, and the bounded pipelines built from them.
 *
 * Two of these primitives are deliberately the NAIVE, string-unaware form --
 * `strip-trailing-commas` and `quote-bare-keys` are plain regular expressions
 * that do not know where a JSON string begins. They are not a shortcut. They
 * are the thing the bench exists to measure: a regular expression that reaches
 * inside a string edits DATA while producing text that parses, and the result
 * is a record that looks repaired and is not. Each has a string-aware
 * counterpart, so a corpus can show what the difference costs.
 *
 * Every primitive is a pure function of its text. None reads the clock, the
 * environment, the filesystem or a locale, and none is a regular expression
 * whose work can grow faster than the length of its input -- a claim that is
 * now measured by `test/complexity.test.mjs` rather than asserted here, because
 * the closing-fence pattern this comment used to sit above was quadratic.
 */

/** Every primitive, by the id a pipeline names it with. */
export const PRIMITIVE_IDS = Object.freeze([
  'close-delimiters',
  'extract-json-span',
  'quote-bare-keys',
  'single-to-double-quotes',
  'strip-code-fence',
  'strip-trailing-commas',
  'strip-trailing-commas-aware',
])

/**
 * One pass over the text, tracking JSON string context.
 *
 * `inString[i]` is 1 when the character at `i` belongs to a double-quoted
 * string, the quotes included. `openers` holds the closers still owed at the
 * end, outermost first. `start` and `end` bracket the first balanced top-level
 * object or array.
 *
 * This is shared by every string-AWARE primitive, and is exactly what the two
 * naive primitives do not consult.
 */
export function analyse(text) {
  const inString = new Uint8Array(text.length)
  const openers = []
  let start = -1
  let end = -1
  let insideString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (insideString) {
      inString[index] = 1
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') insideString = false
      continue
    }
    if (character === '"') {
      insideString = true
      inString[index] = 1
    } else if (character === '{' || character === '[') {
      if (openers.length === 0 && start === -1) start = index
      openers.push(character === '{' ? '}' : ']')
    } else if (character === '}' || character === ']') {
      if (openers.length > 0 && openers[openers.length - 1] === character) {
        openers.pop()
        if (openers.length === 0 && start !== -1 && end === -1) end = index + 1
      }
    }
  }
  return { inString, openers, endedInString: insideString, danglingEscape: escaped, start, end }
}

/*
 * `FENCE_OPEN` is anchored with `^`, so the engine tries exactly one starting
 * position and the whole match is linear in the text it consumes.
 *
 * There is deliberately no `FENCE_CLOSE` regular expression beside it. The
 * obvious one, `/\r?\n?[ \t]*```[ \t]*$/`, is anchored only at the END: the
 * engine retries it at every index, and at each index the greedy `[ \t]*` walks
 * to the end of a run of spaces and backtracks over all of it before failing.
 * That is quadratic, and measured here rather than feared -- on a payload whose
 * only content is a run of spaces it took 29 ms at 5 kB, 108 ms at 10 kB,
 * 574 ms at 20 kB and 2175 ms at 40 kB, four times the work for twice the
 * input. A single record at the documented-legal maxRawBytes made the whole
 * bench take ten seconds, in three of the four built-in presets, because
 * `strip-code-fence` is their first step.
 */
const FENCE_OPEN = /^[ \t]*```[A-Za-z0-9_+-]*[ \t]*\r?\n?/

const isBlank = (character) => character === ' ' || character === '\t'

/**
 * Where a trailing ``` fence begins, or -1.
 *
 * One backward scan, each character visited at most once. It accepts exactly
 * what `/\r?\n?[ \t]*```[ \t]*$/` accepted: blanks to the end, the three
 * backticks, blanks before them, then an optional line break which may be
 * "\n", "\r\n" or a lone "\r".
 */
function closingFenceStart(text) {
  let end = text.length
  while (end > 0 && isBlank(text[end - 1])) end -= 1
  if (end < 3 || text[end - 1] !== '`' || text[end - 2] !== '`' || text[end - 3] !== '`') return -1
  let start = end - 3
  while (start > 0 && isBlank(text[start - 1])) start -= 1
  if (start > 0 && text[start - 1] === '\n') start -= 1
  if (start > 0 && text[start - 1] === '\r') start -= 1
  return start
}

/** Remove a Markdown code fence wrapped around the payload. */
function stripCodeFence(text) {
  let edits = 0
  let out = text.trim()
  if (FENCE_OPEN.test(out)) {
    out = out.replace(FENCE_OPEN, '')
    edits += 1
  }
  const closing = closingFenceStart(out)
  if (closing !== -1) {
    out = out.slice(0, closing)
    edits += 1
  }
  return { text: edits === 0 ? text : out, edits }
}

/** Keep the first balanced top-level object or array, dropping prose around it. */
function extractJsonSpan(text) {
  const state = analyse(text)
  if (state.start === -1) return { text, edits: 0 }
  const end = state.end === -1 ? text.length : state.end
  const edits = (state.start > 0 ? 1 : 0) + (end < text.length ? 1 : 0)
  return { text: edits === 0 ? text : text.slice(state.start, end), edits }
}

/**
 * The naive trailing-comma strip: a regular expression with no idea where a
 * string starts.
 *
 * A record whose own text contains `,}` inside a string -- `{"note": "total:
 * 1,}"}` -- has that comma deleted too. The result parses, satisfies a schema
 * that asks for a string, and no longer says what the model said. That is the
 * measurement this primitive exists to provide, not a bug to fix here.
 */
function stripTrailingCommasNaive(text) {
  let edits = 0
  const out = text.replace(/,(\s*[}\]])/g, (match, tail) => {
    edits += 1
    return tail
  })
  return { text: out, edits }
}

/** The same repair, aware of string context: a comma inside a string is data. */
function stripTrailingCommasAware(text) {
  const state = analyse(text)
  let out = ''
  let edits = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === ',' && state.inString[index] === 0) {
      let ahead = index + 1
      while (ahead < text.length && state.inString[ahead] === 0 && /\s/.test(text[ahead])) ahead += 1
      if (ahead < text.length && state.inString[ahead] === 0 && (text[ahead] === '}' || text[ahead] === ']')) {
        edits += 1
        continue
      }
    }
    out += text[index]
  }
  return { text: out, edits }
}

/**
 * The naive bare-key quoter: another regular expression with no string context.
 *
 * It quotes `{ total: 1 }` into `{ "total": 1 }`, and it also rewrites the
 * inside of `{"note": "see total: 1"}` because `, total:` looks the same to it.
 */
function quoteBareKeysNaive(text) {
  let edits = 0
  const out = text.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, (match, before, key, after) => {
    edits += 1
    return `${before}"${key}"${after}`
  })
  return { text: out, edits }
}

const UNESCAPE = new Map([
  ['b', String.fromCharCode(8)],
  ['f', String.fromCharCode(12)],
  ['n', String.fromCharCode(10)],
  ['r', String.fromCharCode(13)],
  ['t', String.fromCharCode(9)],
])

/**
 * Rewrite single-quoted strings as JSON strings.
 *
 * The span is DECODED first and re-serialised with `JSON.stringify`, rather
 * than having its quotes swapped in place. Swapping in place is how a naive
 * converter turns `'it''s'` into text that no longer parses, or silently drops
 * an escape; decoding and re-serialising cannot, because the escaping is done
 * by the same function that will have to read it back.
 *
 * An unterminated single-quoted span is left exactly as it is: guessing where
 * it ended would be inventing content.
 */
function singleToDoubleQuotes(text) {
  let out = ''
  let edits = 0
  let index = 0
  let insideDouble = false
  let escaped = false
  while (index < text.length) {
    const character = text[index]
    if (insideDouble) {
      out += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') insideDouble = false
      index += 1
      continue
    }
    if (character === '"') {
      insideDouble = true
      out += character
      index += 1
      continue
    }
    if (character !== "'") {
      out += character
      index += 1
      continue
    }
    let cursor = index + 1
    let decoded = ''
    let pendingEscape = false
    let closed = false
    while (cursor < text.length) {
      const inner = text[cursor]
      if (pendingEscape) {
        decoded += UNESCAPE.get(inner) ?? inner
        pendingEscape = false
        cursor += 1
        continue
      }
      if (inner === '\\') {
        pendingEscape = true
        cursor += 1
        continue
      }
      if (inner === "'") {
        closed = true
        cursor += 1
        break
      }
      decoded += inner
      cursor += 1
    }
    if (!closed) {
      out += text.slice(index)
      break
    }
    out += JSON.stringify(decoded)
    edits += 1
    index = cursor
  }
  return { text: out, edits }
}

/**
 * Close what a truncated response left open.
 *
 * A dangling backslash is refused rather than patched: appending a quote after
 * it would either be swallowed by the escape or change the string's content,
 * and both are worse than leaving the record unrepaired and visible.
 */
function closeDelimiters(text) {
  const state = analyse(text)
  if (state.danglingEscape) return { text, edits: 0 }
  let out = text
  let edits = 0
  if (state.endedInString) {
    out += '"'
    edits += 1
  }
  for (let index = state.openers.length - 1; index >= 0; index -= 1) {
    out += state.openers[index]
    edits += 1
  }
  return { text: out, edits }
}

const PRIMITIVES = Object.freeze({
  'close-delimiters': closeDelimiters,
  'extract-json-span': extractJsonSpan,
  'quote-bare-keys': quoteBareKeysNaive,
  'single-to-double-quotes': singleToDoubleQuotes,
  'strip-code-fence': stripCodeFence,
  'strip-trailing-commas': stripTrailingCommasNaive,
  'strip-trailing-commas-aware': stripTrailingCommasAware,
})

/**
 * The strategies this tool ships, in the order they are worth comparing.
 *
 * `strict` repairs nothing. It is not a filler entry: it is the baseline every
 * other number has to be read against, because a corpus where `strict` already
 * parses 90% of records says nothing about the repairs.
 */
export const PRESETS = Object.freeze({
  strict: Object.freeze([]),
  span: Object.freeze(['strip-code-fence', 'extract-json-span']),
  'naive-regex': Object.freeze(['strip-code-fence', 'strip-trailing-commas', 'quote-bare-keys']),
  scanner: Object.freeze([
    'strip-code-fence',
    'extract-json-span',
    'single-to-double-quotes',
    'close-delimiters',
    'strip-trailing-commas-aware',
  ]),
})

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS))

/**
 * Run one pipeline over one raw response, under the run's shared budgets.
 *
 * A step that would take the attempt past `maxEdits` is NOT applied partially.
 * The attempt is abandoned and reported, because a half-applied repair is a
 * third thing that neither the strategy nor the corpus describes -- and
 * measuring it would put a number next to a pipeline nobody configured.
 */
export function runPipeline(steps, raw, limits, meter) {
  let text = raw
  let edits = 0
  for (const step of steps) {
    meter.steps += text.length + 1
    if (meter.steps > limits.maxSteps) {
      return { ok: false, reason: 'step-budget', step, text, edits }
    }
    const applied = PRIMITIVES[step](text)
    if (edits + applied.edits > limits.maxEdits) {
      return { ok: false, reason: 'edit-budget', step, text, edits }
    }
    text = applied.text
    edits += applied.edits
  }
  return { ok: true, text, edits }
}
