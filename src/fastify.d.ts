import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    upstreamMetrics: {
      cacheHits: boolean[];
      statuses: number[];
      sources: string[];
    };
    requestStart: bigint;
  }
}
