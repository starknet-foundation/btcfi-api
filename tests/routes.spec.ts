import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BorrowingRow, LendingRow, Manifest } from '../src/types.js';

vi.mock('../src/github.js', () => {
  class UpstreamNotFoundError extends Error {}
  class UpstreamUnavailableError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 502) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  type DatasetKey = 'lending' | 'borrowing';
  interface DatasetEntry {
    data: Array<LendingRow | BorrowingRow>;
    etag?: string;
    lastModified?: string;
  }

  const manifests = new Map<DatasetKey, { manifest: Manifest; etag?: string }>();
  const datasets = new Map<string, DatasetEntry>();

  const metrics = {
    cacheHit: false,
    upstreamStatus: 200,
    servedStale: false,
    source: 'mock',
  } as const;

  return {
    __setManifest(dataset: DatasetKey, manifest: Manifest, etag?: string) {
      manifests.set(dataset, { manifest, etag });
    },
    __setDataset(dataset: DatasetKey, date: string, entry?: DatasetEntry) {
      if (!entry) {
        datasets.delete(`${dataset}:${date}`);
        return;
      }
      datasets.set(`${dataset}:${date}`, entry);
    },
    __clear() {
      manifests.clear();
      datasets.clear();
    },
    getManifest: vi.fn(async (dataset: DatasetKey) => {
      const entry = manifests.get(dataset);
      if (!entry) {
        throw new UpstreamNotFoundError(`manifest missing for ${dataset}`);
      }
      return { manifest: entry.manifest, etag: entry.etag, metrics };
    }),
    getDailyDataset: vi.fn(async (dataset: DatasetKey, date: string) => {
      const entry = datasets.get(`${dataset}:${date}`);
      if (!entry) {
        throw new UpstreamNotFoundError(`data missing for ${dataset}:${date}`);
      }
      return { data: entry.data, etag: entry.etag, lastModified: entry.lastModified, metrics };
    }),
    invalidateCache: vi.fn(),
    resetGithubConfig: vi.fn(),
    UpstreamNotFoundError,
    UpstreamUnavailableError,
  };
});

async function createServer() {
  const githubMock = (await import('../src/github.js')) as any;
  githubMock.__clear();

  const lendingManifest: Manifest = {
    latest: '2025-09-30',
    dates: ['2025-09-28', '2025-09-30'],
    updated_at: '2025-09-30T00:00:00Z',
    schema_version: 1,
  };

  const borrowingManifest: Manifest = {
    latest: '2025-09-30',
    dates: ['2025-09-30'],
    updated_at: '2025-09-30T00:00:00Z',
    schema_version: 1,
  };

  githubMock.__setManifest('lending', lendingManifest, 'etag-manifest-l');
  githubMock.__setManifest('borrowing', borrowingManifest, 'etag-manifest-b');

  const lendingRowBase: LendingRow = {
    protocol: 'Vesu',
    date: '2025-09-30',
    poolId: 'pool-1',
    poolName: 'Pool One',
    collateralSymbol: 'BTC',
    collateralValue: '10',
    collateralUsdValue: '250000',
    strkAllocation: '100',
    effectiveApr: '0.12',
  };

  githubMock.__setDataset('lending', '2025-09-30', {
    data: [
      lendingRowBase,
      { ...lendingRowBase, protocol: 'Alpha', poolId: 'pool-2' },
    ],
    etag: 'etag-lending-2025-09-30',
  });

  const lendingHistoric: LendingRow = {
    ...lendingRowBase,
    date: '2025-09-28',
    poolId: 'pool-0',
  };

  githubMock.__setDataset('lending', '2025-09-28', {
    data: [lendingHistoric],
    etag: 'etag-lending-2025-09-28',
  });

  const borrowingRowBase: BorrowingRow = {
    protocol: 'Vesu',
    date: '2025-09-30',
    poolId: 'pool-1',
    poolName: 'Pool One',
    collateralSymbol: 'BTC',
    debtSymbol: 'USDC',
    interestUsd: '1000',
    rebateUsd: '100',
    rebatePercent: '0.1',
    strkAllocation: '90',
    apr: '0.2',
  };

  githubMock.__setDataset('borrowing', '2025-09-30', {
    data: [
      borrowingRowBase,
      { ...borrowingRowBase, protocol: 'Other', poolId: 'pool-2' },
      { ...borrowingRowBase, protocol: 'Other', poolId: 'pool-3' },
    ],
    etag: 'etag-borrowing-2025-09-30',
  });

  const { buildServer } = await import('../src/server.js');
  const server = buildServer();
  await server.ready();
  return server;
}

type AppInstance = Awaited<ReturnType<typeof createServer>>;

let app: AppInstance;

beforeEach(async () => {
  app = await createServer();
});

afterEach(async () => {
  await app.close();
});

describe('lending routes', () => {
  it('returns 400 when from > to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/lending/all?from=2025-09-30&to=2025-09-28',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({ error: expect.any(String), code: 400 });
  });

  it('filters by protocol on latest json response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/lending/latest?protocol=Vesu',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.count).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].protocol).toBe('Vesu');
  });

  it('streams NDJSON by default for /all', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/lending/all' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    const text = response.payload;
    const lines = text.trim().split('\n');
    expect(lines[0]).toContain('"dataset":"lending"');
    expect(JSON.parse(lines[1]).protocol).toBeDefined();
  });

  it('returns paginated JSON when requested', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/borrowing/all?format=json&page=2&per_page=1',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.page).toBe(2);
    expect(body.perPage).toBe(1);
    expect(body.total).toBe(3);
    expect(body.data).toHaveLength(1);
  });

  it('returns 304 when If-None-Match matches dataset etag', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/lending/latest',
      headers: { 'if-none-match': 'etag-lending-2025-09-30' },
    });
    expect(response.statusCode).toBe(304);
  });

  it('returns 404 when dataset missing', async () => {
    const githubMock = (await import('../src/github.js')) as any;
    githubMock.__setDataset('lending', '2025-09-30', undefined);

    const response = await app.inject({ method: 'GET', url: '/v1/lending/latest' });
    expect(response.statusCode).toBe(404);
  });
});
