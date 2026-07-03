import { describe, it, expect } from 'vitest';
import { OrchestrationService } from '../../../src/tools/orchestration/service/orchestration.service.js';
import { SENIOR_SWE_ORCHESTRATION_PROMPT } from '../../../src/tools/orchestration/prompts/index.js';

describe('Orchestration Service', () => {
  const service = new OrchestrationService();

  describe('getOrchestrationPhase', () => {
    it('should return PLANNING_PROMPT for phase 1', () => {
      const result = service.getOrchestrationPhase(1, true);
      expect(result.instructions).toContain('### Phase 1: Planning, Brainstorming & Test Catalog');
    });

    it('should return TESTING_PROMPT for phase 3 when includeTest is true', () => {
      const result = service.getOrchestrationPhase(3, true);
      expect(result.instructions).toContain('### Phase 3: Unit Testing');
    });

    it('should return CODE_REVIEW_PROMPT for phase 4 when includeTest is true', () => {
      const result = service.getOrchestrationPhase(4, true);
      expect(result.instructions).toContain('### Phase 4: Code Review');
    });

    it('should return CODE_REVIEW_PROMPT for phase 3 when includeTest is false', () => {
      const result = service.getOrchestrationPhase(3, false);
      expect(result.instructions).toContain('### Phase 3: Code Review');
    });

    it('should return VERIFICATION_PROMPT for phase 4 when includeTest is false', () => {
      const result = service.getOrchestrationPhase(4, false);
      expect(result.instructions).toContain('### Phase 4: Verification (Tests & Database)');
    });

    it('should return GIT_SYSTEM_PROMPT for phase 5 when includeTest is false', () => {
      const result = service.getOrchestrationPhase(5, false);
      expect(result.instructions).toContain('### Phase 5: Git System (Commit & PR)');
    });

    it('should return error for invalid phase (e.g. 7 with includeTest true)', () => {
      const result = service.getOrchestrationPhase(7, true);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid phase number');
    });

    it('should return error for phase 6 when includeTest is false', () => {
      const result = service.getOrchestrationPhase(6, false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('tests skipped');
    });

    // Token Budget tests
    it('should include save-tokens rules when tokenBudget is save-tokens', () => {
      const result = service.getOrchestrationPhase(1, true, 'save-tokens');
      expect(result.instructions).toContain('Save-Tokens Mode Active');
    });

    it('should NOT include save-tokens rules when tokenBudget is full-detail', () => {
      const result = service.getOrchestrationPhase(1, true, 'full-detail');
      expect(result.instructions).not.toContain('Save-Tokens Mode Active');
    });

    it('should default to save-tokens mode', () => {
      const result = service.getOrchestrationPhase(1, true);
      expect(result.instructions).toContain('Save-Tokens Mode Active');
    });

    // Previous Phase Summary tests
    it('should include previousPhaseSummary when provided', () => {
      const summary = 'Created service.ts and controller.ts for auth module';
      const result = service.getOrchestrationPhase(2, true, 'save-tokens', summary);
      expect(result.instructions).toContain('Context from Previous Phase');
      expect(result.instructions).toContain(summary);
    });

    it('should NOT include summary block when previousPhaseSummary is not provided', () => {
      const result = service.getOrchestrationPhase(2, true);
      expect(result.instructions).not.toContain('Context from Previous Phase');
    });

    it('should not contain raw placeholders in output', () => {
      const result = service.getOrchestrationPhase(1, true);
      expect(result.instructions).not.toContain('{{tokenMode}}');
      expect(result.instructions).not.toContain('{{previousSummary}}');
      expect(result.instructions).not.toContain('{{phase}}');
    });
  });

  describe('getOrchestrationPrompt', () => {
    it('should replace {{context}} with the provided command', () => {
      const commandText = 'Implement feature X';
      const result = service.getOrchestrationPrompt(commandText);
      const expectedText = SENIOR_SWE_ORCHESTRATION_PROMPT.replace('{{context}}', commandText);

      expect(result).toBe(expectedText);
    });

    it('should inject tokenBudget directive if provided', () => {
      const commandText = 'Implement feature X';
      const result = service.getOrchestrationPrompt(commandText, 'full-detail');

      expect(result).toContain(commandText);
      expect(result).toContain('[SYSTEM DIRECTIVE]: You must use tokenBudget: "full-detail"');
    });

    it('should handle undefined command gracefully', () => {
      const result = service.getOrchestrationPrompt();
      const expectedText = SENIOR_SWE_ORCHESTRATION_PROMPT.replace(
        '{{context}}',
        'No specific command provided.',
      );

      expect(result).toBe(expectedText);
    });
  });
});
