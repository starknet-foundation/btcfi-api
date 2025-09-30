import { LRUCache } from 'lru-cache';
import { request } from 'undici';
import { Dataset, GithubFetchMetrics, Manifest } from './types.js';

const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com';

let cachedOwner: string | null = null;
let cachedRepo: string | null = null;
let cachedBranch: string | null = null;

const maxEntries = Number(process.env.CACHE_MAX_ENTRIES ?? '500');
const manifestTtlSeconds = Number(process.env.MANIFEST_TTL_SECONDS ?? '60');
const dataTtlSeconds = Number(process.env.DATA_TTL_SECONDS ?? '300');

const cache = new LRUCache<string, CacheEntry>({
  max: Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 500,
  ttlAutopurge: false,
});

export class UpstreamNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamNotFoundError';
  }
}

export class UpstreamUnavailableError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'UpstreamUnavailableError';
    this.statusCode = statusCode;
  }
}

interface CacheEntry {
  body: Buffer;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  statusCode?: number;
}

interface FetchOptions {
  ttlSeconds: number;
  source: string;
  path: string;
}

interface FetchResult {
  buffer: Buffer;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  metrics: GithubFetchMetrics;
}

function getOwner() {
  if (!cachedOwner) {
    cachedOwner = requiredEnv('GITHUB_OWNER');
  }
  return cachedOwner;
}

function getRepo() {
  if (!cachedRepo) {
    cachedRepo = requiredEnv('GITHUB_REPO');
  }
  return cachedRepo;
}

function getBranch() {
  if (!cachedBranch) {
    cachedBranch = process.env.GITHUB_BRANCH ?? 'main';
  }
  return cachedBranch;
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function cacheKey(source: string, path: string): string {
  return `${source}:${path}`;
}

async function fetchResource({ ttlSeconds, source, path }: FetchOptions): Promise<FetchResult> {
  const key = cacheKey(source, path);
  const cached = cache.get(key, { allowStale: true });
  const remainingTtl = cache.getRemainingTTL(key) ?? 0;
  const isFresh = cached !== undefined && remainingTtl > 0;

  if (cached && isFresh) {
    return {
      buffer: cached.body,
      etag: cached.etag,
      lastModified: cached.lastModified,
      contentType: cached.contentType,
      metrics: {
        cacheHit: true,
        upstreamStatus: cached.statusCode ?? 200,
        servedStale: false,
        source,
      },
    };
  }

  const headers: Record<string, string> = {};
  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  const base = (process.env.RAW_BASE ?? DEFAULT_RAW_BASE).replace(/\/$/, '');
  const owner = getOwner();
  const repo = getRepo();
  const branch = getBranch();
  const url = `${base}/${owner}/${repo}/${branch}/${path}`;

  const response = await request(url, {
    method: 'GET',
    headers,
  });

  const statusCode = response.statusCode;

  if (statusCode === 304 && cached) {
    cache.set(
      key,
      { ...cached, statusCode },
      { ttl: ttlSeconds * 1000 },
    );

    return {
      buffer: cached.body,
      etag: cached.etag,
      lastModified: cached.lastModified,
      contentType: cached.contentType,
      metrics: {
        cacheHit: true,
        upstreamStatus: statusCode,
        servedStale: false,
        source,
      },
    };
  }

  if (statusCode === 404) {
    if (cached) {
      return {
        buffer: cached.body,
        etag: cached.etag,
        lastModified: cached.lastModified,
        contentType: cached.contentType,
        metrics: {
          cacheHit: true,
          upstreamStatus: statusCode,
          servedStale: true,
          source,
        },
      };
    }
    throw new UpstreamNotFoundError(`Resource not found upstream: ${path}`);
  }

  if (statusCode >= 400) {
    if (cached) {
      return {
        buffer: cached.body,
        etag: cached.etag,
        lastModified: cached.lastModified,
        contentType: cached.contentType,
        metrics: {
          cacheHit: true,
          upstreamStatus: statusCode,
          servedStale: true,
          source,
        },
      };
    }
    throw new UpstreamUnavailableError(`Upstream request failed for ${path}`, statusCode);
  }

  const text = await response.body.text();
  const buffer = Buffer.from(text, 'utf8');
  const newEntry: CacheEntry = {
    body: buffer,
    etag: firstHeader(response.headers.etag),
    lastModified: firstHeader(response.headers['last-modified']),
    contentType: firstHeader(response.headers['content-type']),
    statusCode,
  };
  cache.set(key, newEntry, { ttl: ttlSeconds * 1000 });

  return {
    buffer,
    etag: newEntry.etag,
    lastModified: newEntry.lastModified,
    contentType: newEntry.contentType,
    metrics: {
      cacheHit: false,
      upstreamStatus: statusCode,
      servedStale: false,
      source,
    },
  };
}

function parseJson<T>(buffer: Buffer, path: string): T {
  try {
    return JSON.parse(buffer.toString('utf8')) as T;
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${path}: ${(error as Error).message}`);
  }
}

export async function getManifest(dataset: Dataset): Promise<{ manifest: Manifest; etag?: string; updatedAt?: string; metrics: GithubFetchMetrics; }>
{
  const path = `meta/${dataset}_manifest.json`;
  const result = await fetchResource({
    ttlSeconds: manifestTtlSeconds,
    source: `manifest:${dataset}`,
    path,
  });

  const manifest = parseJson<Manifest>(result.buffer, path);
  return {
    manifest,
    etag: result.etag,
    updatedAt: manifest.updated_at,
    metrics: result.metrics,
  };
}

export async function getDailyDataset<T>(dataset: Dataset, date: string): Promise<{ data: T[]; etag?: string; lastModified?: string; metrics: GithubFetchMetrics; }>
{
  const path = `data/${dataset}/${date}.json`;
  const result = await fetchResource({
    ttlSeconds: dataTtlSeconds,
    source: `${dataset}:${date}`,
    path,
  });

  const data = parseJson<T[]>(result.buffer, path);
  return {
    data,
    etag: result.etag,
    lastModified: result.lastModified,
    metrics: result.metrics,
  };
}

export function invalidateCache() {
  cache.clear();
}

export function resetGithubConfig() {
  cachedOwner = null;
  cachedRepo = null;
  cachedBranch = null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
