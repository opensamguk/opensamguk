/// <reference types="vite/client" />

interface ImportMetaEnv {
  // 공개값. 비밀값을 넣지 않는다. 설명: docs/architecture/runtime.md
  readonly VITE_IMAGE_BASE_URL?: string;
  readonly VITE_SOURCE_REVISION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
