import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCompoundEngineering } from '../../../utils/compound-engineering.util.js';

import {
  SENIOR_SWE_ORCHESTRATION_PROMPT,
  PLANNING_PROMPT,
  EXECUTION_PROMPT,
  TESTING_PROMPT,
  CODE_REVIEW_PROMPT,
  VERIFICATION_PROMPT,
  GIT_SYSTEM_PROMPT,
  SAVE_TOKENS_MODE_RULES,
} from '../prompts/index.js';

export class OrchestrationService {
  private getFallbackSkill(skillName: string): string {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);

      const prodSkillsDir = path.join(__dirname, 'skills');
      const devSkillsDir = path.join(__dirname, '..', '..', '..', 'skills');

      let filePath = path.join(prodSkillsDir, `${skillName}.md`);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(devSkillsDir, `${skillName}.md`);
      }

      if (fs.existsSync(filePath)) {
        return '\n\n' + fs.readFileSync(filePath, 'utf-8') + '\n\n';
      }
    } catch (e) {
      console.error(`Failed to load fallback skill: ${skillName}`, e);
    }
    return '';
  }

  /**
   * Returns the dynamic instructions for a specific orchestration phase.
   *
   * @param phase The phase number requested.
   * @param includeTest Whether tests are included in the workflow.
   * @param tokenBudget Token usage mode: 'save-tokens' for compact output, 'full-detail' for verbose.
   * @param previousPhaseSummary Optional compressed summary from the previous phase.
   * @returns An object containing either the instructions string or an error message.
   */
  public getOrchestrationPhase(
    phase: number,
    includeTest: boolean,
    tokenBudget: 'save-tokens' | 'full-detail' = 'save-tokens',
    previousPhaseSummary?: string,
  ): { instructions?: string; error?: string } {
    let instructions = '';

    if (includeTest) {
      // Full workflow (6 phases)
      switch (phase) {
        case 1:
          instructions = PLANNING_PROMPT;
          break;
        case 2:
          instructions = EXECUTION_PROMPT;
          break;
        case 3:
          instructions = TESTING_PROMPT;
          break;
        case 4:
          instructions = CODE_REVIEW_PROMPT;
          break;
        case 5:
          instructions = VERIFICATION_PROMPT;
          break;
        case 6:
          instructions = GIT_SYSTEM_PROMPT;
          break;
        default:
          return { error: 'Invalid phase number. Please request a phase between 1 and 6.' };
      }
    } else {
      // Skip testing (5 phases)
      switch (phase) {
        case 1:
          instructions = PLANNING_PROMPT;
          break;
        case 2:
          instructions = EXECUTION_PROMPT;
          break;
        case 3:
          instructions = CODE_REVIEW_PROMPT;
          break;
        case 4:
          instructions = VERIFICATION_PROMPT;
          break;
        case 5:
          instructions = GIT_SYSTEM_PROMPT;
          break;
        default:
          return {
            error: 'Invalid phase number. Please request a phase between 1 and 5 (tests skipped).',
          };
      }
    }

    // Dynamically replace the phase number placeholder
    instructions = instructions.replace(/\{\{phase\}\}/g, String(phase));

    // Inject token mode rules
    const tokenModeContent = tokenBudget === 'save-tokens' ? SAVE_TOKENS_MODE_RULES : '';
    instructions = instructions.replace(/\{\{tokenMode\}\}/g, tokenModeContent);

    // Inject previous phase summary
    const summaryContent = previousPhaseSummary
      ? `\n### Context from Previous Phase\n${previousPhaseSummary}\n`
      : '';
    instructions = instructions.replace(/\{\{previousSummary\}\}/g, summaryContent);

    // Inject fallback content if Compound Engineering is not installed
    const hasCE = hasCompoundEngineering();
    let fallbackContent = '';

    if (!hasCE) {
      if (phase === 1) {
        fallbackContent += this.getFallbackSkill('fallback-brainstorm');
      } else if (phase === 2) {
        fallbackContent += this.getFallbackSkill('fallback-work');
        fallbackContent += this.getFallbackSkill('fallback-compound');
      } else if (phase === 3 && !includeTest) {
        fallbackContent += this.getFallbackSkill('fallback-review');
      } else if (phase === 4 && includeTest) {
        fallbackContent += this.getFallbackSkill('fallback-review');
      }
    }

    if (fallbackContent) {
      instructions += fallbackContent;
    }

    return { instructions };
  }

  /**
   * Returns the senior SWE orchestration base prompt injected with context.
   *
   * @param command The context or command provided by the user.
   * @param tokenBudget The token usage mode selected by the user.
   * @returns The evaluated prompt text.
   */
  public getOrchestrationPrompt(command?: string, tokenBudget?: string): string {
    let context = command || 'No specific command provided.';

    if (tokenBudget) {
      context += `\n\n[SYSTEM DIRECTIVE]: You must use tokenBudget: "${tokenBudget}" when calling the \`get_orchestration_phase\` tool.`;
    }

    return SENIOR_SWE_ORCHESTRATION_PROMPT.replace('{{context}}', context);
  }
}
