# BTCFi Public API

This service exposes Starknet Foundation BTCFi lending and borrowing datasets over HTTP. All endpoints are read-only and return JSON or NDJSON. The base path is `/v1` and CORS is enabled for `*`.

## Endpoints

### Health
- `GET /v1/health`
  - Response: `{ ok: true, lendingUpdatedAt?, borrowingUpdatedAt? }`
  - Status `206` if only one manifest is reachable.

### Lending
- `GET /v1/lending/latest`
  - Query params:
    - `protocol` (optional): exact match on `protocol` field.
    - `format` (optional): `json` (default) or `ndjson`.
  - JSON response shape:
    ```json
    {
      "dataset": "lending",
      "asOfDate": "YYYY-MM-DD",
      "updatedAt": "ISO-UTC",
      "filters": { "protocol": "..." },
      "count": 123,
      "data": [ /* LendingRow objects */ ]
    }
    ```
  - NDJSON: envelope line (without `data`) followed by one JSON row per line.

- `GET /v1/lending/all`
  - Default format is NDJSON.
  - Query params:
    - `protocol` (optional)
    - `from` / `to` (optional, `YYYY-MM-DD`)
    - `format` (`ndjson` default, or `json`)
    - `page`, `per_page` (JSON format only, defaults `1` / `1000`, `per_page` ≤ 10000)
  - NDJSON: first line envelope, then rows across all included dates.
  - JSON: envelope `{ dataset, range, filters, page, perPage, total, data }`.

- `GET /v1/lending/dates`
  - Convenience manifest proxy: `{ dataset: "lending", latest, updatedAt, dates }`.

### Borrowing
Same contract as lending, replacing the route prefix:
- `GET /v1/borrowing/latest`
- `GET /v1/borrowing/all`
- `GET /v1/borrowing/dates`

Borrowing rows follow this shape:
```json
{
  "protocol": "...",
  "date": "YYYY-MM-DD",
  "poolId": "...",
  "poolName": "...",
  "collateralSymbol": "...",
  "debtSymbol": "...",
  "interestUsd": "...",
  "rebateUsd": "...",
  "rebatePercent": "...",
  "strkAllocation": "...",
  "apr": "..."
}
```

## Response Headers & Caching
- `Access-Control-Allow-Origin: *`
- `Cache-Control: public, max-age=300, stale-while-revalidate=86400`
- `Content-Type`: `application/json; charset=utf-8` or `application/x-ndjson; charset=utf-8`
- `ETag` is forwarded when the upstream manifest/day file provides one. Supply `If-None-Match` to receive `304 Not Modified`.

## Error Format
```json
{ "error": "message", "code": 4xx_or_5xx }
```
- `400`: invalid query parameters (e.g., malformed dates, `from > to`).
- `404`: manifest or requested day data not found.
- `502`: upstream fetch failed and no cached copy available.

## Example Requests
```bash
# Health check
curl https://api.example.com/v1/health

# Latest lending snapshot for all protocols
curl https://api.example.com/v1/lending/latest

# Latest lending data filtered to the Opus protocol (JSON)
curl "https://api.example.com/v1/lending/latest?protocol=Opus"

# Same data as NDJSON
curl "https://api.example.com/v1/lending/latest?protocol=Opus&format=ndjson"

# Full lending history for a date range in NDJSON (default)
curl "https://api.example.com/v1/lending/all?protocol=Opus&from=2025-09-01&to=2025-09-30"

# Paginated JSON borrowing records
curl "https://api.example.com/v1/borrowing/all?format=json&page=2&per_page=500"
```

Replace `https://api.example.com` with the deployed host; `localhost:3000` works for local testing.

## Content Negotiation
- Setting `format=ndjson` or header `Accept: application/x-ndjson` streams NDJSON.
- `format=json` or `Accept: application/json` returns JSON payloads.

## Notes
- `protocol` filtering uses case-sensitive exact matches.
- Date filters (`from`, `to`) are inclusive.
- NDJSON responses omit `ETag` when aggregating multiple upstream files.
