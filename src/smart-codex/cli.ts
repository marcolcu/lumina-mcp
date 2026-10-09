import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { explain, route } from './router.js';
import { codexRunner, execute, formatStats, stats } from './run.js';

const USAGE = `smart-codex [--dry-run] [--explain] [--stats] [--exec] [--model M] [--reasoning E] [--tier T] "task"`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      'dry-run': { type: 'boolean' }, explain: { type: 'boolean' }, stats: { type: 'boolean' }, exec: { type: 'boolean' },
      model: { type: 'string' }, reasoning: { type: 'string' }, tier: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { console.log(USAGE); return 0; }
  const cfg = loadConfig();
  if (values.stats) { console.log(formatStats(stats())); return 0; }
  const task = positionals.join(' ').trim();
  if (!task) { console.error(USAGE); return 2; }

  const r = route({ task, preferences: { model: values.model, reasoning: values.reasoning, tier: values.tier as never } }, cfg);
  if (values.explain) { console.log(explain(r)); return 0; }
  if (values['dry-run']) { console.log(JSON.stringify(r, null, 2)); return 0; }

  const mode = values.exec ? 'exec' : 'interactive';
  const runner = codexRunner(mode, process.cwd());
  try {
    const { code, diagnostic } = await execute(task, r, cfg, runner, mode);
    if (diagnostic) console.error(`smart-codex: ${diagnostic}`);
    return code;
  } finally {
    runner.dispose();
  }
}

if (process.env.NODE_ENV !== 'test' && process.argv[1] && /smart-codex(\.js|\/cli\.ts)?$/.test(process.argv[1])) {
  main().then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 2; });
}
