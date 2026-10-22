const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['server.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/server.js',
  external: ['sqlite3'],
  format: 'cjs',
  sourcemap: true,
}).catch(() => process.exit(1));