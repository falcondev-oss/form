<script setup lang="ts">
import { useForm } from '@falcondev-oss/form-vue'
import { type } from 'arktype'
import { reactive, watch } from 'vue'
import z from 'zod'

const form = useForm({
  schema: type({
    date: type.Date.earlierThan(new Date(2025, 0, 1)),
  }),
  sourceValues: {
    date: new Date(),
  },
  async submit({ values }) {
    console.log('Submitted', values)
  },
})

const textField = form.fields.date.$use({
  translate: {
    get(v) {
      if (v instanceof Date) {
        return v.toISOString().slice(0, 16)
      } else if (typeof v === 'number') {
        return new Date(v).toISOString().slice(0, 16)
      }
      return ''
    },
    set(v) {
      const date = new Date(v)
      if (!Number.isNaN(date.getTime())) {
        return date
      }
      return null
    },
  },
})
</script>

<template>
  <div class="flex flex-col">
    <pre>{{ form }}</pre>
    <pre>{{ form.fields.date.$use().schema }}</pre>
    {{ textField.model }}
    <input
      v-model="textField.model"
      type="datetime-local"
      class="h-32 w-full border p-2"
      :disabled="textField.disabled"
      @blur="textField.handleBlur"
    />
    <button @click="form.submit">Submit{{ form.isLoading ? 'ting...' : '' }}</button>
  </div>
</template>

<style scoped></style>
