import type { JSONSchema7 } from 'json-schema'
import { type } from 'arktype'
import { afterEach, describe, expect, test, vi } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'
import { getSchemaMeta, resetUnsupportedConstructs } from './schema-navigator'

afterEach(() => {
  resetUnsupportedConstructs()
  delete (globalThis as { __FORM_DEBUG__?: boolean }).__FORM_DEBUG__
})

describe('getSchemaMeta', () => {
  test('extracts every renderer annotation from the root schema', () => {
    const schema = {
      type: 'string',
      title: 'Name',
      description: 'Legal name',
      default: 'Ada',
      examples: ['Grace'],
      minimum: 1,
      exclusiveMinimum: 2,
      maximum: 10,
      exclusiveMaximum: 9,
      minLength: 3,
      maxLength: 8,
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, {}, '')).toEqual({
      required: true,
      title: 'Name',
      description: 'Legal name',
      default: 'Ada',
      examples: ['Grace'],
      minimum: 1,
      exclusiveMinimum: 2,
      maximum: 10,
      exclusiveMaximum: 9,
      minLength: 3,
      maxLength: 8,
    })
  })

  test('preserves falsy annotation values', () => {
    const schema = {
      type: 'string',
      title: '',
      default: null,
      minimum: 0,
      minLength: 0,
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, {}, '')).toEqual({
      required: true,
      title: '',
      default: null,
      minimum: 0,
      minLength: 0,
    })
  })

  test.each([
    ['required', ['name'], true],
    ['optional', [], false],
  ])('marks an object property as %s', (_, required, expected) => {
    const schema = {
      type: 'object',
      required,
      properties: { name: { type: 'string' } },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { name: 'Ada' }, 'name').required).toBe(expected)
  })

  test('marks required nullable properties as optional for form input', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { name: null }, 'name').required).toBe(false)
  })

  test('recognizes nullable type arrays', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: ['string', 'null'] } },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { name: null }, 'name').required).toBe(false)
  })

  test('navigates property names containing dots', () => {
    const schema = {
      type: 'object',
      required: ['person.name'],
      properties: {
        'person.name': { type: 'string', title: 'Full name' },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { 'person.name': 'Ada' }, String.raw`person\.name`)).toEqual({
      required: true,
      title: 'Full name',
    })
  })

  test('navigates nested objects and homogeneous arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label'],
            properties: { label: { type: 'string', minLength: 2 } },
          },
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { groups: [{ label: 'AB' }] }, 'groups[0].label')).toEqual({
      required: true,
      minLength: 2,
    })
  })

  test.each([
    ['[0]', { type: 'string', title: 'first' }, 'first'],
    ['[1]', { type: 'number', title: 'second' }, 'second'],
    ['[2]', { type: 'boolean', title: 'rest' }, 'rest'],
  ] as const)('navigates draft-07 tuple item %s', (path, _item, title) => {
    const schema = {
      type: 'array',
      items: [
        { type: 'string', title: 'first' },
        { type: 'number', title: 'second' },
      ],
      additionalItems: { type: 'boolean', title: 'rest' },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, ['a', 1, true], path)).toEqual({ required: false, title })
  })

  test.each([
    ['[0]', 'prefix'],
    ['[1]', 'rest'],
  ] as const)('navigates modern tuple item %s', (path, title) => {
    const schema = {
      type: 'array',
      prefixItems: [{ type: 'string', title: 'prefix' }],
      items: { type: 'number', title: 'rest' },
    } as JSONSchema7

    expect(getSchemaMeta(schema, ['a', 1], path)).toEqual({ required: false, title })
  })

  test('navigates record values through additionalProperties', () => {
    const schema = {
      type: 'object',
      additionalProperties: { type: 'string', maxLength: 4 },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { code: 'abcd' }, 'code')).toEqual({
      required: false,
      maxLength: 4,
    })
  })

  test.each([
    ['const', { const: 'email' }, { const: 'phone' }],
    ['enum', { enum: ['email', 'mail'] }, { enum: ['phone', 'sms'] }],
  ] as const)('selects a discriminated object union by %s', (_, emailTag, phoneTag) => {
    const schema = {
      oneOf: [
        {
          type: 'object',
          required: ['value'],
          properties: {
            kind: emailTag as JSONSchema7,
            value: { type: 'string', title: 'Email' },
          },
        },
        {
          type: 'object',
          required: ['value'],
          properties: {
            kind: phoneTag as JSONSchema7,
            value: { type: 'string', title: 'Phone' },
          },
        },
      ],
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { kind: 'phone', value: '123' }, 'value')).toEqual({
      required: true,
      title: 'Phone',
    })
  })

  test.each([
    ['const', { const: 'draft', title: 'Draft' }, 'draft', 'Draft'],
    ['enum', { enum: ['sent', 'read'], title: 'Sent' }, 'read', 'Sent'],
  ] as const)('selects a literal leaf union by %s', (_, branch, value, title) => {
    const schema = {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          oneOf: [branch as JSONSchema7, { const: 'other', title: 'Other' }],
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { status: value }, 'status')).toEqual({
      required: true,
      title,
    })
  })

  test.each([
    ['string', 'text', 'string'],
    ['boolean', true, 'boolean'],
    ['integer', 3, 'integer'],
    ['number', 3.5, 'number'],
    ['array', [], 'array'],
    ['object', {}, 'object'],
  ] as const)('selects the %s branch by current value type', (_, value, title) => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            { type: 'string', title: 'string' },
            { type: 'boolean', title: 'boolean' },
            { type: 'integer', title: 'integer' },
            { type: 'number', title: 'number' },
            { type: 'array', title: 'array' },
            { type: 'object', title: 'object' },
          ],
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { value }, 'value').title).toBe(title)
  })

  test('treats Date values as epoch integers', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            { type: 'string', title: 'string' },
            { type: 'integer', format: 'epoch', title: 'date' },
          ],
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { value: new Date(0) }, 'value').title).toBe('date')
  })

  test('resolves nested unions and preserves outer nullable metadata', () => {
    const schema = {
      type: 'object',
      required: ['value'],
      properties: {
        value: {
          description: 'Shared description',
          anyOf: [
            { type: 'null' },
            {
              oneOf: [
                { type: 'string', minLength: 2 },
                { type: 'number', minimum: 1 },
              ],
            },
          ],
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { value: 'ok' }, 'value')).toEqual({
      required: false,
      description: 'Shared description',
      minLength: 2,
    })
  })

  test('lets branch annotations override union annotations', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'string', title: 'Branch' }, { type: 'number' }],
          title: 'Union',
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { value: 'ok' }, 'value').title).toBe('Branch')
  })

  test('uses the first non-null branch when the current value is absent', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            { type: 'null' },
            { type: 'string', title: 'Fallback' },
            { type: 'number', title: 'Later' },
          ],
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, {}, 'value')).toEqual({
      required: false,
      title: 'Fallback',
    })
  })

  test('uses the first matching branch for undiscriminated same-type unions', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { type: 'string', maxLength: 2 },
            { type: 'string', minLength: 5 },
          ],
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { value: 'anything' }, 'value')).toEqual({
      required: false,
      maxLength: 2,
    })
  })

  test.each([
    ['unknown property', { type: 'object', properties: {} }, 'missing'],
    ['tuple overflow', { type: 'array', items: [{ type: 'string' }] }, '[1]'],
    ['boolean item schema', { type: 'array', items: true }, '[0]'],
  ] satisfies [string, JSONSchema7, string][])('returns no metadata for %s', (_, schema, path) => {
    expect(getSchemaMeta(schema, {}, path)).toEqual({})
  })

  test('returns no metadata for unsupported schema constructs', () => {
    const schema = {
      type: 'object',
      properties: {
        name: {
          allOf: [{ type: 'string', title: 'Name' }],
          title: 'Misleading wrapper title',
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { name: 'Ada' }, 'name')).toEqual({})
  })

  test.each(['$ref', 'if', 'then', 'else', 'not', 'patternProperties'] as const)(
    'returns no metadata for %s',
    (construct) => {
      const schema = {
        type: 'string',
        title: 'Ignored',
        [construct]: construct === '$ref' ? '#/$defs/value' : {},
      } as JSONSchema7

      expect(getSchemaMeta(schema, {}, '')).toEqual({})
    },
  )

  test('stops navigation when a parent contains an unsupported construct', () => {
    const schema = {
      type: 'object',
      patternProperties: { '.*': { type: 'string' } },
      properties: { name: { type: 'string', title: 'Ignored' } },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { name: 'Ada' }, 'name')).toEqual({})
  })

  test('rejects unsupported constructs on a union wrapper', () => {
    const schema = {
      anyOf: [{ type: 'string', title: 'Ignored' }],
      allOf: [{ type: 'string' }],
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, {}, '')).toEqual({})
  })

  test('ignores boolean union branches', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [true, false, { type: 'string', title: 'String' }],
        },
      },
    } satisfies JSONSchema7

    expect(getSchemaMeta(schema, { value: 'ok' }, 'value').title).toBe('String')
  })

  test('logs each unsupported construct once in debug mode', () => {
    ;(globalThis as { __FORM_DEBUG__?: boolean }).__FORM_DEBUG__ = true
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const schema = { allOf: [{ type: 'string' }] } satisfies JSONSchema7

    getSchemaMeta(schema, {}, '')
    getSchemaMeta(schema, {}, '')

    expect(debug).toHaveBeenCalledExactlyOnceWith(
      "useForm: schema navigator hit unsupported JSON Schema construct 'allOf' at path '' — field metadata degraded to {}",
    )
    debug.mockRestore()
  })
})

