import { expect, test } from 'vitest'
import z from 'zod'
import { useFormCore } from './core'

test('keeps native File values usable', async () => {
  const form = useFormCore({
    schema: z.object({ file: z.instanceof(File).nullable() }),
    sourceValues: { file: null },
    async submit() {},
  })
  const field = form.fields.file.$use()
  const file = new File(['test'], 'test.txt', { type: 'text/plain' })

  field.handleChange(file)

  expect(form.isDirty).toBe(true)
  expect(form.data.file?.size).toBe(4)
  expect(form.data.file).toBe(file)
  expect(field.value).toBe(file)
  expect(await form.submit()).toEqual({ success: true })
})
