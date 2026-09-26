# Changelog

All notable changes to this project are documented here. Rule ids are part of
the public surface: renaming one is a breaking change and is recorded here.

## 0.1.0

First implementation.

### Added

- `benchRepairs` and `benchRepairsFromFiles`, running bounded JSON repair
  strategies over a labelled corpus and measuring parse success, schema
  validity, field fidelity, edit count and latency.
- Seven repair primitives, two of them deliberately string-unaware so the cost
  of a regular-expression repair can be measured against its scanner
  counterpart, and four built-in presets composed from them.
- Custom strategy pipelines through an optional `--pipelines` document; a step
  the bench does not implement is refused by name.
- A hand-written validator over a documented subset of JSON Schema. A keyword
  outside the subset is refused, never ignored.
- A command line with `--corpus`, `--pipelines`, `--strategies`,
  `--min-fidelity`, `--json`, `--help` and nine documented limits, each wired to
  the code that enforces it.
- 30 rules with severities taken from one frozen table, and the report envelope
  described in the Edilec tool report contract v1. Latency is reported on
  stderr so that stdout stays byte-identical for identical inputs.

## Unreleased

### Fixed

- `strip-code-fence` no longer uses a quadratic regular expression. The closing
  fence was matched with `/\r?\n?[ \t]*```[ \t]*$/`, anchored only at the end,
  so the engine retried it at every index and backtracked over a run of blanks
  each time: 29 ms at 5 kB, 108 ms at 10 kB, 574 ms at 20 kB, 2175 ms at 40 kB.
  It is the first step of three of the four built-in presets, so one record at
  the documented-legal `maxRawBytes` made a run take ten seconds. A single
  backward scan replaces it, accepting exactly the same fence shapes.
- The `maxMillis` budget is sampled after the last record as well as before each
  one. It was only ever checked at the top of the per-record loop, so a budget
  blown while scoring the final record was never seen: `--max-millis 1` over one
  legal record ran for twelve seconds and reported `pass`, exit 0, no findings.
- `parsed + failed + abandoned == attempted` and `faithful + altered == parsed`
  hold on the `record-too-deep` path. An attempt that parsed and then exceeded
  `maxValueDepth` was counted in `parsed` and in `abandoned`, so both documented
  identities were false on that path. `parsed` now counts attempts carried
  forward to scoring.
- A spent `maxSteps` budget no longer inflates `schemaValid`. Validation
  short-circuits once the budget is spent and returns no problems, which the
  scoreboard read as "satisfied the schema"; starving the budget raised the
  column from 1 to 2, counting a value that contradicts the schema. An attempt
  the validator never walked is not counted, and is named by a
  `step-budget-exceeded` finding pointing at the record and the strategy.
- A budget or depth limit reached during validation is reported under its own
  rule (`step-budget-exceeded`, `record-too-deep`) instead of under
  `schema-unsupported`, which named the wrong cause and the wrong remedy.
- The remedy moves with the rule id. The rule was split out and the
  `suggestion` string was left behind at both reporting sites, so a
  `step-budget-exceeded` finding still advised "Express the constraint with a
  modelled keyword" — the rewrite-your-schema advice the split exists to stop,
  now under a rule id that contradicts it. Budget problems advise raising
  `--max-steps` and depth problems advise raising `--max-value-depth`;
  `test/remedy.test.mjs` pins all of it on the emitted findings, including the
  case where an unmodelled keyword must keep the schema remedy.
