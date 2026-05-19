import { defineConfig } from 'tsdown'

export default defineConfig({
  outDir: 'dist/',
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      outDir: 'dist/',
    },
  },
  checks: {
    legacyCjs: false,
  },
  external: ['vue', '@vue/reactivity', '@standard-schema/spec'],
  platform: 'browser',
  noExternal: ['on-change'],
  inlineOnly: ['on-change'],
  clean: true,
})
