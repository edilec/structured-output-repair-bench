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
