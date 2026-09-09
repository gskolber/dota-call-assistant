import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  target: 'es2022',
};

const targets = [
  // main + preload run in Node/Electron and must not bundle electron itself
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'esm' },
];

async function copyStatic() {
  await mkdir('dist/renderer', { recursive: true });
  await cp('src/renderer/index.html', 'dist/renderer/index.html');
  await cp('src/renderer/style.css', 'dist/renderer/style.css');
  await cp('src/renderer/fonts.css', 'dist/renderer/fonts.css');
  await cp('src/renderer/fonts', 'dist/renderer/fonts', { recursive: true });
  await cp('build/icon.png', 'dist/renderer/icon.png');
}

await rm('dist', { recursive: true, force: true });
await copyStatic();

if (watch) {
  const ctxs = await Promise.all(targets.map(context));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(targets.map(build));
}
