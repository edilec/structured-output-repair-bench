# Structured Output Repair Bench

Compare bounded JSON repair strategies on a **labelled** corpus of malformed
model output, and measure four things per attempt: does the repaired text parse,
does it satisfy the declared schema, is it still the record that was labelled,
and how many edits did it take.

- **Repository:** [edilec/structured-output-repair-bench](https://github.com/edilec/structured-output-repair-bench)
- **Area:** Prompt & Agent Workflows
- **License:** MIT
- **Runtime:** Node 22+, no runtime dependencies, no dev dependencies, no network access

## What it does

Given a corpus of `{raw, expected}` pairs and a JSON Schema, the bench runs every
selected strategy over every record and prints a scoreboard:

```
  strategy              attempted  parsed  valid  faithful  altered  failed  edits
  strict                        5       0      0         0        0       5      0
  span                          5       2      2         2        0       3      4
  naive-regex                   5       2      2         2        0       3      3
  scanner                       5       5      5         5        0       0     11
```

`parsed` and `valid` are the numbers a repair library usually reports.
`faithful` and `altered` are the two this bench exists for.

## Why it exists

Every JSON repair routine has the same tempting shortcut: a regular expression.
`text.replace(/,(\s*[}\]])/g, '$1')` removes trailing commas in one line, works
on almost every sample you try it on, and has no idea where a JSON string
begins. Feed it a response that contains `,}` **inside** a string:

```
in    {"note": "totals: 1,}", "n": 1,}
out   {"note": "totals: 1}",  "n": 1}
```

The output parses. It satisfies a schema asking for a string. It says something
the model did not say. Nothing downstream can tell — that is what makes this the
worst failure a repair strategy has, and the reason it is the only one this tool
treats as an error.

A repair that simply *fails* is fine. It is visible, it is counted in its own
column, and you can choose a different strategy. So `repair-failed` is a
warning, `fidelity-violation` is an error, and over one corpus the strategy that
failed exits 0 while the strategy that quietly changed the data exits 1.

The corpus is labelled for exactly this reason. Without an `expected` value there
is nothing to compare a repair against, and "it parsed" becomes the whole
measurement.

## Quick start

```sh
# a corpus every strategy either repairs faithfully or fails on: exit 0
node bin/structured-output-repair-bench.mjs --corpus examples/corpus.json

# a corpus where a naive repair alters a record's meaning: exit 1
node bin/structured-output-repair-bench.mjs --corpus examples/corpus-altered.json

# custom strategies, in the order you want them compared
node bin/structured-output-repair-bench.mjs \
  --corpus examples/corpus.json \
  --pipelines examples/pipelines.json \
  --strategies strict,span-then-close,commas-only-naive

# the machine-readable report
node bin/structured-output-repair-bench.mjs --corpus examples/corpus.json --json

npm run check   # lint, tests, both runnable examples, and npm pack --dry-run
```

## Input formats

### Corpus

```json
{
  "corpusVersion": "1",
  "schema": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } },
  "records": [
    {
      "id": "fenced",
      "raw": "```json\n{\"id\": \"A-1\"}\n```",
      "expected": { "id": "A-1" }
    }
  ]
}
```

`schema` is required: a bench that reports a "schema valid" column without a
schema would be printing a number it never computed. Every record needs a unique
`id`, a `raw` response as a **string**, and an `expected` label. A record with no
label is reported as `record-unlabelled` and makes the run incomplete — it is not
scored, and it is never counted as faithful.

A label of `null`, `false`, `0` or `""` is a label. Presence is tested with
`Object.hasOwn`, not truthiness.

### Pipelines (optional)

```json
{
  "pipelinesVersion": "1",
  "strategies": [
    { "name": "span-then-close", "steps": ["strip-code-fence", "extract-json-span", "close-delimiters"] }
  ]
}
```

A step this bench does not implement is refused by name. A name that collides
with a built-in preset is refused too.

## Strategies

A strategy is an ordered pipeline of primitives. Four are built in:

| preset | steps |
| --- | --- |
| `strict` | *(none — the baseline every other number is read against)* |
| `span` | `strip-code-fence`, `extract-json-span` |
| `naive-regex` | `strip-code-fence`, `strip-trailing-commas`, `quote-bare-keys` |
| `scanner` | `strip-code-fence`, `extract-json-span`, `single-to-double-quotes`, `close-delimiters`, `strip-trailing-commas-aware` |

### Primitives

| id | string-aware | what it does |
| --- | --- | --- |
| `strip-code-fence` | n/a | removes a Markdown fence around the payload |
| `extract-json-span` | yes | keeps the first balanced top-level object or array, dropping prose |
| `strip-trailing-commas` | **no** | `,(\s*[}\]])` → `$1`, wherever it matches |
| `strip-trailing-commas-aware` | yes | the same repair, skipping commas inside strings |
| `quote-bare-keys` | **no** | quotes `{ key:` shapes, wherever it matches |
| `single-to-double-quotes` | yes | decodes single-quoted spans and re-serialises them as JSON strings |
| `close-delimiters` | yes | closes an unterminated string and the containers left open |

The two string-unaware primitives are deliberate. They are not a shortcut or an
unfinished version of the aware ones — they are the measurement. Each has an
aware counterpart so a corpus can put a number on what the difference costs, and
`test/repair.test.mjs` asserts that the naive ones really do damage a string, so
that a future "fix" cannot quietly make the comparison meaningless.

`close-delimiters` refuses to patch a dangling backslash: appending a quote after
one either gets swallowed by the escape or changes the string. The record stays
unrepaired, and visibly so.

## Measurements

| column | meaning |
| --- | --- |
| `attempted` | records this strategy was run over |
| `parsed` | repaired text `JSON.parse` accepted **and** carried forward to scoring |
| `schemaValid` | parsed values the validator checked and found to satisfy the corpus schema |
| `faithful` | parsed values structurally equal to the label |
| `altered` | parsed values **not** equal to the label — the defect |
| `failed` | attempts whose repaired text did not parse |
| `abandoned` | attempts stopped by a budget or a value limit, so never measured |
| `edits` | edits the pipeline applied |
| `cost` | deterministic work units, standing in for latency in the report |

`parsed + failed + abandoned` always equals `attempted`, and `faithful + altered`
always equals `parsed`. A dropped failure could not balance those columns, which
is how `test/visibility.test.mjs` pins that unsuccessful repairs stay visible.

Two of those definitions are narrower than they look, and both narrowings are
there because the wider reading was wrong:

- An attempt whose text parsed but nests past `maxValueDepth` is `abandoned`
  and **not** `parsed`. Counting it in both broke the identities above, on the
  one path the identity test did not reach.
- `schemaValid` counts only attempts the validator actually walked. Once the
  `maxSteps` budget is spent, validation returns no problems because it looked
  at nothing — which is not the same answer as "no problems", and starving the
  budget must never raise this column. An attempt skipped that way is named by a
  `step-budget-exceeded` finding pointing at the record and the strategy.

### Latency

Latency **is** measured, per strategy, and written to **stderr**:

```
latency: strict 0.068ms, span 0.501ms, naive-regex 0.258ms, scanner 0.508ms
```

It is deliberately absent from stdout. The report contract requires
byte-identical stdout for identical inputs so a report can be diffed between
machines, and wall-clock milliseconds differ between runs by construction. The
`cost` column is the deterministic stand-in: the same corpus produces the same
cost on any host. When you need the measurement machine-readable, call
`benchRepairs` directly — it returns `{ report, latency }`, with the clock as an
injected parameter.

## Rules

Severity comes from one frozen table; an unknown rule id throws rather than
defaulting. "Incomplete" means the rule marks the run as having a question it
could not answer, which is exit 2 rather than exit 1.

| ruleId | severity | incomplete |
| --- | --- | --- |
| corpus-empty | error | yes |
| corpus-malformed | error | yes |
| corpus-not-json | error | yes |
| corpus-not-utf8 | error | yes |
| corpus-too-deep | error | yes |
| corpus-too-large | error | yes |
| corpus-unreadable | error | yes |
| edit-budget-exceeded | error | yes |
| fidelity-violation | error | no |
| label-invalid | error | no |
| pipelines-malformed | error | yes |
| pipelines-not-json | error | yes |
| pipelines-not-utf8 | error | yes |
| pipelines-too-deep | error | yes |
| pipelines-too-large | error | yes |
| pipelines-unreadable | error | yes |
| record-malformed | error | yes |
| record-too-deep | error | yes |
| record-too-large | error | yes |
| record-unlabelled | error | yes |
| record-unrepaired | warning | no |
| repair-failed | warning | no |
| schema-unsupported | error | yes |
| schema-violation | warning | no |
| step-budget-exceeded | error | yes |
| strategy-below-floor | error | no |
| strategy-unknown | error | yes |
| time-budget-exceeded | error | yes |
| too-many-records | error | yes |
| too-many-strategies | error | yes |

The three warnings are measurements, not defects: `repair-failed` (a strategy
could not repair a record), `schema-violation` (it parsed but contradicts the
schema) and `record-unrepaired` (no selected strategy got this record back to
its label). A corpus that is hard on purpose should not fail a run for being
hard — read the scoreboard for that. A run fails when a strategy **changed** a
record, when the corpus's own label contradicts its own schema, or when a
strategy falls under an explicit `--min-fidelity` floor.

## Report

```json
{
  "schemaVersion": "1",
  "tool": "structured-output-repair-bench",
  "status": "fail",
  "summary": {
    "checked": 12, "errors": 2, "warnings": 8, "info": 0,
    "records": 3, "strategies": 4, "attempts": 12,
    "parsed": 3, "schemaValid": 2, "faithful": 1, "altered": 2,
    "failed": 9, "abandoned": 0, "edits": 5, "cost": 1280, "unknown": 0
  },
  "strategies": [
    { "strategy": "strict", "steps": [], "attempted": 3, "parsed": 0, "schemaValid": 0,
      "faithful": 0, "altered": 0, "failed": 3, "abandoned": 0, "edits": 0, "cost": 0 }
  ],
  "findings": [
    {
      "ruleId": "fidelity-violation",
      "severity": "error",
      "message": "Strategy \"naive-regex\" produced a schema-valid repair of record \"comma-inside-a-string\" that no longer matches its label at this field.",
      "location": { "file": "examples/corpus-altered.json", "pointer": "/records/0/naive-regex/note" },
      "evidence": "labelled \"totals: 1,}\", repaired to \"totals: 1}\"",
      "suggestion": "Use a string-aware repair for this shape; a repair that parses is not a repair that preserved the data."
    }
  ]
}
```

- `location.pointer` is a documented field path: `/records/<index>/<strategy>`
  for an attempt, plus the path of the offending field inside the value.
- `location.file` is always relative to the working directory, or the base name
  for an input outside it. It is never an absolute host path.
- `strategies` is in the order you selected, never sorted. A scoreboard is read
  against the order the reader chose.

Findings are ordered by `(location.file, record position, location.pointer,
ruleId, declaration order)`. Every string comparison is by UTF-16 code unit;
`localeCompare` and `Intl.Collator` consult ICU data that differs between Node
builds, so two correct machines would disagree about the order of one scoreboard.

## Exit codes

| code | meaning |
| ---: | --- |
| `0` | every strategy that repaired a record preserved its meaning |
| `1` | a repair altered a record's meaning, a label contradicts the schema, or a strategy fell under `--min-fidelity` |
| `2` | invalid usage or configuration (**stdout is empty**), or evidence that was missing, unreadable or bounded out (**stdout carries an `incomplete` report**) |

Exit 2 has two shapes on purpose. A configuration error means the run never had
a subject, so there is nothing to report about. An unreadable input means the run
had a subject and failed to obtain evidence about it, and the consumer needs the
report to know *which* input was not read. A consumer that pipes stdout must
handle an empty stdout on exit 2.

## Limits

Every limit is enforced, reachable from its own flag, and covered by a test that
drives it through the command line.

| flag | option | default | what it bounds |
| --- | --- | ---: | --- |
| `--max-bytes` | `maxBytes` | 4194304 | size of either input document |
| `--max-depth` | `maxDepth` | 32 | JSON nesting in either input document |
| `--max-records` | `maxRecords` | 1000 | corpus records |
| `--max-strategies` | `maxStrategies` | 32 | strategies in one run |
| `--max-raw-bytes` | `maxRawBytes` | 65536 | one raw model response |
| `--max-value-depth` | `maxValueDepth` | 24 | nesting in one repaired value |
| `--max-edits` | `maxEdits` | 200 | edits one attempt may apply |
| `--max-steps` | `maxSteps` | 5000000 | total repair and validation work |
| `--max-millis` | `maxMillis` | 15000 | wall-clock time budget for the run |

"Bounded" is the point of `--max-edits`. A step that would take an attempt past
the budget is **not applied partially**: the attempt is abandoned and reported,
because a half-applied repair is a third thing neither the strategy nor the
corpus describes, and putting a number next to it would be scoring a pipeline
nobody configured.

An unknown limit key or an unknown flag is a configuration error, not a default.
A one-character typo must not turn a real failure into a green run.

## What this tool does not do

- **It does not call a model.** There is no provider, no client and no network
  access. The corpus is responses you already captured.
- **It does not repair your production output.** It is a bench: read-only, and it
  writes no file. The primitives live here to be compared, not shipped as a
  library, and two of them are deliberately dangerous.
- **It is not a JSON Schema validator.** The modelled subset is `type`, `const`,
  `enum`, `required`, `properties`, `additionalProperties`, `items`,
  `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, plus
  `title` and `description` as annotations. A keyword outside it is refused by
  name and makes the run incomplete — never ignored, because an unapplied
  constraint reported as satisfied is the failure this refusal exists to
  prevent. Do not read a `schemaValid` column as "the full schema holds".
- **It does not measure fidelity beyond structural equality.** Two values are
  faithful when they are deeply equal. It has no notion of "close enough",
  numeric tolerance or semantic similarity.
- **It does not rank strategies for you.** It prints a scoreboard; which column
  matters is your decision, and the default policy only fails a run on a repair
  that changed data.
- **It does not benchmark throughput.** Latency is measured per strategy for
  comparison between strategies on one host, not as a performance benchmark: it
  includes no warm-up, no repetition and no statistics.
- **It does not judge a corpus it could not read.** Unknown evidence is
  `incomplete` and exit 2, never a pass.

## Guarantees, and the tests that would fail without them

Every claim above is pinned by a test that fails when the behaviour is removed,
not by a test that agrees with a declaration.

| guarantee | test |
| --- | --- |
| a schema-valid but altered record fails fidelity | `test/fidelity.test.mjs` |
| unsuccessful repairs stay visible, in four places | `test/visibility.test.mjs` |
| the naive primitives really are string-unaware | `test/repair.test.mjs` |
| an edit budget abandons an attempt whole | `test/repair.test.mjs`, `test/limits.test.mjs` |
| an unlabelled record is never counted as faithful | `test/fidelity.test.mjs` |
| every documented limit is enforced and wired to its flag | `test/limits.test.mjs` |
| ordering is by code unit, not collation | `test/ordering.test.mjs` |
| severity decides the exit code | `test/severity-behaviour.test.mjs` |
| unknown evidence exits 2, never 0 or 1 | `test/incompleteness.test.mjs` |
| no control, C1 or bidi character reaches output | `test/sanitising.test.mjs` |
| a parse failure never reproduces the response | `test/parse-failure.test.mjs` |
| latency is measured, and never reaches stdout | `test/latency.test.mjs`, `test/determinism.test.mjs` |
| identical inputs produce byte-identical stdout | `test/determinism.test.mjs` |

## Repository layout

- `src/` — the library
- `bin/` — the command line
- `test/` — node:test suites, no dependencies
- `examples/` — runnable corpora, including one that fails on purpose
- `docs/` — design notes and limits

## License

MIT. See [LICENSE](./LICENSE).
