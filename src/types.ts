export type Dataset = 'lending' | 'borrowing';

export interface Manifest {
  latest: string;
  dates: string[];
  updated_at: string;
  schema_version: number;
}

export type LendingRow = {
  protocol: string;
  date: string;
  poolId: string;
  poolName: string;
  collateralSymbol: string;
  collateralValue: string | null;
  collateralUsdValue: string | null;
  strkAllocation: string | null;
  effectiveApr: string | null;
};

export type BorrowingRow = {
  protocol: string;
  date: string;
  poolId: string;
  poolName: string;
  collateralSymbol: string;
  debtSymbol: string;
  interestUsd: string | null;
  rebateUsd: string | null;
  rebatePercent: string | null;
  strkAllocation: string | null;
  apr: string | null;
};

export type LendingEnvelope = {
  dataset: 'lending';
  asOfDate: string;
  updatedAt: string;
  filters: Record<string, string | undefined>;
  count: number;
};

export type BorrowingEnvelope = {
  dataset: 'borrowing';
  asOfDate: string;
  updatedAt: string;
  filters: Record<string, string | undefined>;
  count: number;
};

export type Range = {
  from?: string;
  to?: string;
};

export type PaginatedEnvelope = {
  dataset: Dataset;
  range: Range;
  filters: Record<string, string | undefined>;
  page: number;
  perPage: number;
  total: number;
};

export type NdjsonEnvelope = {
  dataset: Dataset;
  range?: Range;
  filters: Record<string, string | undefined>;
  asOfDate?: string;
  updatedAt?: string;
};

export interface HealthPayload {
  ok: true;
  lendingUpdatedAt?: string;
  borrowingUpdatedAt?: string;
}

export interface GithubFetchMetrics {
  cacheHit: boolean;
  upstreamStatus?: number;
  servedStale: boolean;
  source: string;
}
