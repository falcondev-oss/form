import { defineConfig } from 'tsup'

export default defineConfig({
  outDir: 'dist/',
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  platform: 'browser',
  noExternal: ['on-change'],
  clean: true,
})
