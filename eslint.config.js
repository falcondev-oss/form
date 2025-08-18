// @ts-check
import eslintConfig from '@falcondev-oss/configs/eslint'

export default eslintConfig({
  tsconfigPath: './tsconfig.json',
}).append({
  ignores: ['node_modules/', 'dist/', 'pnpm-lock.yaml', '.eslintcache', 'README.md'],
})
