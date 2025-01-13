import { defineConfig } from 'tsup'

export default defineConfig({
  outDir: 'dist/',
  entry: ['src/core.ts', 'src/reactive.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
})
