<script setup lang="ts">
import { useForm } from '@falcondev-oss/form-vue'
import { reactive, watch } from 'vue'
import z from 'zod'

const data = reactive({
  text: 'Hello World',
})
watch(data, console.log)

const form = useForm({
  schema: z.object({
    text: z.union([z.string(), z.number().max(10)]),
  }),
  sourceValues() {
    console.log('sourceValues()')
    return data
  },
  async submit({ values }) {
    console.log('Submitted', values)
    await new Promise((r) => setTimeout(r, 1000))
    data.text = `${values.text}!!`
  },
})

const textField = form.fields.text.$use()
</script>

<template>
  <div class="flex flex-col">
    <pre>{{ form }}</pre>
    <pre>{{ form.fields.text.$use().schema }}</pre>
    <textarea
      v-model.number="textField.model"
      class="h-32 w-full border p-2"
      :disabled="textField.disabled"
      @blur="textField.handleBlur"
    />
    <button @click="form.submit">Submit{{ form.isLoading ? 'ting...' : '' }}</button>
  </div>
</template>

<style scoped></style>
