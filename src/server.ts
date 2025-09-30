import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import pino from 'pino';
import { fileURLToPath } from 'node:url';
import { getManifest } from './github.js';
import { lendingRoutes } from './routes/lending.js';
import { borrowingRoutes } from './routes/borrowing.js';
import type { HealthPayload } from './types.js';
import { recordMetrics } from './routes/helpers.js';

const isProduction = process.env.NODE_ENV === 'production';

export function buildServer() {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    transport: isProduction
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
  });

  const app = Fastify({
    logger,
    disableRequestLogging: true,
  });

  app.decorateRequest('upstreamMetrics', null);
  app.decorateRequest('requestStart', null);

  app.addHook('onRequest', (request, _reply, done) => {
    request.upstreamMetrics = { cacheHits: [], statuses: [], sources: [] };
    request.requestStart = process.hrtime.bigint();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const durationNs = request.requestStart ? Number(process.hrtime.bigint() - request.requestStart) : 0;
    const durationMs = durationNs / 1_000_000;
    const lengthHeader = reply.getHeader('content-length');
    const bytesSent = Array.isArray(lengthHeader)
      ? Number(lengthHeader[0]) || 0
      : typeof lengthHeader === 'string'
        ? Number(lengthHeader) || 0
        : 0;
    const hits = request.upstreamMetrics?.cacheHits ?? [];
    const statuses = request.upstreamMetrics?.statuses ?? [];
    const cacheHit = hits.length > 0 ? hits.every(Boolean) : false;
    const upstreamStatus = statuses.length > 0 ? statuses.join(',') : undefined;
    const upstreamSources = request.upstreamMetrics?.sources ?? [];

    request.log.info(
      {
        method: request.method,
        path: request.url,
        status: reply.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        cacheHit,
        upstreamStatus,
        bytesSent,
        cacheSources: upstreamSources,
      },
      'request.completed',
    );
    done();
  });

  app.setNotFoundHandler((request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.type('application/json; charset=utf-8');
    reply.code(404).send({ error: 'Not Found', code: 404 });
  });

  app.addHook('onError', (request, reply, error, done) => {
    request.log.error({ err: error }, 'request.error');
    if (!reply.raw.headersSent) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.type('application/json; charset=utf-8');
      reply.code(500).send({ error: 'Internal Server Error', code: 500 });
    }
    done();
  });

  app.register(cors, {
    origin: '*',
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/v1/health',
    handler: async (request, reply) => {
      const payload: HealthPayload = { ok: true };
      let statusCode = 200;

      try {
        const lendingManifest = await getManifest('lending');
        recordMetrics(request, lendingManifest.metrics);
        payload.lendingUpdatedAt = lendingManifest.manifest.updated_at;
      } catch (error) {
        request.log.warn({ err: error }, 'lending manifest unavailable for health');
        statusCode = 206;
      }

      try {
        const borrowingManifest = await getManifest('borrowing');
        recordMetrics(request, borrowingManifest.metrics);
        payload.borrowingUpdatedAt = borrowingManifest.manifest.updated_at;
      } catch (error) {
        request.log.warn({ err: error }, 'borrowing manifest unavailable for health');
        statusCode = 206;
      }

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
      reply.type('application/json; charset=utf-8');

      if (request.method === 'HEAD') {
        reply.code(statusCode).send();
        return;
      }

      reply.code(statusCode).send(payload);
    },
  });

  app.register(lendingRoutes);
  app.register(borrowingRoutes);

  return app;
}

async function start() {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    await app.listen({ port, host });
    const shutdown = async () => {
      app.log.info('Received SIGTERM, shutting down');
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    app.log.error(error, 'Failed to start server');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
}
