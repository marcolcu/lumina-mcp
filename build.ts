import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

// Clean the dist directory to ensure no un-minified TS output remains
if (fs.existsSync('dist')) {
  fs.rmSync('dist', { recursive: true, force: true });
}

console.log('Building and minifying production code with esbuild...');

build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/index.js',
  minify: true, // This enables code minification and mangling
  keepNames: false,
  packages: 'external', // Keeps node_modules external
  banner: {
    js: '#!/usr/bin/env node', // CRITICAL for npx / CLI execution
  },
}).then(() => build({
  entryPoints: ['src/smart-codex/cli.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/smart-codex.js',
  minify: true, packages: 'external', banner: { js: '#!/usr/bin/env node' },
})).then(() => build({
  entryPoints: ['src/lumina/tui/tui.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/lumina.js',
  minify: true, packages: 'external', banner: { js: '#!/usr/bin/env node' },
})).then(() => {
  // npm bin targets must stay executable (the dist directory is recreated on every build)
  for (const f of ['index.js', 'smart-codex.js', 'lumina.js']) fs.chmodSync(path.join('dist', f), 0o755);

  // Copy skills folder to dist
  const skillsSrcDir = path.join('src', 'skills');
  const skillsDistDir = path.join('dist', 'skills');
  if (fs.existsSync(skillsSrcDir)) {
    fs.cpSync(skillsSrcDir, skillsDistDir, { recursive: true });
    console.log('Copied skills folder to dist/skills');
  }

  // Bundle installable Agent Skills alongside runtime fallback prompts.
  const installableSkillsDir = path.join('skills');
  if (fs.existsSync(installableSkillsDir)) {
    fs.cpSync(installableSkillsDir, skillsDistDir, { recursive: true });
    console.log('Copied installable Agent Skills to dist/skills');
  }

  console.log('Production build completed successfully!');
  console.log('Output generated at dist/index.js');
}).catch((error: unknown) => {
  console.error('Build failed:', error);
  process.exit(1);
});
