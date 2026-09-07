import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // The suite runs against the pinned pre-v2 Session runtime; the shim
    // adapts it to the session-format-v2 contract the plugin is ported to.
    setupFiles: ['tests/fixtures/session-format-v2.ts'],
    passWithNoTests: false,
  },
})
