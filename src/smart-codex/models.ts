import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ModelInfo { slug: string; efforts: string[]; name?: string; }

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const memo = new Map<string, { mtimeMs: number; models: ModelInfo[] }>();

/** Reads the installed Codex model catalog (listed models only). Returns [] if unavailable. Memoized by file mtime. */
export function loadCatalog(codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')): ModelInfo[] {
  try {
    const file = path.join(codexHome, 'models_cache.json');
    const { mtimeMs } = fs.statSync(file);
    const hit = memo.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.models;
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      models?: { slug: string; display_name?: string; visibility?: string; supported_reasoning_levels?: { effort: string }[] }[];
    };
    const models = (cache.models ?? [])
      .filter((m) => m.visibility === 'list')
      .map((m) => ({ slug: m.slug, name: m.display_name, efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort) }));
    memo.set(file, { mtimeMs, models });
    return models;
  } catch {
    return [];
  }
}

/** Default model from ~/.codex/config.toml (simple key scan; no TOML dependency). */
export function userDefaultModel(codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')): string | undefined {
  try {
    return /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

export interface Resolved { model: string; effort: string; note?: string; }

/**
 * Validates model+effort against the catalog.
 * explicit=true → throw on unsupported; otherwise fall back safely (configured default → user default → first listed).
 * Empty catalog → pass through unvalidated (Codex itself will reject).
 */
export function resolveModel(catalog: ModelInfo[], model: string, effort: string, explicit: boolean, fallbackModel = userDefaultModel()): Resolved {
  // identifiers end up in argv / a TOML override: never allow quotes, whitespace or shell/TOML metacharacters
  for (const [k, v] of [['model', model], ['reasoning', effort]]) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) throw new Error(`Invalid ${k} identifier`);
  }
  if (catalog.length === 0) return { model, effort, note: 'model catalog unavailable; not validated' };
  let info = catalog.find((m) => m.slug === model);
  let note: string | undefined;
  if (!info) {
    if (explicit) throw new Error(`Unsupported model "${model}". Supported: ${catalog.map((m) => m.slug).join(', ')}`);
    info = catalog.find((m) => m.slug === fallbackModel) ?? catalog[0];
    note = `model "${model}" unsupported; fell back to ${info.slug}`;
  }
  if (!info.efforts.includes(effort)) {
    if (explicit) throw new Error(`Model ${info.slug} does not support reasoning "${effort}". Supported: ${info.efforts.join(', ')}`);
    const target = EFFORT_ORDER.indexOf(effort);
    const nearest = [...info.efforts].sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - target) - Math.abs(EFFORT_ORDER.indexOf(b) - target))[0];
    note = `${note ? `${note}; ` : ''}reasoning "${effort}" unsupported by ${info.slug}; using ${nearest}`;
    effort = nearest;
  }
  return { model: info.slug, effort, note };
}

/** Next supported effort above `effort` (capped at xhigh), or undefined. */
export function nextEffort(info: ModelInfo | undefined, effort: string): string | undefined {
  const cap = EFFORT_ORDER.indexOf('xhigh');
  const i = EFFORT_ORDER.indexOf(effort);
  return EFFORT_ORDER.slice(i + 1, cap + 1).find((e) => !info || info.efforts.includes(e));
}
