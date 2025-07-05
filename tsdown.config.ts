import { defineConfig } from 'tsdown'

export default defineConfig({
  outDir: 'dist/',
  format: ['esm', 'cjs'],
  platform: 'browser',
  noExternal: ['on-change'],
  clean: true,
})
