<script setup lang="ts">
import { useForm } from '@falcondev-oss/form-vue'
import { reactive } from 'vue'
import z from 'zod'

const data = reactive({
  text: 'Hello World',
})

const form = useForm({
  schema: z.object({
    text: z.string(),
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
    <textarea
      v-model="textField.model"
      class="h-32 w-full border p-2"
      :disabled="textField.disabled"
      @blur="textField.handleBlur"
    />
    <button @click="form.submit">Submit{{ form.isLoading.value ? 'ing...' : '' }}</button>
  </div>
</template>

<style scoped></style>
