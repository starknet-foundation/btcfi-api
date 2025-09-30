import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  allQuerySchema,
  handleAll,
  handleDates,
  handleLatest,
  latestQuerySchema,
  sendError,
} from './helpers.js';
import type { BorrowingRow } from '../types.js';

function parseLatest(request: FastifyRequest, reply: FastifyReply) {
  const parsed = latestQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    sendError(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return null;
  }
  return parsed.data;
}

function parseAll(request: FastifyRequest, reply: FastifyReply) {
  const parsed = allQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    sendError(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return null;
  }
  return parsed.data;
}

export async function borrowingRoutes(fastify: FastifyInstance) {
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/v1/borrowing/latest',
    handler: async (request, reply) => {
      const query = parseLatest(request, reply);
      if (!query) return;
      await handleLatest<BorrowingRow>({
        dataset: 'borrowing',
        request,
        reply,
        query,
        defaultFormat: 'json',
      });
    },
  });

  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/v1/borrowing/all',
    handler: async (request, reply) => {
      const query = parseAll(request, reply);
      if (!query) return;
      await handleAll<BorrowingRow>({
        dataset: 'borrowing',
        request,
        reply,
        query,
        defaultFormat: 'ndjson',
      });
    },
  });

  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/v1/borrowing/dates',
    handler: async (request, reply) => {
      await handleDates({
        dataset: 'borrowing',
        request,
        reply,
      });
    },
  });
}
