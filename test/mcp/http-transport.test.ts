import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpMcpServerHandle } from '../../src/lumina/mcp/transports/http.transport.js';
import { startHttpMcpServer } from '../../src/lumina/mcp/transports/http.transport.js';

const handles: HttpMcpServerHandle[] = [];

async function startServer(apiKey = 'test-secret'): Promise<string> {
  const handle = await startHttpMcpServer({ host: '127.0.0.1', port: 0, apiKey });
  handles.push(handle);
  const address = handle.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe('HTTP MCP transport', () => {
  it('rejects requests without a valid API key', async () => {
    const baseUrl = await startServer();

    const missing = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
    });

    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(wrong.status).toBe(401);
  });

  it('returns 404 outside the MCP endpoint', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(404);
  });

  it('handles an authenticated MCP initialize request', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'lumina-test', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const payload = (await response.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(payload.result?.serverInfo?.name).toBe('lumina-mcp');
  });
});