describe('field.schema', () => {
  test('reacts to a Zod discriminated-union value change', () => {
    const schema = z.object({
      contact: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('email'),
          value: z.string().min(2).describe('Email'),
        }),
        z.object({
          kind: z.literal('phone'),
          value: z.string().max(10).describe('Phone'),
        }),
      ]),
    })
    const form = useFormCore({
      schema,
      sourceValues: { contact: { kind: 'email', value: 'a@b' } },
      submit: async () => {},
    })
    const value = form.fields.contact.value.$use()

    expect(value.schema).toEqual({
      required: true,
      description: 'Email',
      minLength: 2,
    })

    form.data!.contact = { kind: 'phone', value: '123' }

    expect(value.schema).toEqual({
      required: true,
      description: 'Phone',
      maxLength: 10,
    })
  })

  test('extracts metadata from an ArkType schema', () => {
    const schema = type({ name: 'string > 1' })
    const form = useFormCore({
      schema,
      sourceValues: { name: 'Ada' },
      submit: async () => {},
    })

    expect(form.fields.name.$use().schema).toEqual({
      required: true,
      minLength: 2,
    })
  })

  test('supports a Zod field name containing a dot', () => {
    const schema = z.object({ 'person.name': z.string().min(2) })
    const form = useFormCore({
      schema,
      sourceValues: { 'person.name': 'Ada' },
      submit: async () => {},
    })

    expect(form.fields['person.name'].$use().schema).toEqual({
      required: true,
      minLength: 2,
    })
  })
})
