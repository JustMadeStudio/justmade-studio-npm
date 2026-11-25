import { defineConfig } from 'tsup'

export default defineConfig({
  // `file-store` is its own entry: it imports node:fs, the main one stays browser-safe.
  entry: ['src/index.ts', 'src/file-store.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' }
  },
})
