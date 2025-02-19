// @ts-check
import eslintConfig from '@louishaftmann/eslint-config'

export default eslintConfig({
  tsconfigPath: './tsconfig.json',
}).append({
  ignores: ['node_modules/', 'dist/', 'pnpm-lock.yaml', '.eslintcache', 'README.md'],
})
