import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDailyDataset, getManifest, UpstreamNotFoundError, UpstreamUnavailableError } from '../github.js';
import type {
  BorrowingRow,
  Dataset,
  GithubFetchMetrics,
  LendingRow,
  Manifest,
  NdjsonEnvelope,
  PaginatedEnvelope,
} from '../types.js';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const latestQuerySchema = z.object({
  protocol: z.string().min(1).optional(),
  format: z.enum(['json', 'ndjson']).optional(),
});

export const allQuerySchema = z.object({
  protocol: z.string().min(1).optional(),
  from: z.string().regex(isoDateRegex, 'Invalid from date, expected YYYY-MM-DD').optional(),
  to: z.string().regex(isoDateRegex, 'Invalid to date, expected YYYY-MM-DD').optional(),
  format: z.enum(['json', 'ndjson']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(10000).optional(),
});

export type LatestQuery = z.infer<typeof latestQuerySchema>;
export type AllQuery = z.infer<typeof allQuerySchema>;

interface CommonRouteContext {
  dataset: Dataset;
  request: FastifyRequest;
  reply: FastifyReply;
}

interface LatestHandlerContext<Row> extends CommonRouteContext {
  query: LatestQuery;
  defaultFormat: 'json' | 'ndjson';
}

interface AllHandlerContext<Row> extends CommonRouteContext {
  query: AllQuery;
  defaultFormat: 'json' | 'ndjson';
}

export async function handleLatest<Row extends LendingRow | BorrowingRow>(ctx: LatestHandlerContext<Row>) {
  const { request, reply, dataset, query, defaultFormat } = ctx;

  const manifestRes = await safeGetManifest(dataset, request, reply);
  if (!manifestRes) return;
  const { manifest, etag, metrics } = manifestRes;
  recordMetrics(request, metrics);

  const latestDate = manifest.latest;
  if (!latestDate) {
    sendError(reply, 404, 'No data available for latest date');
    return;
  }

  const protocol = query.protocol;
  const format = resolveFormat(request, query.format, defaultFormat);
  reply.header('Vary', 'Accept');

  const dataRes = await safeGetDaily<Row>(dataset, latestDate, request, reply);
  if (!dataRes) return;
  const { data, etag: dataEtag, metrics: dataMetrics } = dataRes;
  recordMetrics(request, dataMetrics);

  const filtered = protocol ? data.filter((row) => row.protocol === protocol) : data;
  const envelope = {
    dataset,
    asOfDate: latestDate,
    updatedAt: manifest.updated_at,
    filters: protocol ? { protocol } : {},
    count: filtered.length,
  } as const;

  const upstreamEtag = dataEtag ?? etag;
  const clientHeader = request.headers['if-none-match'];
  const clientEtag = Array.isArray(clientHeader) ? clientHeader[0] : clientHeader;
  if (clientEtag && upstreamEtag && clientEtag === upstreamEtag) {
    applyHeaders(reply, format, upstreamEtag);
    reply.code(304).send();
    return;
  }

  if (request.method === 'HEAD') {
    applyHeaders(reply, format, upstreamEtag ?? undefined);
    reply.status(200).send();
    return;
  }

  if (format === 'ndjson') {
    applyHeaders(reply, 'ndjson', upstreamEtag ?? undefined);
    const lines = [JSON.stringify({ ...envelope, data: undefined })];
    for (const row of filtered) {
      lines.push(JSON.stringify(row));
    }
    reply.send(`${lines.join('\n')}\n`);
    return;
  }

  applyHeaders(reply, 'json', upstreamEtag ?? undefined);
  reply.send({ ...envelope, data: filtered });
}

export async function handleAll<Row extends LendingRow | BorrowingRow>(ctx: AllHandlerContext<Row>) {
  const { request, reply, dataset, query, defaultFormat } = ctx;

  const manifestRes = await safeGetManifest(dataset, request, reply);
  if (!manifestRes) return;
  const { manifest, metrics } = manifestRes;
  recordMetrics(request, metrics);

  const range = resolveRange(query, manifest);
  if (!range) {
    sendError(reply, 400, '`from` must be less than or equal to `to`');
    return;
  }

  const format = resolveFormat(request, query.format, defaultFormat);
  const protocol = query.protocol;
  reply.header('Vary', 'Accept');

  const dates = manifest.dates.filter((date) => inRange(date, range.from, range.to));
  if (dates.length === 0) {
    if (request.method === 'HEAD') {
      applyHeaders(reply, format, undefined);
      reply.status(200).send();
      return;
    }
    if (format === 'ndjson') {
      applyHeaders(reply, 'ndjson', undefined);
      const body = `${JSON.stringify({ dataset, range, filters: protocol ? { protocol } : {} })}\n`;
      reply.send(body);
      return;
    }
    applyHeaders(reply, 'json', undefined);
    const envelope: PaginatedEnvelope = {
      dataset,
      range,
      filters: protocol ? { protocol } : {},
      page: query.page ?? 1,
      perPage: query.per_page ?? 1000,
      total: 0,
    };
    reply.send({ ...envelope, data: [] });
    return;
  }

  const rowsByDate: Row[][] = [];
  for (const date of dates) {
    const dataRes = await safeGetDaily<Row>(dataset, date, request, reply);
    if (!dataRes) {
      return;
    }
    const { data, metrics: metricsForDay } = dataRes;
    recordMetrics(request, metricsForDay);
    const filteredRows = protocol ? data.filter((row) => row.protocol === protocol) : data;
    rowsByDate.push(filteredRows);
  }

  if (format === 'ndjson') {
    if (request.method === 'HEAD') {
      applyHeaders(reply, 'ndjson', undefined);
      reply.status(200).send();
      return;
    }
    applyHeaders(reply, 'ndjson', undefined);
    reply.header('Vary', 'Accept');
    const lines = [JSON.stringify({ dataset, range, filters: protocol ? { protocol } : {} })];
    for (const rows of rowsByDate) {
      for (const row of rows) {
        lines.push(JSON.stringify(row));
      }
    }
    reply.send(`${lines.join('\n')}\n`);
    return;
  }

  const page = query.page ?? 1;
  const perPage = query.per_page ?? 1000;

  const allRows = rowsByDate.flat();
  const total = allRows.length;
  const start = (page - 1) * perPage;
  const paginated = allRows.slice(start, start + perPage);
  const envelope: PaginatedEnvelope = {
    dataset,
    range,
    filters: protocol ? { protocol } : {},
    page,
    perPage,
    total,
  };

  if (request.method === 'HEAD') {
    applyHeaders(reply, 'json', undefined);
    reply.header('Vary', 'Accept');
    reply.status(200).send();
    return;
  }

  applyHeaders(reply, 'json', undefined);
  reply.header('Vary', 'Accept');
  reply.send({ ...envelope, data: paginated });
}

export async function handleDates(ctx: CommonRouteContext) {
  const { dataset, request, reply } = ctx;
  const manifestRes = await safeGetManifest(dataset, request, reply);
  if (!manifestRes) return;
  const { manifest, metrics, etag } = manifestRes;
  recordMetrics(request, metrics);

  const clientHeader = request.headers['if-none-match'];
  const clientEtag = Array.isArray(clientHeader) ? clientHeader[0] : clientHeader;
  if (clientEtag && etag && clientEtag === etag) {
    applyHeaders(reply, 'json', etag);
    reply.code(304).send();
    return;
  }

  if (request.method === 'HEAD') {
    applyHeaders(reply, 'json', etag);
    reply.status(200).send();
    return;
  }

  applyHeaders(reply, 'json', etag);
  reply.send({ dataset, latest: manifest.latest, updatedAt: manifest.updated_at, dates: manifest.dates });
}

async function safeGetManifest(dataset: Dataset, request: FastifyRequest, reply: FastifyReply) {
  try {
    return await getManifest(dataset);
  } catch (error) {
    if (error instanceof UpstreamNotFoundError) {
      sendError(reply, 404, 'Manifest not found');
      return null;
    }
    if (error instanceof UpstreamUnavailableError) {
      sendError(reply, error.statusCode, 'Upstream manifest unavailable');
      return null;
    }
    request.log.error({ err: error }, 'Failed to fetch manifest');
    sendError(reply, 502, 'Failed to fetch manifest');
    return null;
  }
}

async function safeGetDaily<Row>(dataset: Dataset, date: string, request: FastifyRequest, reply: FastifyReply) {
  try {
    return await getDailyDataset<Row>(dataset, date);
  } catch (error) {
    if (error instanceof UpstreamNotFoundError) {
      sendError(reply, 404, `Data not found for ${date}`);
      return null;
    }
    if (error instanceof UpstreamUnavailableError) {
      sendError(reply, error.statusCode, 'Upstream data unavailable');
      return null;
    }
    request.log.error({ err: error, dataset, date }, 'Failed to fetch dataset');
    sendError(reply, 502, 'Failed to fetch dataset');
    return null;
  }
}

function resolveFormat(
  request: FastifyRequest,
  queryFormat: 'json' | 'ndjson' | undefined,
  defaultFormat: 'json' | 'ndjson',
): 'json' | 'ndjson' {
  if (queryFormat) {
    return queryFormat;
  }
  const accept = request.headers.accept;
  if (accept && accept.includes('application/x-ndjson')) {
    return 'ndjson';
  }
  if (accept && accept.includes('application/json')) {
    return 'json';
  }
  return defaultFormat;
}

function resolveRange(query: AllQuery, manifest: Manifest) {
  const from = query.from ?? manifest.dates[0];
  const to = query.to ?? manifest.dates[manifest.dates.length - 1];
  if (from && to && from > to) {
    return null;
  }
  return { from, to };
}

function inRange(date: string, from?: string, to?: string) {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function applyHeaders(reply: FastifyReply, format: 'json' | 'ndjson', etag?: string) {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  if (format === 'ndjson') {
    reply.type('application/x-ndjson; charset=utf-8');
  } else {
    reply.type('application/json; charset=utf-8');
  }
  if (etag) {
    reply.header('ETag', etag);
  }
}

export function sendError(reply: FastifyReply, statusCode: number, message: string) {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.type('application/json; charset=utf-8');
  reply.code(statusCode).send({ error: message, code: statusCode });
}

export function recordMetrics(request: FastifyRequest, metrics: GithubFetchMetrics) {
  const ctx = request.upstreamMetrics;
  if (!ctx) return;
  ctx.cacheHits.push(metrics.cacheHit);
  if (typeof metrics.upstreamStatus === 'number') {
    ctx.statuses.push(metrics.upstreamStatus);
  }
  ctx.sources.push(metrics.source);
}
