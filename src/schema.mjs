/**
 * What a repaired value is checked against, and how two values are compared.
 *
 * Two jobs live here because a repair bench asks two different questions of the
 * same value: "does it satisfy the schema the caller declared?" (validity) and
 * "is it still the record we labelled?" (fidelity). They are not the same
 * question, and a repair that passes the first while failing the second is the
 * exact defect this tool exists to surface.
 *
 * The validator models a deliberately small subset of JSON Schema. It is
 * hand-written: this catalog installs nothing, so there is no `ajv` here and no
 * attempt to imitate one. A keyword outside the subset is REFUSED by name and
 * makes the run incomplete. Silently ignoring an unmodelled keyword would let a
 * repaired record be reported as schema-valid on a constraint nobody checked.
 */

import { byCodeUnit, renderValue } from './text.mjs'

/**
 * Every keyword this validator models. A keyword outside this set is refused by
 * name. `description` and `title` annotate rather than constrain, so modelling
 * them means accepting them and checking nothing -- which is what listing them
 * here does.
 */
export const SUPPORTED_KEYWORDS = Object.freeze([
  'additionalProperties',
  'const',
  'description',
  'enum',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'properties',
  'required',
  'title',
  'type',
])

/** The type names this validator understands. `integer` is checked as an integral number. */
export const SUPPORTED_TYPES = Object.freeze(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(value, name) {
  if (name === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (name === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeOf(value) === name
}

/**
 * Structural equality that reports WHERE two values first differ.
 *
 * This is the fidelity measurement. Reporting "these differ" without saying
 * where would leave whoever reads the bench to diff two documents by hand,
 * which is the work the bench exists to do.
 *
 * Object keys are walked in code-unit order so the reported position is a
 * property of the two values and not of the order V8 handed the keys back.
 */
export function firstDifference(left, right, path = []) {
  const leftType = typeOf(left)
  const rightType = typeOf(right)
  if (leftType !== rightType) return { path, left, right }
  if (leftType === 'array') {
    const shared = Math.min(left.length, right.length)
    for (let index = 0; index < shared; index += 1) {
      const nested = firstDifference(left[index], right[index], [...path, String(index)])
      if (nested !== null) return nested
    }
    if (left.length !== right.length) return { path, left, right }
    return null
  }
  if (leftType === 'object') {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(byCodeUnit)
    for (const key of keys) {
      const hasLeft = Object.hasOwn(left, key)
      const hasRight = Object.hasOwn(right, key)
      if (!hasLeft || !hasRight) {
        return { path: [...path, key], left: hasLeft ? left[key] : undefined, right: hasRight ? right[key] : undefined }
      }
      const nested = firstDifference(left[key], right[key], [...path, key])
      if (nested !== null) return nested
    }
    return null
  }
  // NaN never reaches here from JSON, and -0 and 0 are the same parsed number.
  if (left === right) return null
  return { path, left, right }
}

/** Whether two values are structurally equal. */
export function deepEqual(left, right) {
  return firstDifference(left, right) === null
}

function problem(kind, path, message) {
  return { kind, path, message }
}

/**
 * Check one value against one schema.
 *
 * `kind` separates two very different facts:
 *
 * - `mismatch` -- the value contradicts a constraint this validator applied.
 *   That is knowledge, and it counts against the strategy.
 * - `unsupported` or `schema` -- the validator could not apply the constraint.
 *   That is the absence of knowledge, and the caller must not record the
 *   attempt as schema-valid.
 *
 * `budget` is shared across a whole run when the caller supplies one, so the
 * documented `maxSteps` ceiling bounds the total work of a bench rather than
 * the work of each validation separately.
 */
export function validateAgainstSchema(value, schema, limits, budget = { steps: 0, spent: false }) {
  const problems = []
  walk(value, schema, [], problems, budget, limits, 1)
  return problems
}

function walk(value, schema, path, problems, budget, limits, depth) {
  if (budget.spent) return
  budget.steps += 1
  if (budget.steps > limits.maxSteps) {
    budget.spent = true
    problems.push(problem('budget', path, `Validation passed the maxSteps budget of ${limits.maxSteps}.`))
    return
  }
  if (depth > limits.maxValueDepth) {
    problems.push(problem('depth', path, `The value nests deeper than the maxValueDepth limit of ${limits.maxValueDepth}.`))
    return
  }
  if (!isRecord(schema)) {
    problems.push(problem('schema', path, 'The schema at this position is not a JSON object.'))
    return
  }

  for (const keyword of Object.keys(schema).sort(byCodeUnit)) {
    if (!SUPPORTED_KEYWORDS.includes(keyword)) {
      problems.push(problem('unsupported', path, `The schema keyword "${keyword}" is not modelled by this validator.`))
    }
  }

  if (Object.hasOwn(schema, 'type')) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type]
    const unknown = declared.filter((name) => !SUPPORTED_TYPES.includes(name))
    if (unknown.length > 0 || declared.length === 0) {
      problems.push(problem('schema', path, `The schema declares a type this validator does not model: ${renderValue(schema.type, 60)}.`))
      return
    }
    if (!declared.some((name) => matchesType(value, name))) {
      problems.push(problem('mismatch', path, `Expected ${declared.join(' or ')} but found ${typeOf(value)}.`))
      return
    }
  }

  if (Object.hasOwn(schema, 'const') && !deepEqual(value, schema.const)) {
    problems.push(problem('mismatch', path, `Expected the constant ${renderValue(schema.const, 60)} but found ${renderValue(value, 60)}.`))
  }
  if (Object.hasOwn(schema, 'enum')) {
    if (!Array.isArray(schema.enum)) {
      problems.push(problem('schema', path, 'The "enum" keyword must be an array.'))
    } else if (!schema.enum.some((candidate) => deepEqual(value, candidate))) {
      problems.push(problem('mismatch', path, `The value ${renderValue(value, 60)} is not one of the ${schema.enum.length} enumerated value(s).`))
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      problems.push(problem('mismatch', path, `The string is ${value.length} character(s), under minLength ${schema.minLength}.`))
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      problems.push(problem('mismatch', path, `The string is ${value.length} character(s), over maxLength ${schema.maxLength}.`))
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      problems.push(problem('mismatch', path, `The number ${value} is below minimum ${schema.minimum}.`))
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      problems.push(problem('mismatch', path, `The number ${value} is above maximum ${schema.maximum}.`))
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      problems.push(problem('mismatch', path, `The array holds ${value.length} item(s), under minItems ${schema.minItems}.`))
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      problems.push(problem('mismatch', path, `The array holds ${value.length} item(s), over maxItems ${schema.maxItems}.`))
    }
    if (Object.hasOwn(schema, 'items')) {
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], schema.items, [...path, String(index)], problems, budget, limits, depth + 1)
        if (budget.spent) return
      }
    }
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? [...schema.required].sort(byCodeUnit) : []
    for (const key of required) {
      if (!Object.hasOwn(value, key)) {
        problems.push(problem('mismatch', [...path, String(key)], `The required property "${key}" is absent.`))
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const key of Object.keys(value).sort(byCodeUnit)) {
      if (Object.hasOwn(properties, key)) {
        walk(value[key], properties[key], [...path, key], problems, budget, limits, depth + 1)
        if (budget.spent) return
      } else if (schema.additionalProperties === false) {
        problems.push(problem('mismatch', [...path, key], `The property "${key}" is not declared and additionalProperties is false.`))
      } else if (isRecord(schema.additionalProperties)) {
        walk(value[key], schema.additionalProperties, [...path, key], problems, budget, limits, depth + 1)
        if (budget.spent) return
      }
    }
  }
}
