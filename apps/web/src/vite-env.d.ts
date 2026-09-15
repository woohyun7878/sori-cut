/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Bender backend HTTP API. Defaults to http://localhost:8787. */
  readonly VITE_BENDER_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
