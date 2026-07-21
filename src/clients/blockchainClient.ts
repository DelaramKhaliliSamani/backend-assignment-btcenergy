import { TtlCache } from '../cache/ttlCache'
import { CACHE_TTL_MS } from '../constants'
import { BlockchainApiError } from '../errors'
import type {
  BlockchainAddressPage,
  BlockchainBlock,
  BlockchainBlockSummary,
  BlockchainClient,
  BlockchainTransaction,
} from '../types/blockchain'
import { isSameUtcDay } from '../utils'

interface BlockchainClientOptions {
  baseUrl: string
  timeoutMs: number
  cache: TtlCache
  now?: () => Date
  fetchImplementation?: typeof fetch

  /** Total attempts per request (1 = no retry). Default 3. */
  maxAttempts?: number

  /** Base backoff delay in ms; doubles each retry, plus jitter. Default 300. */
  retryBaseDelayMs?: number

  /** Injectable sleep so tests don't wait on real timers. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Never wait longer than this for a Retry-After header,
 * so request latency remains bounded.
 */
const MAX_RETRY_AFTER_MS = 20_000

function asRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new BlockchainApiError(
      `Invalid ${description} response`,
    )
  }

  return value as Record<string, unknown>
}

function requiredString(
  value: unknown,
  fieldName: string,
  description: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BlockchainApiError(
      `Invalid ${description} response: ${fieldName} must be a string`,
    )
  }

  return value
}

function requiredNumber(
  value: unknown,
  fieldName: string,
  description: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value)
  ) {
    throw new BlockchainApiError(
      `Invalid ${description} response: ${fieldName} must be a number`,
    )
  }

  return value
}

function requiredBoolean(
  value: unknown,
  fieldName: string,
  description: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw new BlockchainApiError(
      `Invalid ${description} response: ${fieldName} must be a boolean`,
    )
  }

  return value
}

function requiredArray(
  value: unknown,
  fieldName: string,
  description: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new BlockchainApiError(
      `Invalid ${description} response: ${fieldName} must be an array`,
    )
  }

  return value
}

function parseTransaction(
  value: unknown,
): BlockchainTransaction {
  const transaction = asRecord(value, 'transaction')

  return {
    hash: requiredString(
      transaction.hash,
      'hash',
      'transaction',
    ),
    size: requiredNumber(
      transaction.size,
      'size',
      'transaction',
    ),
  }
}

function isRetryableStatus(status: number): boolean {
  // 429 = rate limited, 5xx = transient server errors.
  return status === 429 || status >= 500
}

