/**
 * Decoding, ordering, sanitising and rendering primitives.
 *
 * Nothing here reads the filesystem, the clock, the locale, the environment or
 * the network. Every export is a pure function of its arguments, which is what
 * lets one corpus produce byte-identical output on any host, on any Node build,
 * under any locale.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both consult ICU collation data that
 * differs between Node builds and platforms, so two correct machines disagree
 * about the order of the same scoreboard. The difference is reachable from a
 * corpus: a collator folds case, putting `assets` before `README`, and weighs
 * `-` and `_` differently from their code points, putting `a_b` before `a-b`.
 *
 * Pinning this helper in isolation pins nothing but this helper, because every
 * call site can still be swapped one at a time. `test/ordering.test.mjs` pins
 * the call sites instead, through the real entry point, on identifiers whose
 * collated order genuinely differs from their code-unit order.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the point. Decoding leniently and then hunting for U+FFFD
 * cannot tell undecodable bytes apart from a corpus that legitimately contains
 * a replacement character -- and a corpus of malformed model output is exactly
 * where a replacement character shows up on purpose. The decoder decides; the
 * decoded text never gets a vote.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Characters removed from every input-derived string on its way to output.
 *
 * Built from code points rather than written literally, because a literal
 * U+2028 in a module is itself a hazard -- it terminates a line for a
 * JavaScript parser, and one has already broken a module at load in this
 * catalog. Each class forges or hides something in output a person reads:
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F): a bare newline forges a whole
 *   report line; the rest drive a terminal.
 * - **C1** (U+0080-U+009F): U+0085 is NEL, which starts a new line on a
 *   terminal exactly as a newline does, and U+009B is the 8-bit CSI, which
 *   opens an escape sequence. Neither is ECMAScript whitespace and neither is
 *   escaped by `JSON.stringify`, so a filter that stops at C0 lets both through
 *   intact.
 * - **U+2028 and U+2029**: they terminate a line for a JavaScript consumer and
 *   `JSON.stringify` does not escape them either.
 * - **Bidi controls** (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): U+202E
 *   reverses the text displayed after it, so a record called one thing is read
 *   as another; the isolates hide what they wrap.
 *
 * This applies to identifiers, not only to excerpts. A record id, a strategy
 * name, a field path and a source label are all strings whoever wrote the
 * corpus chose, and every one of them reaches a pointer or a message. A corpus
 * of MODEL OUTPUT is the least trustworthy input imaginable: its whole content
 * is text a language model emitted, and none of it is an instruction here.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}${String.fromCharCode(12)}`
  + `${String.fromCharCode(14)}-${String.fromCharCode(31)}`
  + `${String.fromCharCode(127)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)

/** Bounds on what any one input-derived string may contribute to output. */
export const EXCERPT_LIMIT = 200
export const MESSAGE_LIMIT = 400
export const LABEL_LIMIT = 120

/**
 * A bounded, single-line, control-free rendering of an input-derived string.
 *
 * Every string that came out of a corpus passes through here on its way to the
 * report: record ids, strategy names, field paths, messages and evidence.
 * Sanitising only an excerpt field has already let an identifier carrying a
 * newline forge whole lines elsewhere in this catalog.
 */
export function sanitize(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Sanitise limit must be a positive integer')
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * A JSON Pointer built from already-sanitised segments.
 *
 * RFC 6901 escaping is applied after sanitising, so a record id containing a
 * slash addresses one segment rather than silently becoming two.
 */
export function reportPointer(parts) {
  if (parts.length === 0) return ''
  return `/${parts.map((part) => sanitize(part, LABEL_LIMIT).split('~').join('~0').split('/').join('~1')).join('/')}`
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. An offset says nothing about content, so it is safe. */
const PARSE_POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input back. Recognised FIRST: a record whose own
 * text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for the
 * offset first finds that phrase INSIDE the quoted span and slices the record
 * straight back out. The `s` flag matters too: the quoted span can contain a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it is
 * there to catch.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = PARSE_POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say why a document would not parse, without reproducing any of it.
 *
 * This tool parses malformed text on purpose, hundreds of times per run, and
 * every one of those failures is reported. That makes the leak below not a
 * corner case but the main path.
 *
 * V8 reports a JSON parse failure two ways, and one of them quotes the input
 * back: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A
 * model response short enough to be nothing but a credential is therefore
 * reproduced in full by its own error message. `sanitize` does not help: it
 * strips control characters and cuts from the END, and the quoted snippet sits
 * at the FRONT.
 *
 * The position is the useful half and carries no content, so it is kept -- it
 * is also the single most useful number a repair bench can report about a
 * failure. The quoted half is the input and never leaves this function.
 *
 * The closing guard is deliberate belt and braces, and it is why this function
 * is safe against wordings it has never seen: across 500,206 distinct V8 parse
 * messages, every one that carries no quoted snippet also carries no double
 * quote at all -- V8 quotes JSON punctuation with apostrophes. So a double
 * quote surviving to the end means a snippet survived, whatever the branch
 * logic above concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/**
 * Render a parsed value for the `evidence` field.
 *
 * `JSON.stringify` escapes C0 inside strings but leaves U+2028, U+2029 and the
 * bidi controls intact, and it does not touch a key at all, so the result still
 * goes through `sanitize`.
 */
export function renderValue(value, limit = EXCERPT_LIMIT) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return sanitize(text === undefined ? 'undefined' : text, limit)
}
