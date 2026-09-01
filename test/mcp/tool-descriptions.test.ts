import { describe, expect, it } from 'vitest';
import { createLuminaMcpServer } from '../../src/lumina/mcp/mcp_server.js';

interface RegisteredToolDescription {
  name: string;
  description?: string;
}

interface ServerWithHandlers {
  _requestHandlers: Map<
    string,
    (request: { method: string }) => Promise<{ tools?: RegisteredToolDescription[] }>
  >;
}

describe('MCP tool descriptions', () => {
  it('tell the model when to choose each tool', async () => {
    const server = createLuminaMcpServer();
    const listHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
      'tools/list',
    );

    const response = await listHandler!({ method: 'tools/list' });
    const missingGuidance = (response.tools ?? [])
      .filter(
        (tool) =>
          !/\b(use (this|when|only|after|before)|prefer this)\b/i.test(tool.description ?? ''),
      )
      .map((tool) => tool.name);

    expect(missingGuidance).toEqual([]);
  });
});
