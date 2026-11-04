/// <reference types="vite/client" />

// @fontsource packages ship CSS without type declarations.
declare module '@fontsource-variable/inter'

/** Stamped by vite.config.ts; undefined under the unit tests. */
interface ImportMetaEnv {
  readonly YAAC_VERSION?: string
  readonly YAAC_GIT_COMMIT?: string
}
