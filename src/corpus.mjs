/**
 * The labelled corpus, and the optional pipeline definitions.
 *
 * A corpus is model output: the least trustworthy input a tool in this catalog
 * handles, because every byte of it is text a language model emitted. None of
 * it is an instruction here. A record that asks, in its own text, for a
 * different verdict is a record, and the only thing this module does with it is
 * check that it has an id, a raw response and a label.
 *
 * A record with no label is not scored. Fidelity is a comparison against the
 * labelled value, and there is nothing to compare an unlabelled record with --
 * so it becomes a question the run could not answer, never a record that
 * happened to pass.
 */

import { renderValue } from './text.mjs'
import { PRESET_NAMES, PRIMITIVE_IDS } from './repair.mjs'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fault(parts, message, suggestion) {
  return { parts, message, suggestion }
}

/**
 * Validate the corpus envelope and every record in it.
 *
 * The schema is required. A bench that measures "schema validity" without a
 * schema would be reporting a number it never computed, so a corpus that omits
 * one is refused rather than scored on fidelity alone.
 */
export function readCorpus(document, limits) {
  if (document.corpusVersion !== '1') {
    return {
      records: [],
      schema: null,
      envelopeFaults: [fault(
        ['corpusVersion'],
        `The corpus declares version ${renderValue(document.corpusVersion, 40)}; this bench reads version "1".`,
        'Set "corpusVersion" to "1".',
      )],
      recordFaults: [],
      unlabelled: [],
      declared: 0,
    }
  }
  if (!isRecord(document.schema)) {
    return {
      records: [],
      schema: null,
      envelopeFaults: [fault(
        ['schema'],
        'The corpus must declare a "schema" object; schema validity cannot be measured without one.',
        'Add the schema every labelled record is expected to satisfy.',
      )],
      recordFaults: [],
      unlabelled: [],
      declared: 0,
    }
  }
  if (!Array.isArray(document.records)) {
    return {
      records: [],
      schema: null,
      envelopeFaults: [fault(['records'], 'The corpus must declare "records" as an array.', 'List the labelled records.')],
      recordFaults: [],
      unlabelled: [],
      declared: 0,
    }
  }
  if (document.records.length > limits.maxRecords) {
    return {
      records: [],
      schema: null,
      envelopeFaults: [fault(
        ['records'],
        `The corpus holds ${document.records.length} records, over the maxRecords limit of ${limits.maxRecords}; none were scored.`,
        'Raise --max-records deliberately, or split the corpus.',
      )],
      recordFaults: [],
      unlabelled: [],
      declared: document.records.length,
      overRecordLimit: true,
    }
  }

  const records = []
  const recordFaults = []
  const unlabelled = []
  const seen = new Set()
  for (let index = 0; index < document.records.length; index += 1) {
    const raw = document.records[index]
    const parts = ['records', String(index)]
    if (!isRecord(raw)) {
      recordFaults.push({ index, ...fault(parts, 'A corpus record must be a JSON object.', 'Replace the entry with a record object.') })
      continue
    }
    const problems = []
    if (typeof raw.id !== 'string' || raw.id === '') {
      problems.push(fault([...parts, 'id'], 'A record must carry a non-empty string "id".', 'Give every record a stable id.'))
    } else if (seen.has(raw.id)) {
      problems.push(fault([...parts, 'id'], `The record id ${renderValue(raw.id, 60)} appears more than once; a finding against it would not be addressable.`, 'Give every record a distinct id.'))
    }
    if (typeof raw.raw !== 'string') {
      problems.push(fault([...parts, 'raw'], 'A record must carry the model response as a string in "raw".', 'Store the response verbatim, as text.'))
    }
    if (problems.length > 0) {
      for (const problem of problems) recordFaults.push({ index, ...problem })
      continue
    }
    seen.add(raw.id)
    if (!Object.hasOwn(raw, 'expected')) {
      // Not a malformed record -- an unlabelled one. It is reported separately
      // because the difference matters: this record could have been scored, and
      // was not, for want of the one thing fidelity is measured against.
      unlabelled.push({ index, parts, id: raw.id })
      continue
    }
    records.push({ index, parts, id: raw.id, raw: raw.raw, expected: raw.expected })
  }
  return { records, schema: document.schema, envelopeFaults: [], recordFaults, unlabelled, declared: document.records.length }
}

/**
 * Validate a pipeline definition document.
 *
 * A step this tool does not implement is refused by name. Accepting it and
 * skipping it would put a number next to a strategy that never ran the repair
 * its own definition claims.
 */
export function readPipelines(document) {
  if (document.pipelinesVersion !== '1') {
    return {
      strategies: [],
      faults: [fault(
        ['pipelinesVersion'],
        `The pipeline document declares version ${renderValue(document.pipelinesVersion, 40)}; this bench reads version "1".`,
        'Set "pipelinesVersion" to "1".',
      )],
    }
  }
  if (!Array.isArray(document.strategies)) {
    return { strategies: [], faults: [fault(['strategies'], 'The pipeline document must declare "strategies" as an array.', 'List the strategies to define.')] }
  }
  const strategies = []
  const faults = []
  const seen = new Set()
  for (let index = 0; index < document.strategies.length; index += 1) {
    const entry = document.strategies[index]
    const parts = ['strategies', String(index)]
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') {
      faults.push(fault(parts, 'Each strategy must be an object with a non-empty "name".', 'Name the strategy.'))
      continue
    }
    if (PRESET_NAMES.includes(entry.name)) {
      faults.push(fault([...parts, 'name'], `The name "${entry.name}" is a built-in preset and cannot be redefined.`, `Choose a name outside: ${PRESET_NAMES.join(', ')}.`))
      continue
    }
    if (seen.has(entry.name)) {
      faults.push(fault([...parts, 'name'], `The strategy ${renderValue(entry.name, 60)} is declared more than once.`, 'Remove the duplicate.'))
      continue
    }
    if (!Array.isArray(entry.steps)) {
      faults.push(fault([...parts, 'steps'], 'A strategy must declare "steps" as an array, which may be empty.', 'List the repair steps in the order they run.'))
      continue
    }
    const unknown = entry.steps.filter((step) => typeof step !== 'string' || !PRIMITIVE_IDS.includes(step))
    if (unknown.length > 0) {
      faults.push(fault(
        [...parts, 'steps'],
        `The strategy ${renderValue(entry.name, 40)} names ${unknown.length} step(s) this bench does not implement, beginning with ${renderValue(unknown[0], 40)}.`,
        `Use one of: ${PRIMITIVE_IDS.join(', ')}.`,
      ))
      continue
    }
    seen.add(entry.name)
    strategies.push({ name: entry.name, steps: [...entry.steps] })
  }
  return { strategies, faults }
}
