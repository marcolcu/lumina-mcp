import { test, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('sdk exports', () => {
    expect(McpServer).toBeDefined();
    expect(Client).toBeDefined();
    expect(InMemoryTransport).toBeDefined();
});
