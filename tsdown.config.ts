import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  sourcemap: false,
})
