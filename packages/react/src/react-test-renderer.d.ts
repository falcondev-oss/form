declare module 'react-test-renderer' {
  import type { ReactElement } from 'react'

  export function create(element: ReactElement): {
    unmount: () => void
    update: (element: ReactElement) => void
  }
}
