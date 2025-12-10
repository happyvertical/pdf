import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'] as const,
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: {
        dir: resolve(__dirname, 'dist'),
        format: 'es' as const,
        preserveModules: false,
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
      external: [
        // Node.js built-ins
        /^node:/,
        /^bun:/,
        'fs',
        'path',
        'url',
        'os',
        'crypto',
        'stream',
        'util',
        'events',
        'child_process',
        'buffer',
        'Buffer',
        'zlib',
        'assert',
        'http',
        'https',
        'net',
        'tls',
        'dns',
        'cluster',
        'worker_threads',
        'perf_hooks',
        'readline',
        'repl',
        'vm',
        'v8',
        'inspector',

        // External dependencies - don't bundle these
        'unpdf',
        'pdf-to-png-converter',
        'pdfjs-dist',

        // SDK dependencies
        '@happyvertical/utils',
        '@happyvertical/ocr',
        /^@happyvertical\//,
      ],
    },
    minify: false,
    sourcemap: true,
    target: 'es2022',
    reportCompressedSize: false,
  },
  plugins: [
    dts({
      outDir: resolve(__dirname, 'dist'),
      include: [resolve(__dirname, 'src/**/*.ts')],
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.test.*.ts',
        '**/*.config.ts',
        '**/*.config.js',
        '**/*.d.ts',
      ],
      insertTypesEntry: false,
      rollupTypes: false,
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
    }),
  ],
});
