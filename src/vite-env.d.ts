/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FINSEC_API_BASE_URL?: string
  readonly VITE_FINSEC_ACTOR_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

