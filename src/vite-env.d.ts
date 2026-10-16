/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_ORIGIN: string;
  /** Build identifier stamped at build time; reported with browser diagnostics. */
  readonly VITE_BUILD_ID?: string;
}
