import { RouterConfig } from '../../smart-codex/config.js';
import { ModelInfo, loadCatalog, resolveModel } from '../../smart-codex/models.js';
import { Route, route } from '../../smart-codex/router.js';
import { Selection } from './chat.js';

export interface Pick { sel: Selection; route: Route; sticky: boolean; }

/**
 * Per-turn routing for a conversation. Uses the Smart Codex router (local, no LLM) on each message;
 * /model and /reasoning set sticky overrides; vague follow-ups ("ok do it") keep the previous turn's selection.
 */
export class TurnRouter {
  model?: string;
  reasoning?: string;
  private last?: Selection;

  constructor(private readonly cfg: RouterConfig, private readonly cwd: string, private readonly catalog: ModelInfo[] = loadCatalog()) {}

  /** Validates against the installed catalog; 'auto' clears. Throws a clear error when unsupported. */
  setModel(value: string): void {
    if (value === 'auto') { this.model = undefined; return; }
    resolveModel(this.catalog, value, this.reasoning ?? 'medium', true);
    this.model = value;
  }

  setReasoning(value: string): void {
    if (value === 'auto') { this.reasoning = undefined; return; }
    resolveModel(this.catalog, this.model ?? this.catalog[0]?.slug ?? 'x', value, true);
    this.reasoning = value;
  }

  reset(): void { this.last = undefined; }

  get config(): RouterConfig { return this.cfg; }
  get models(): ModelInfo[] { return this.catalog; }

  /** Human-friendly model name from the installed catalog (falls back to the id). */
  displayName(slug: string): string { return this.catalog.find((m) => m.slug === slug)?.name || slug; }

  /** Distinct models the configured tiers can route to (shown before the first turn). */
  configuredModels(): string[] { return [...new Set(Object.values(this.cfg.models))]; }

  pick(task: string): Pick {
    const r = route({ task, repository: this.cwd, preferences: { model: this.model, reasoning: this.reasoning } }, this.cfg, this.catalog);
    const vague = r.confidence < 0.5 && this.last !== undefined && !this.model && !this.reasoning;
    const sel: Selection = vague ? this.last! : { model: r.model, effort: r.reasoning_effort };
    this.last = sel;
    return { sel, route: r, sticky: vague };
  }
}
