import type { ToJsonSchema } from '@ark/schema'
import type { JSONSchema } from 'json-schema-typed'
import type { $ZodTypeDef, ToJSONSchemaParams } from 'zod/v4/core'
import type { StandardSchemasSpec } from '../types'
import { match } from 'ts-pattern'
import { debugLog } from '../util'

export { getSchemaMeta } from './metadata-extractor'

export function toJsonSchema({ '~standard': standardSchema }: StandardSchemasSpec) {
  debugLog(() => ['standardSchema', standardSchema])

  const zodUnrepresentableTypes: Set<$ZodTypeDef['type']> = new Set([
    'bigint',
    'symbol',
    'undefined',
    'map',
    'set',
  ])

  const libraryOptions = match(standardSchema.vendor)
    .with(
      'zod',
      () =>
        ({
          unrepresentable: 'any',

          override(ctx) {
            const zod = ctx.zodSchema._zod

            if (zod.def.type === 'date') {
              ctx.jsonSchema.type = 'integer'
              ctx.jsonSchema.format = 'epoch'
              ctx.jsonSchema.minimum = (zod.bag.minimum as Date | undefined)?.getTime()
              ctx.jsonSchema.maximum = (zod.bag.maximum as Date | undefined)?.getTime()
              return
            }

            if (zodUnrepresentableTypes.has(ctx.zodSchema._zod.def.type)) {
              ctx.jsonSchema.type = 'object'
              ctx.jsonSchema.properties = {
                __type: { const: zod.def.type },
              }
            }
          },
        }) satisfies ToJSONSchemaParams,
    )
    .with(
      'arktype',
      () =>
        ({
          fallback: {
            default: (ctx) => ({
              ...ctx.base,
              type: 'object',
              properties: {
                __type: {
                  const:
                    ctx.code === 'domain'
                      ? ctx.domain
                      : ctx.code === 'proto'
                        ? ctx.proto.name.toLowerCase()
                        : ctx.code === 'unit'
                          ? ctx.unit === undefined
                            ? 'undefined'
                            : undefined
                          : undefined,
                },
              },
            }),
            date: (ctx) => ({
              ...ctx.base,
              type: 'integer',
              format: 'epoch',
              maximum: ctx.before?.getTime(),
              minimum: ctx.after?.getTime(),
            }),
          },
        }) satisfies ToJsonSchema.Options,
    )
    .otherwise(() => undefined)

  debugLog(() => ['libraryOptions', libraryOptions])

  let jsonSchema: JSONSchema.Interface | undefined
  try {
    jsonSchema = standardSchema.jsonSchema.input({
      target: 'draft-2020-12',
      libraryOptions,
    })
    return jsonSchema
  } catch (err) {
    console.warn(
      'Failed to generate JSON Schema from Standard Schema. No schema information extraction possible.\n' +
        'Make sure your schema is compatible with JSON Schema Draft 2020-12.\n' +
        'For non-representable data types, use a transformation/serializer that maps them to representable types. (e.g. Zod Codecs)\n\n' +
        'Error details:',
      err,
    )
    return {}
  }
}
