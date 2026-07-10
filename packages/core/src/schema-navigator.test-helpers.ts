/* eslint-disable ts/no-unsafe-member-access, ts/no-unsafe-assignment, ts/no-unsafe-return, ts/no-unsafe-call, ts/no-unsafe-argument -- mirrors core.ts's untyped zod/arktype JSON-schema-generation callbacks */
import type { JSONSchema7 } from 'json-schema'
import { match } from 'ts-pattern'

/**
 * Replicates the exact JSON-schema generation that core.ts (`useFormCore`) does,
 * so tests exercise the same shapes production feeds to getSchemaMeta.
 */
export function genJsonSchema(schema: { '~standard': any }): JSONSchema7 {
  const standardSchema = schema['~standard']

  const zodUnrepresentableTypes = new Set([
    'bigint',
    'symbol',
    'undefined',
    'void',
    'date',
    'map',
    'set',
    'transform',
    'nan',
    'custom',
  ])

  const libraryOptions = match(standardSchema.vendor)
    .with('zod', () => ({
      unrepresentable: 'any',
      override(ctx: any) {
        const zod = ctx.zodSchema._zod
        if (zod.def.type === 'date') {
          ctx.jsonSchema.type = 'integer'
          ctx.jsonSchema.format = 'epoch'
          ctx.jsonSchema.minimum = zod.bag.minimum?.getTime()
          ctx.jsonSchema.maximum = zod.bag.maximum?.getTime()
          return
        }
        if (zodUnrepresentableTypes.has(zod.def.type)) {
          ctx.jsonSchema.type = 'object'
          ctx.jsonSchema.format = zod.def.type
        }
      },
    }))
    .with('arktype', () => ({
      fallback: {
        default: (ctx: any) => ({ ...ctx.base, type: 'object', format: ctx.code }),
        date: (ctx: any) => ({
          ...ctx.base,
          type: 'integer',
          format: 'epoch',
          exclusiveMaximum: ctx.before?.getTime(),
          exclusiveMinimum: ctx.after?.getTime(),
        }),
      },
    }))
    .otherwise(() => undefined)

  return standardSchema.jsonSchema.input({ target: 'draft-07', libraryOptions })
}
