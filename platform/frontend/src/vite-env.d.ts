/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_ENV_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// vite.config.ts 의 define 으로 주입되는 빌드 시각
declare const __BUILD_TIME__: string;
