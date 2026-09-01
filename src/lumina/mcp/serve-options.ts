import { parseArgs } from 'node:util';

export type ServeOptions =
  | { transport: 'stdio' }
  | {
      transport: 'http';
      host: string;
      port: number;
      apiKey: string;
    };

type Environment = Record<string, string | undefined>;

export function parseServeOptions(args: string[], environment: Environment): ServeOptions {
  const { values } = parseArgs({
    args,
    options: {
      transport: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'api-key': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  const transport = values.transport ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error('--transport must be either "stdio" or "http".');
  }

  if (transport === 'stdio') {
    if (values.host !== undefined || values.port !== undefined || values['api-key'] !== undefined) {
      throw new Error('--host, --port, and --api-key are only valid with --transport http.');
    }
    return { transport };
  }

  const host = values.host ?? '127.0.0.1';
  if (host.length === 0) {
    throw new Error('--host must not be empty.');
  }

  const portValue = values.port ?? '3000';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535.');
  }

  const apiKey = values['api-key'] ?? environment.LUMINA_MCP_API_KEY;
  if (!apiKey) {
    throw new Error(
      'HTTP transport requires --api-key or the LUMINA_MCP_API_KEY environment variable.',
    );
  }

  return { transport, host, port, apiKey };
}
