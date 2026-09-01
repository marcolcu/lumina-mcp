import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLuminaMcpServer } from '../mcp_server.js';

export interface HttpMcpServerOptions {
  host?: string;
  port?: number;
  apiKey: string;
}

export interface HttpMcpServerHandle {
  server: Server;
  close(): Promise<void>;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function hashApiKey(apiKey: string): Buffer {
  return createHash('sha256').update(apiKey).digest();
}

function getBearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    return undefined;
  }
  return authorization.slice('Bearer '.length);
}

export function isAuthorizedRequest(request: IncomingMessage, expectedApiKey: string): boolean {
  const providedApiKey = getBearerToken(request);
  if (providedApiKey === undefined) {
    return false;
  }

  return timingSafeEqual(hashApiKey(providedApiKey), hashApiKey(expectedApiKey));
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  apiKey: string,
): Promise<void> {
  if (requestPath(request) !== '/mcp') {
    writeJson(response, 404, { error: 'Not found.' });
    return;
  }

  if (!isAuthorizedRequest(request, apiKey)) {
    writeJson(response, 401, { error: 'Unauthorized.' }, { 'www-authenticate': 'Bearer' });
    return;
  }

  if (request.method !== 'POST') {
    writeJson(
      response,
      405,
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      },
      { allow: 'POST' },
    );
    return;
  }

  const mcpServer = createLuminaMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response);
  } finally {
    await mcpServer.close();
  }
}

export async function startHttpMcpServer(
  options: HttpMcpServerOptions,
): Promise<HttpMcpServerHandle> {
  if (!options.apiKey) {
    throw new Error('HTTP transport requires a non-empty API key.');
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  const server = createServer((request, response) => {
    void handleMcpRequest(request, response, options.apiKey).catch((error: unknown) => {
      console.error('HTTP MCP request failed:', error);
      if (!response.headersSent) {
        writeJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error.' },
          id: null,
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const handleStartupError = (error: Error) => reject(error);
    server.once('error', handleStartupError);
    server.listen(port, host, () => {
      server.off('error', handleStartupError);
      resolve();
    });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
