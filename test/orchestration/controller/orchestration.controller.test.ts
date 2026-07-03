import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerOrchestrationController } from '../../../src/tools/orchestration/controller/orchestration.controller.js';
import { SENIOR_SWE_ORCHESTRATION_PROMPT } from '../../../src/tools/orchestration/prompts/index.js';

interface PhaseArgs {
  phase: number;
  includeTest: boolean;
  tokenBudget?: 'save-tokens' | 'full-detail';
  previousPhaseSummary?: string;
}

interface PhaseResult {
  content: { text: string }[];
  isError?: boolean;
}

describe('Orchestration Controller', () => {
  let mockServer: {
    registerTool: ReturnType<typeof vi.fn>;
    registerPrompt: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockServer = {
      registerTool: vi.fn(),
      registerPrompt: vi.fn(),
    };
  });

  it('should register orchestration tools and prompts', () => {
    registerOrchestrationController(mockServer as unknown as McpServer);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'get_orchestration_phase',
      expect.any(Object),
      expect.any(Function),
    );

    expect(mockServer.registerPrompt).toHaveBeenCalledWith(
      'lumina_orchestrate',
      expect.any(Object),
      expect.any(Function),
    );
  });

  describe('get_orchestration_phase tool', () => {
    let getPhaseCallback: (args: PhaseArgs) => Promise<PhaseResult>;

    beforeEach(() => {
      registerOrchestrationController(mockServer as unknown as McpServer);
      getPhaseCallback = mockServer.registerTool.mock.calls[0][2];
    });

    it('should return PLANNING_PROMPT for phase 1', async () => {
      const result = await getPhaseCallback({ phase: 1, includeTest: true });
      expect(result.content[0].text).toContain(
        '### Phase 1: Planning, Brainstorming & Test Catalog',
      );
    });

    it('should return TESTING_PROMPT for phase 3 when includeTest is true', async () => {
      const result = await getPhaseCallback({ phase: 3, includeTest: true });
      expect(result.content[0].text).toContain('### Phase 3: Unit Testing');
    });

    it('should return CODE_REVIEW_PROMPT for phase 4 when includeTest is true', async () => {
      const result = await getPhaseCallback({ phase: 4, includeTest: true });
      expect(result.content[0].text).toContain('### Phase 4: Code Review');
    });

    it('should return CODE_REVIEW_PROMPT for phase 3 when includeTest is false', async () => {
      const result = await getPhaseCallback({ phase: 3, includeTest: false });
      expect(result.content[0].text).toContain('### Phase 3: Code Review');
    });

    it('should return VERIFICATION_PROMPT for phase 4 when includeTest is false', async () => {
      const result = await getPhaseCallback({ phase: 4, includeTest: false });
      expect(result.content[0].text).toContain('### Phase 4: Verification (Tests & Database)');
    });

    it('should return GIT_SYSTEM_PROMPT for phase 5 when includeTest is false', async () => {
      const result = await getPhaseCallback({ phase: 5, includeTest: false });
      expect(result.content[0].text).toContain('### Phase 5: Git System (Commit & PR)');
    });

    it('should return error for invalid phase (e.g. 7 with includeTest true)', async () => {
      const result = await getPhaseCallback({ phase: 7, includeTest: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid phase number');
    });

    it('should return error for phase 6 when includeTest is false', async () => {
      const result = await getPhaseCallback({ phase: 6, includeTest: false });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tests skipped');
    });

    // Token Budget tests
    it('should include save-tokens rules when tokenBudget is save-tokens', async () => {
      const result = await getPhaseCallback({
        phase: 1,
        includeTest: true,
        tokenBudget: 'save-tokens',
      });
      expect(result.content[0].text).toContain('Save-Tokens Mode Active');
    });

    it('should NOT include save-tokens rules when tokenBudget is full-detail', async () => {
      const result = await getPhaseCallback({
        phase: 1,
        includeTest: true,
        tokenBudget: 'full-detail',
      });
      expect(result.content[0].text).not.toContain('Save-Tokens Mode Active');
    });

    it('should default to save-tokens mode when tokenBudget is not provided', async () => {
      const result = await getPhaseCallback({ phase: 1, includeTest: true });
      expect(result.content[0].text).toContain('Save-Tokens Mode Active');
    });

    // Previous Phase Summary tests
    it('should include previousPhaseSummary when provided', async () => {
      const summary = 'Phase 1 created 3 files: service.ts, controller.ts, dto.ts';
      const result = await getPhaseCallback({
        phase: 2,
        includeTest: true,
        previousPhaseSummary: summary,
      });
      expect(result.content[0].text).toContain('Context from Previous Phase');
      expect(result.content[0].text).toContain(summary);
    });

    it('should NOT include summary block when previousPhaseSummary is not provided', async () => {
      const result = await getPhaseCallback({ phase: 2, includeTest: true });
      expect(result.content[0].text).not.toContain('Context from Previous Phase');
    });
  });

  describe('lumina_orchestrate prompt', () => {
    let orchestrateCallback: (args: {
      command?: string;
    }) => Promise<{ messages: { role: string; content: { text: string } }[] }>;

    beforeEach(() => {
      registerOrchestrationController(mockServer as unknown as McpServer);
      orchestrateCallback = mockServer.registerPrompt.mock.calls[0][2];
    });

    it('should replace {{context}} with the provided command', async () => {
      const commandText = 'Implement feature X';
      const result = await orchestrateCallback({ command: commandText });
      const expectedText = SENIOR_SWE_ORCHESTRATION_PROMPT.replace('{{context}}', commandText);

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toBe(expectedText);
    });

    it('should handle undefined command gracefully', async () => {
      const result = await orchestrateCallback({});
      const expectedText = SENIOR_SWE_ORCHESTRATION_PROMPT.replace(
        '{{context}}',
        'No specific command provided.',
      );

      expect(result.messages[0].content.text).toBe(expectedText);
    });
  });
});
