# The measurement model

## Four questions, asked in order

Each attempt is one strategy over one record, and the answers are taken in a
fixed order. Every step can end the attempt, and which step ended it is what the
scoreboard column says.

| step | ends the attempt when | rule | column |
| ---: | --- | --- | --- |
| 1 | the time budget is spent | `time-budget-exceeded` | *(record not scored)* |
| 2 | the raw response is over `maxRawBytes` | `record-too-large` | *(record not scored)* |
| 3 | the pipeline needs more than `maxEdits` or `maxSteps` | `edit-budget-exceeded`, `step-budget-exceeded` | `abandoned` |
| 4 | the repaired text does not parse | `repair-failed` | `failed` |
| 5 | the parsed value is deeper than `maxValueDepth` | `record-too-deep` | `abandoned` |
| 6 | *(not an ending)* the value contradicts the schema | `schema-violation` | not `schemaValid` |
| 7 | the value is not the labelled value | `fidelity-violation` | `altered` |
| 8 | — | — | `faithful` |

`parsed + failed + abandoned == attempted`, and `faithful + altered == parsed`.
Those two identities are asserted on every strategy in
`test/visibility.test.mjs`: a bench that dropped an inconvenient failure could
still print a plausible table, but it could not keep the columns adding up.

## Why validity and fidelity are separate columns

They answer different questions, and conflating them is the whole failure mode.

**Validity** asks whether the repaired value satisfies the contract the caller
declared. It is the check a production system would run, and it is a check a
repair can pass while being wrong.

**Fidelity** asks whether the repaired value is still what the model said. It
needs a label, which is why the corpus carries one and why an unlabelled record
is refused rather than scored.

The gap between them is exactly the set of repairs that are dangerous:

```
raw       {"note": "totals: 1,}", "n": 1,}
repaired  {"note": "totals: 1}", "n": 1}      by strip-trailing-commas
parses    yes
valid     yes -- note is a string, n is a number
faithful  NO  -- the note lost a character from inside a quoted string
```

Nothing downstream of the repair can detect this. The record is well-formed, it
type-checks, and it has been silently edited. That is why it is the only
outcome this bench treats as an `error` while a repair that simply failed is a
`warning`.

## Why the naive primitives are kept naive

`strip-trailing-commas` and `quote-bare-keys` are plain regular expressions with
no idea where a JSON string begins. That is not an unfinished implementation
waiting to be improved — improving them would delete the measurement.

The bench's purpose is to let someone compare "the regex everyone writes" with
"the scanner nobody wants to write", on their own corpus, with a number attached.
That comparison needs both halves. `test/repair.test.mjs` therefore asserts that
the naive forms really do edit the inside of a string, with a message saying so,
so a future contributor who "fixes" them is told what they broke rather than
finding a green suite.

They are also the reason the README says plainly that this is not a repair
library. Nothing here is meant to be imported and pointed at production output.

## Why latency is on stderr

Two requirements collide, and only their separation satisfies both:

- the build asks the bench to measure latency;
- the report contract requires byte-identical stdout for identical inputs, so a
  report can be diffed between machines and pasted into an issue.

A wall-clock measurement in stdout would break the second requirement on every
run, and rounding it would only make the breakage less frequent rather than
absent. So the measurement goes where the contract already puts timing — stderr
— and stdout carries `cost`, a count of work units charged by each pipeline step
against the same budget that enforces `maxSteps`. Cost is a deterministic
stand-in: the same corpus produces the same cost on any host, so two runs can be
compared, and it moves in the same direction as real work.

The measurement itself is not approximate. `benchRepairs` takes the clock as a
parameter, so `test/latency.test.mjs` asserts exact millisecond totals against a
clock that ticks once per reading — a test that asserted "took more than 0ms"
would pass against a stopped clock.

What this does mean: this is not a performance benchmark. There is no warm-up,
no repetition and no statistics, and a single run's milliseconds on a busy
machine say very little. They are there to compare strategies against each other
on one host, in one run.

## What "unknown" costs

Every unanswered question makes the whole run `incomplete` and the process exit
2, even when every other attempt was measured cleanly. That is deliberately
expensive. A corpus of two hundred records where one used an unmodelled schema
keyword is not a passing comparison with a caveat — it is a comparison where one
record's validity column is fiction, and a reader choosing a repair strategy on
the strength of that run would be choosing on a number that was never computed.

The counts stay honest about the scale: `summary.checked` says how many attempts
were genuinely scored and `summary.unknown` says how many questions were not
answered, so a reader can see that 199 of 200 were fine without the exit code
pretending all 200 were.
