# Bitcoin Energy GraphQL API

This repository contains a solution for the Sensorfact backend engineering assignment. It exposes a GraphQL API that estimates the energy consumption of Bitcoin transactions using transaction size data from Blockchain.com.

## Energy model

The assignment defines a fixed energy cost per transaction byte:

```text
energy (kWh) = transaction size (bytes) × 4.56
```

All block, daily, and wallet totals are calculated from transaction sizes. The full serialized block size is not used for the energy calculation.

## Features

- Health-check GraphQL query.
- Energy consumption for every transaction in a Bitcoin block.
- Total transaction energy for the last `x` UTC days.
- Optional inclusion of the current incomplete UTC day.
- Total energy for all unique transactions associated with a wallet.
- In-memory TTL/LRU caching.
- Coalescing of concurrent requests for the same upstream resource.
- Bounded concurrency for daily and wallet aggregation.
- Wallet pagination in pages of 50 transactions.
- Runtime validation of Blockchain.com responses.
- Retry handling for rate limiting and temporary upstream failures.
- Structured GraphQL error codes.
- Unit tests for the client, cache, and energy service.

## Technology

- Node.js 20
- TypeScript
- GraphQL
- AWS Lambda
- Blockchain.com public API

## Run locally

### Requirements

- Node.js 20
- Yarn 1.x

The repository contains an `.nvmrc` file, so users with NVM can select the expected Node.js version with:

```bash
nvm use
```

### Install dependencies

```bash
yarn
```

### Compile

```bash
yarn compile
```

This runs TypeScript without emitting JavaScript and reports type errors.

### Run tests

```bash
yarn test
```

### Start the local GraphQL server

```bash
yarn start
```

The endpoint is available at:

```text
http://localhost:4000/graphql
```

## GraphQL operations

## Health check

```graphql
query Health {
  hello
}
```

Expected response:

```json
{
  "data": {
    "hello": "Bitcoin energy API is ready"
  }
}
```

## Block energy

Returns the energy estimate for every transaction in a block and the block totals.

```graphql
query BlockEnergy($block: String!) {
  blockEnergy(blockIdentifier: $block) {
    blockHash
    blockHeight
    transactionCount
    totalSizeBytes
    totalEnergyKwh
    transactions {
      hash
      sizeBytes
      energyKwh
    }
  }
}
```

Example variables using the Bitcoin genesis block:

```json
{
  "block": "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
}
```

The block identifier is trimmed before use. An empty identifier is rejected with `BAD_USER_INPUT`.

## Daily energy

Returns daily totals in chronological UTC order.

```graphql
query DailyEnergy($days: Int!, $includeToday: Boolean!) {
  dailyEnergy(days: $days, includeToday: $includeToday) {
    date
    isComplete
    blockCount
    transactionCount
    totalSizeBytes
    totalEnergyKwh
  }
}
```

Example variables for the most recent complete UTC day:

```json
{
  "days": 1,
  "includeToday": false
}
```

Behavior:

- `includeToday: true` includes the current UTC day.
- The current UTC day is marked with `isComplete: false`.
- `includeToday: false` returns only complete days.
- Results are returned from oldest to newest.
- `days` must be an integer within the configured limit.
- The default maximum is 30 days.

A daily request may require downloading the raw data for many blocks. The service deduplicates block hashes across the requested days and loads each distinct block only once per request.

## Wallet energy

Returns the total size and energy of all unique transactions associated with an address.

```graphql
query WalletEnergy($address: String!) {
  walletEnergy(address: $address) {
    address
    transactionCount
    totalSizeBytes
    totalEnergyKwh
  }
}
```

Example variables:

```json
{
  "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
}
```

Behavior:

- The address is trimmed before use.
- The input must contain between 1 and 120 characters.
- The Blockchain.com address endpoint is read in pages of 50 transactions.
- Remaining pages are loaded with bounded concurrency.
- Transactions are deduplicated by hash before totals are calculated.
- The service performs basic input-length validation; final address validity is determined by the upstream API.

