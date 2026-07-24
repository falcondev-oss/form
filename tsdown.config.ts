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
  external: ['vue', '@standard-schema/spec'],
  platform: 'browser',
  clean: true,
})
