import { playwright } from '@vitest/browser-playwright'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    typecheck: {
      enabled: true,
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          exclude: [...configDefaults.exclude, '**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'chromium',
          include: ['**/*.browser.test.ts'],
          typecheck: { enabled: false },
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
