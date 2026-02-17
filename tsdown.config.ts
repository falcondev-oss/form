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
  external: ['vue', '@vue/reactivity'],
  platform: 'browser',
  noExternal: ['on-change'],
  inlineOnly: ['on-change'],
  clean: true,
})
