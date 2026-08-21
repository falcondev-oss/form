<script setup lang="ts">
import { useForm } from '@falcondev-oss/form-vue'
import { type } from 'arktype'

const form = useForm({
  schema: type({
    date: type.Date.earlierThan(new Date(2025, 0, 1)),
    items: [
      {
        name: 'string',
        qty: 'number',
      },
    ],
  }),
  sourceValues: {
    date: new Date(),
    items: [
      { name: 'first', qty: 1 },
      { name: 'second', qty: 2 },
      { name: 'third', qty: 3 },
    ],
  },
  async submit({ values }) {
    // eslint-disable-next-line no-console
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

function moveDown(index: number) {
  const items = form.data.items
  if (!items || index >= items.length - 1) return
  ;[items[index], items[index + 1]] = [items[index + 1]!, items[index]!]
}
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <pre>{{ { isDirty: form.isDirty, isLoading: form.isLoading, errors: form.errors } }}</pre>

    <input
      v-model="textField.model"
      type="datetime-local"
      class="w-full border p-2"
      :disabled="textField.disabled"
      @blur="textField.handleBlur"
    />

    <ul class="flex flex-col gap-2">
      <li
        v-for="(item, index) of form.fields.items"
        :key="item.$use().key"
        class="flex items-center gap-2 border p-2"
      >
        <span class="font-mono text-xs text-gray-500">{{ item.$use().key.slice(0, 8) }}</span>
        <input
          v-model="item.name.$use().model"
          class="border p-1"
          :data-testid="`name-${index}`"
          @blur="item.name.$use().handleBlur"
        />
        <input
          v-model="item.qty.$use().model"
          type="number"
          class="w-20 border p-1"
          @blur="item.qty.$use().handleBlur"
        />
        <span v-if="item.name.$use().errors" class="text-red-600">
          {{ item.name.$use().errors.join(', ') }}
        </span>
        <button type="button" :data-testid="`down-${index}`" @click="moveDown(index)">↓</button>
        <button
          type="button"
          :data-testid="`del-${index}`"
          @click="form.fields.items.delete(item.$use().key)"
        >
          ✕
        </button>
      </li>
    </ul>

    <button class="border p-2" @click="form.submit">
      Submit{{ form.isLoading ? 'ting...' : '' }}
    </button>
    <button type="button" class="border p-2" @click="form.reset">Reset</button>
  </div>
</template>

<style scoped></style>
