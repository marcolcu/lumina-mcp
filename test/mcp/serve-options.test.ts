import { describe, expect, it } from 'vitest';
import { parseServeOptions } from '../../src/lumina/mcp/serve-options.js';

describe('parseServeOptions', () => {
  it('defaults to the local stdio transport', () => {
    expect(parseServeOptions([], {})).toEqual({ transport: 'stdio' });
  });

  it('parses HTTP options and prefers the flag API key', () => {
    expect(
      parseServeOptions(
        [
          '--transport',
          'http',
          '--host',
          '0.0.0.0',
          '--port',
          '8080',
          '--api-key',
          'flag-secret',
        ],
        { LUMINA_MCP_API_KEY: 'env-secret' },
      ),
    ).toEqual({
      transport: 'http',
      host: '0.0.0.0',
      port: 8080,
      apiKey: 'flag-secret',
    });
  });

  it('accepts the API key from the environment', () => {
    expect(
      parseServeOptions(['--transport', 'http'], { LUMINA_MCP_API_KEY: 'env-secret' }),
    ).toEqual({
      transport: 'http',
      host: '127.0.0.1',
      port: 3000,
      apiKey: 'env-secret',
    });
  });

  it('rejects HTTP mode without an API key', () => {
    expect(() => parseServeOptions(['--transport', 'http'], {})).toThrow(/api-key/i);
  });

  it.each(['0', '65536', 'not-a-port'])('rejects invalid HTTP port %s', (port) => {
    expect(() =>
      parseServeOptions(['--transport', 'http', '--port', port, '--api-key', 'secret'], {}),
    ).toThrow(/port/i);
  });
});
