import { describe, expect, test } from 'vitest'
import z from 'zod'
import { useForm } from '.'

describe('vue', () => {
  test('model', () => {
    const form = useForm({
      schema: z.object({
        name: z.string(),
      }),
      sourceValues: {
        name: 'John Doe',
      },
      async submit() {},
    })

    expect(form.fields.name.$use().model).toEqual('John Doe')
    form.fields.name.$use().model = 'Jane Doe'
    expect(form.fields.name.$use().model).toEqual('Jane Doe')
    expect(form.data.name).toEqual('Jane Doe')
  })
})