> **Testing note:** Prefer a small, low-activity address when manually testing this query. Very large or heavily-requested addresses (for example the genesis address `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`) require paging through thousands of transactions from Blockchain.com's `/rawaddr` endpoint, which is aggressively rate-limited. Such requests may exceed the Lambda timeout or return `429 Too Many Requests` regardless of your code — the wallet cap, retry/backoff, and structured error handling exist precisely to handle these cases gracefully. Use a small address, or supply a Blockchain.com API key, to see a successful wallet result. The `blockEnergy` and `dailyEnergy` queries use different endpoints and are the most reliable way to verify the pipeline end to end.


## Architecture and design decisions

### GraphQL schema

The GraphQL schema exposes four root operations:

- `hello`
- `blockEnergy`
- `dailyEnergy`
- `walletEnergy`

Resolvers delegate calculation work to `EnergyService`. Known validation and upstream failures are translated into structured GraphQL errors.

### Service boundary

`EnergyService` contains business rules and energy calculations. It depends on the `BlockchainClient` interface rather than directly depending on `fetch`.

This makes the calculation logic testable with fake client implementations and allows the upstream data provider to be replaced later.

### Blockchain API client

`HttpBlockchainClient` owns:

- Blockchain.com URL construction.
- HTTP request timeouts.
- Response parsing.
- Runtime response validation.
- Retry behavior.
- Cache integration.
- Mapping external JSON fields to internal TypeScript types.

The client validates external JSON instead of trusting it only because the HTTP status is successful.

### Blocks-for-day response compatibility

The blocks-for-day parser accepts both response shapes that may be encountered:

```json
[
  {
    "hash": "...",
    "height": 1,
    "time": 123,
    "main_chain": true
  }
]
```

and:

```json
{
  "blocks": [
    {
      "hash": "...",
      "height": 1,
      "time": 123,
      "main_chain": true
    }
  ]
}
```

The upstream snake-case field `main_chain` is mapped to the internal `mainChain` property. A camel-case `mainChain` field is also accepted for test fixtures. When neither field is present, `mainChain` defaults to `true`.

If the field is present with a non-boolean value, the response is rejected as invalid.

### Retry behavior

The HTTP client retries failures that are likely to be temporary:

- HTTP `429 Too Many Requests`
- HTTP `5xx` responses
- Network failures
- Request timeouts

Non-retryable responses such as `404` are surfaced immediately.

The default retry configuration is:

```text
Maximum attempts: 3
Base backoff delay: 300 ms
```

Backoff is exponential and includes jitter:

```text
base × 2^(attempt - 1) + random(0, base)
```

When the upstream response includes a valid `Retry-After` header, that value takes priority. The accepted wait is capped at 20 seconds so one upstream response cannot create an unbounded delay.

Only successful responses are cached. Failed requests are not stored.

### Cache

`TtlCache` is a small in-memory TTL/LRU cache suitable for a warm Lambda instance.

It provides:

- Expiration based on TTL.
- LRU-style eviction when the maximum entry count is exceeded.
- Concurrent-load coalescing.

Concurrent-load coalescing means that simultaneous requests for the same missing URL share one in-progress Promise rather than sending duplicate upstream requests.

The cache is local to one Node.js process or one warm Lambda container. It is cleared when that process or container is restarted.

A production system with multiple Lambda instances would normally use shared storage such as Redis or DynamoDB, especially for historical daily aggregates.

### Bounded concurrency

Daily and wallet aggregation can require many upstream requests. Requests are parallelized but limited by the configured concurrency value.

This avoids:

- Creating an unbounded number of promises.
- Overloading the upstream API.
- Increasing the chance of HTTP `429` responses.
- Consuming excessive Lambda resources.

### Error handling

Expected application errors are exposed through GraphQL `extensions.code`.

#### Invalid user input

```json
{
  "errors": [
    {
      "message": "days must be between 1 and 30",
      "extensions": {
        "code": "BAD_USER_INPUT"
      }
    }
  ],
  "data": null
}
```

#### Blockchain API failure

```json
{
  "errors": [
    {
      "message": "Blockchain API returned 429 for /rawaddr/...",
      "extensions": {
        "code": "BLOCKCHAIN_API_ERROR"
      }
    }
  ],
  "data": null
}
```

#### Unexpected internal error

Unexpected errors are masked from API consumers:

