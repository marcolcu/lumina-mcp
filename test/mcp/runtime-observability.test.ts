import { describe, expect, it } from 'vitest';
import { getRuntimeStats, trackRequest } from '../../src/lumina/mcp/runtime-observability.js';

describe('MCP runtime observability', () => {
  it('reports process memory and tracks requests until handlers settle', async () => {
    let release!: () => void;
    const request = trackRequest(async () => new Promise<void>((resolve) => { release = resolve; }))();
    const active = getRuntimeStats();
    expect(active.activeRequests).toBe(1);
    expect(active.rssBytes).toBeGreaterThan(0);
    expect(active.heapUsedBytes).toBeGreaterThan(0);
    expect(active.heapTotalBytes).toBeGreaterThan(0);
    expect(active.externalBytes).toBeGreaterThan(0);
    expect(active.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(active.caches).toHaveProperty('mysqlPools');
    expect(active.caches).toHaveProperty('postgresPools');

    release();
    await request;
    expect(getRuntimeStats().activeRequests).toBe(0);
  });
});
