import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockResponseOptions {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

const responseQueue: MockResponseOptions[] = [];
const requestMock = vi.fn(async (_url: string) => {
  const next = responseQueue.shift();
  if (!next) {
    throw new Error('No mock response queued');
  }
  return {
    statusCode: next.statusCode,
    headers: next.headers ?? {},
    body: {
      async text() {
        return next.body ?? '';
      },
    },
  };
});

vi.mock('undici', () => ({
  request: requestMock,
}));

describe('github fetch layer', () => {
  beforeEach(() => {
    vi.resetModules();
    requestMock.mockClear();
    responseQueue.length = 0;
    process.env.GITHUB_OWNER = 'test-owner';
    process.env.GITHUB_REPO = 'test-repo';
    process.env.DATA_TTL_SECONDS = '1';
    process.env.MANIFEST_TTL_SECONDS = '1';
    process.env.CACHE_MAX_ENTRIES = '5';
  });

  afterEach(async () => {
    const github = await import('../src/github.js');
    github.invalidateCache();
    github.resetGithubConfig();
  });

  it('caches dataset responses and avoids extra upstream calls', async () => {
    responseQueue.push({
      statusCode: 200,
      body: JSON.stringify([{ protocol: 'Vesu' }]),
      headers: { etag: 'etag-1', 'content-type': 'application/json' },
    });

    const github = await import('../src/github.js');
    const first = await github.getDailyDataset('lending', '2025-09-30');
    expect(first.metrics.cacheHit).toBe(false);
    expect(first.data).toHaveLength(1);
    expect(requestMock).toHaveBeenCalledTimes(1);

    const second = await github.getDailyDataset('lending', '2025-09-30');
    expect(second.metrics.cacheHit).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('serves stale data when upstream error occurs after ttl expiry', async () => {
    responseQueue.push({
      statusCode: 200,
      body: JSON.stringify([{ protocol: 'Vesu' }]),
      headers: { etag: 'etag-1', 'content-type': 'application/json' },
    });

    const github = await import('../src/github.js');
    await github.getDailyDataset('borrowing', '2025-09-29');
    expect(requestMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    responseQueue.push({ statusCode: 502, body: 'bad gateway' });
    const result = await github.getDailyDataset('borrowing', '2025-09-29');
    expect(result.metrics.cacheHit).toBe(true);
    expect(result.metrics.servedStale).toBe(true);
    expect(result.metrics.upstreamStatus).toBe(502);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('handles manifest 304 revalidation', async () => {
    responseQueue.push({
      statusCode: 200,
      body: JSON.stringify({
        latest: '2025-09-30',
        dates: ['2025-09-30'],
        updated_at: '2025-09-30T00:00:00Z',
        schema_version: 1,
      }),
      headers: { etag: 'etag-manifest', 'content-type': 'application/json' },
    });

    const github = await import('../src/github.js');
    const first = await github.getManifest('lending');
    expect(first.metrics.cacheHit).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    responseQueue.push({ statusCode: 304, headers: { etag: 'etag-manifest' } });
    const second = await github.getManifest('lending');
    expect(second.metrics.cacheHit).toBe(true);
    expect(second.metrics.upstreamStatus).toBe(304);
  });
});