export class HttpBlockchainClient
  implements BlockchainClient
{
  private readonly baseUrl: string
  private readonly now: () => Date
  private readonly fetchImplementation: typeof fetch
  private readonly maxAttempts: number
  private readonly retryBaseDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>

  public constructor(
    private readonly options: BlockchainClientOptions,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.now = options.now ?? (() => new Date())
    this.fetchImplementation =
      options.fetchImplementation ?? fetch
    this.maxAttempts = options.maxAttempts ?? 3
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ?? 300
    this.sleep =
      options.sleep ??
      ((ms: number) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms)
        }))

    if (
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1
    ) {
      throw new Error(
        'maxAttempts must be a positive integer',
      )
    }

    if (
      !Number.isFinite(this.retryBaseDelayMs) ||
      this.retryBaseDelayMs <= 0
    ) {
      throw new Error(
        'retryBaseDelayMs must be greater than zero',
      )
    }
  }

  public async getBlock(
    blockIdentifier: string,
  ): Promise<BlockchainBlock> {
    const payload = await this.getJson(
      `/rawblock/${encodeURIComponent(
        blockIdentifier,
      )}`,
      CACHE_TTL_MS.block,
    )

    const block = asRecord(payload, 'block')

    const transactions = requiredArray(
      block.tx,
      'tx',
      'block',
    ).map(parseTransaction)

    return {
      hash: requiredString(
        block.hash,
        'hash',
        'block',
      ),
      height: requiredNumber(
        block.height,
        'height',
        'block',
      ),
      time: requiredNumber(
        block.time,
        'time',
        'block',
      ),
      size: requiredNumber(
        block.size,
        'size',
        'block',
      ),
      transactionCount:
        typeof block.n_tx === 'number'
          ? block.n_tx
          : transactions.length,
      transactions,
    }
  }

  public async getBlocksForDay(
    date: Date,
  ): Promise<BlockchainBlockSummary[]> {
    const ttlMs = isSameUtcDay(date, this.now())
      ? CACHE_TTL_MS.currentDayBlocks
      : CACHE_TTL_MS.historicalDayBlocks

    const payload = await this.getJson(
      `/blocks/${date.getTime()}?format=json`,
      ttlMs,
    )

    /*
     * Support both possible response formats:
     *
     * 1. Direct array:
     *    [{ ... }, { ... }]
     *
     * 2. Object containing the array:
     *    { blocks: [{ ... }, { ... }] }
     */
    const blocks = Array.isArray(payload)
      ? payload
      : requiredArray(
          asRecord(
            payload,
            'blocks-for-day',
          ).blocks,
          'blocks',
          'blocks-for-day',
        )

    return blocks.map((value) => {
      const block = asRecord(
        value,
        'block summary',
      )

      /*
       * The external API normally uses `main_chain`.
       * Some fixtures may use `mainChain`.
       *
       * When both properties are absent, default to true.
       */
      const rawMainChain =
        block.main_chain !== undefined
          ? block.main_chain
          : block.mainChain

      return {
        hash: requiredString(
          block.hash,
          'hash',
          'block summary',
        ),
        height: requiredNumber(
          block.height,
          'height',
          'block summary',
        ),
        time: requiredNumber(
          block.time,
          'time',
          'block summary',
        ),
        mainChain:
          rawMainChain === undefined
            ? true
            : requiredBoolean(
                rawMainChain,
                'main_chain',
                'block summary',
              ),
      }
    })
  }

  public async getAddressPage(
    address: string,
    offset: number,
    limit: number,
  ): Promise<BlockchainAddressPage> {
    const query = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
    })

    const payload = await this.getJson(
      `/rawaddr/${encodeURIComponent(
        address,
      )}?${query.toString()}`,
      CACHE_TTL_MS.address,
    )

    const response = asRecord(
      payload,
      'address',
    )

    return {
      address: requiredString(
        response.address,
        'address',
        'address',
      ),
      transactionCount: requiredNumber(
        response.n_tx,
        'n_tx',
        'address',
      ),
      transactions: requiredArray(
        response.txs,
        'txs',
        'address',
      ).map(parseTransaction),
    }
  }

  private async getJson(
    path: string,
    ttlMs: number,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`

    /*
     * Only successful results are cached.
     * Concurrent callers requesting the same URL share
     * the same in-flight request.
     */
    return this.options.cache.getOrLoad(
      url,
      ttlMs,
      () => this.fetchJsonWithRetry(path, url),
    )
  }

  private async fetchJsonWithRetry(
    path: string,
    url: string,
  ): Promise<unknown> {
    let lastError:
      | BlockchainApiError
      | undefined

    for (
      let attempt = 1;
      attempt <= this.maxAttempts;
      attempt += 1
    ) {
      let response: Response

      try {
        response =
          await this.fetchImplementation(
            url,
            {
              headers: {
                accept: 'application/json',
              },
              signal: AbortSignal.timeout(
                this.options.timeoutMs,
              ),
            },
          )
      } catch (error) {
        /*
         * Network failures and timeouts are retryable.
         */
        lastError =
          new BlockchainApiError(
            `Blockchain API request failed for ${path}`,
            undefined,
            { cause: error },
          )

        if (attempt < this.maxAttempts) {
          await this.sleep(
            this.backoffMs(attempt),
          )
          continue
        }

        throw lastError
      }

      if (response.ok) {
        try {
          return (
            await response.json()
          ) as unknown
        } catch (error) {
          /*
           * Malformed JSON on a successful response is
           * not retried.
           */
          throw new BlockchainApiError(
            `Blockchain API returned invalid JSON for ${path}`,
            response.status,
            { cause: error },
          )
        }
      }

      /*
       * Retry 429 and 5xx responses while attempts remain.
       */
      if (
        isRetryableStatus(
          response.status,
        ) &&
        attempt < this.maxAttempts
      ) {
        const waitMs =
          this.retryAfterMs(response) ??
          this.backoffMs(attempt)

        lastError =
          new BlockchainApiError(
            `Blockchain API returned ${response.status} for ${path}`,
            response.status,
          )

        await this.sleep(waitMs)
        continue
      }

      /*
       * Non-retryable response, such as 404, or
       * the final failed attempt.
       */
      const body = await response
        .text()
        .catch(() => '')

      const detail = body
        .slice(0, 200)
        .trim()

      throw new BlockchainApiError(
        `Blockchain API returned ${response.status} for ${path}${
          detail.length > 0
            ? `: ${detail}`
            : ''
        }`,
        response.status,
      )
    }

    /*
     * Unreachable in normal execution, but required
     * to satisfy TypeScript.
     */
    throw (
      lastError ??
      new BlockchainApiError(
        `Blockchain API request failed for ${path}`,
      )
    )
  }

  /**
   * Exponential backoff with jitter:
   * base * 2^(attempt - 1) + random(0, base)
   */
  private backoffMs(
    attempt: number,
  ): number {
    const exponential =
      this.retryBaseDelayMs *
      2 ** (attempt - 1)

    const jitter =
      Math.random() *
      this.retryBaseDelayMs

    return exponential + jitter
  }

  /**
   * Honour Retry-After headers expressed as either:
   *
   * - seconds
   * - an HTTP date
   *
   * The result is capped to prevent excessive delays.
   */
  private retryAfterMs(
    response: Response,
  ): number | undefined {
    const header =
      response.headers.get(
        'retry-after',
      )

    if (header === null) {
      return undefined
    }

    const asSeconds = Number(header)

    if (Number.isFinite(asSeconds)) {
      return Math.min(
        MAX_RETRY_AFTER_MS,
        Math.max(
          0,
          asSeconds * 1000,
        ),
      )
    }

    const asDate = Date.parse(header)

    if (!Number.isNaN(asDate)) {
      return Math.min(
        MAX_RETRY_AFTER_MS,
        Math.max(
          0,
          asDate -
            this.now().getTime(),
        ),
      )
    }

    return undefined
  }
}