```json
{
  "errors": [
    {
      "message": "Unexpected server error",
      "extensions": {
        "code": "INTERNAL_SERVER_ERROR"
      }
    }
  ],
  "data": null
}
```

## HTTP 429 rate limiting

Blockchain.com is a public external dependency and may temporarily respond with:

```text
429 Too Many Requests
```

A `429` is generally associated with the request source or IP rate, not with one particular wallet address. Changing the wallet address therefore does not guarantee that the next request will succeed.

The client retries retryable responses. If all attempts fail, the API returns a structured GraphQL error with:

```text
extensions.code = BLOCKCHAIN_API_ERROR
```

This is expected failure handling and does not indicate invalid GraphQL syntax.

For manual testing:

- Avoid repeatedly pressing **Send** while a request is still running.
- Start with the health query.
- Use the genesis block for a small block request.
- Run expensive daily and wallet tests last.
- Use mocked data in Jest for deterministic success-path testing.
- Treat live `429` responses as external-failure test cases.

## Lambda timeout limitation

The Serverless configuration uses a 29-second Lambda timeout.

Daily aggregation and active wallets may exceed this limit because they require multiple calls to an external paginated API. Disabling the Serverless Offline timeout can help with local debugging, but it does not solve the production design limitation.

A production implementation could use:

- Asynchronous jobs.
- Precomputed daily aggregates.
- Persistent shared caching.
- A database of block and transaction data.
- Background wallet aggregation.
- A status or polling endpoint for long-running calculations.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `BLOCKCHAIN_API_BASE_URL` | `https://blockchain.info` | Base URL for upstream requests |
| `BLOCKCHAIN_API_TIMEOUT_MS` | `10000` | Timeout for each upstream request |
| `BLOCKCHAIN_FETCH_CONCURRENCY` | `8` | Maximum parallel upstream operations |
| `BLOCKCHAIN_CACHE_MAX_ENTRIES` | `2000` | Maximum in-memory cache entries |
| `MAX_DAILY_ENERGY_DAYS` | `30` | Maximum accepted `dailyEnergy` day count |

PowerShell example:

```powershell
$env:BLOCKCHAIN_API_TIMEOUT_MS = "15000"
yarn start
```

Bash example:

```bash
BLOCKCHAIN_API_TIMEOUT_MS=15000 yarn start
```

## Testing strategy

Run all automated checks with:

```bash
yarn compile
yarn test
```

The automated tests cover areas such as:

- Valid block parsing.
- Transaction mapping.
- Daily aggregation.
- Wallet pagination and deduplication.
- Input validation.
- Cache expiration and eviction.
- Concurrent request coalescing.
- Retry after HTTP `429`.
- Retry after network errors.
- Maximum retry attempts.
- Immediate handling of non-retryable `404` responses.
- Invalid upstream response shapes.
- Mapping `main_chain` to `mainChain`.
- Defaulting `mainChain` to `true` when the upstream field is absent.

External API success should not be the only test strategy because public API availability and rate limits are outside the application's control.

## Assumptions and limitations

- Energy estimates use the assignment constant rather than a real Bitcoin network energy model.
- Dates are interpreted in UTC.
- Daily results are chronological.
- The current UTC day is incomplete.
- The default daily range is limited to 30 days.
- Wallet input validation does not fully implement Bitcoin address-format validation.
- The public Blockchain.com API can return rate limits, timeouts, malformed responses, or service errors.
- Cache entries are not shared between Lambda instances.
- The solution performs synchronous aggregation and is therefore constrained by the HTTP/Lambda execution window.
- Live manual tests are not deterministic; mocked tests are used for deterministic behavior.

## Production improvements

Given more time, the next improvements would be:

1. Store block, transaction, wallet, and daily aggregates in persistent storage.
2. Move expensive daily and wallet calculations to background jobs.
3. Use a distributed cache.
4. Add structured logging and request correlation IDs.
5. Add metrics for upstream latency, retries, cache hits, and rate limits.
6. Add integration tests against a local mock Blockchain API.
7. Add stricter Bitcoin address validation where appropriate.
8. Add deployment and CI workflows.
9. Add API-level pagination or asynchronous result retrieval for expensive operations.
