import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'dock.js');

await build({
  entryPoints: [path.join(root, 'dock', 'index.jsx')],
  outfile: out,
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome100', 'firefox100', 'safari15.4'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  banner: { js: '/* Retakes dock. Bundles React, Motion and notch-toast (MIT). */' },
  logLevel: 'warning',
});

const bytes = fs.readFileSync(out);
console.log(`dist/dock.js  ${(bytes.length / 1024).toFixed(1)} KB, ${(gzipSync(bytes).length / 1024).toFixed(1)} KB gzipped`);
