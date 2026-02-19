import type { JSONSchema7TypeName } from 'json-schema'
import type { JsonSchema } from 'json-schema-library'
import type { FieldOpts } from './field'
import type { SchemaMeta } from './types'
import { compileSchema } from 'json-schema-library'
import * as R from 'remeda'
import { match } from 'ts-pattern'
import { getProperty } from './util'

function matchSchemaType(type: JSONSchema7TypeName, value: unknown) {
  return match(type)
    .with('string', () => typeof value === 'string')
    .with('number', () => typeof value === 'number')
    .with('integer', () => typeof value === 'number' && Number.isInteger(value))
    .with('boolean', () => typeof value === 'boolean')
    .with('array', () => Array.isArray(value))
    .with('object', () => typeof value === 'object' && value !== null && !Array.isArray(value))
    .with('null', () => value === null)
    .exhaustive()
}

export function getSchemaMeta(
  jsonSchema: JsonSchema,
  data: object,
  path: string,
  _fieldOpts?: FieldOpts,
): SchemaMeta {
  const pointer = `#/${path.replaceAll('[', '.').replaceAll(']', '').split('.').join('/')}`
  const schema = compileSchema(jsonSchema)
  console.debug('getSchemaMeta', {
    schema,
    pointer,
    data: JSON.stringify(data),
  })

  const { node, error } = schema.getNode(pointer)
  if (error || !node) {
    console.warn(`Failed to get JSON Schema node for path '${pointer}':`, error)
    return {}
  }

  let reducedSchema: JsonSchema | undefined = node.schema

  const value = getProperty(data, path)
  console.debug('value', { value, schema: node.schema })

  const { node: reducedNode, error: reduceError } = node.reduceNode(value)
  if (reduceError || !reducedNode) {
    console.warn(`Failed to reduce JSON Schema node for path '${pointer}':`, reduceError)
    return {}
  }
  reducedSchema = reducedNode.schema
  console.debug('reducedSchema', reducedSchema)

  if (R.isEmpty(reducedSchema) && (node.anyOf || node.oneOf)) {
    const of = node.anyOf ? 'anyOf' : 'oneOf'
    const matchingType = node.schema[of]
      ?.filter(R.isObjectType)
      .find(
        (s) =>
          s.type &&
          (Array.isArray(s.type)
            ? s.type.some((t) => matchSchemaType(t, value))
            : matchSchemaType(s.type, value)),
      )
    console.debug('fallback reducedSchema', node.schema[of], matchingType)

    reducedSchema = matchingType
  }

  const isNullable = node.validate(null).valid
  const parentSchema = node.parent?.schema
  const propertyName = node.schemaLocation.split('/').pop()!
  const required = !parentSchema || (!!parentSchema.required?.includes(propertyName) && !isNullable)

  return {
    required,
    ...R.pick(reducedSchema ?? {}, [
      'title',
      'description',
      'default',
      'examples',
      'minimum',
      'exclusiveMinimum',
      'maximum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'id',
    ]),
  }
}
