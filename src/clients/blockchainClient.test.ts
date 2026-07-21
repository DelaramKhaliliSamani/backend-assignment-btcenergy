import { TtlCache } from '../cache/ttlCache'
import { BlockchainApiError } from '../errors'
import { HttpBlockchainClient } from './blockchainClient'

/**
 * Build a client whose fetch is scripted by an array of responders.
 * Each responder is called once per attempt, in order; the last one repeats.
 */
function makeClient(
  responders: Array<() => Response | Promise<Response>>,
  overrides: Partial<{
    maxAttempts: number
    now: () => Date
  }> = {},
) {
  let callCount = 0
  const fetchImplementation = (async () => {
    const responder = responders[Math.min(callCount, responders.length - 1)]
    callCount += 1
    return responder()
  }) as unknown as typeof fetch

  const client = new HttpBlockchainClient({
    baseUrl: 'https://api.test',
    timeoutMs: 1000,
    cache: new TtlCache(50, () => 0),
    fetchImplementation,
    maxAttempts: overrides.maxAttempts ?? 3,
    retryBaseDelayMs: 1,
    sleep: async () => {}, // never wait on real timers in tests
    now: overrides.now ?? (() => new Date('2026-01-02T00:00:00.000Z')),
  })

  return { client, getCallCount: () => callCount }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const validBlockBody = {
  hash: 'block-hash',
  height: 5,
  time: 123,
  size: 200,
  n_tx: 1,
  tx: [{ hash: 'tx-1', size: 200 }],
}

describe('HttpBlockchainClient', () => {
  it('parses a valid block response', async () => {
    const { client } = makeClient([() => jsonResponse(validBlockBody)])

    await expect(client.getBlock('block-hash')).resolves.toEqual({
      hash: 'block-hash',
      height: 5,
      time: 123,
      size: 200,
      transactionCount: 1,
      transactions: [{ hash: 'tx-1', size: 200 }],
    })
  })

  it('retries after a 429 and then succeeds', async () => {
    const { client, getCallCount } = makeClient([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      () => jsonResponse(validBlockBody),
    ])

    await expect(client.getBlock('block-hash')).resolves.toMatchObject({
      hash: 'block-hash',
    })
    expect(getCallCount()).toBe(2)
  })

  it('retries after a network error and then succeeds', async () => {
    const { client, getCallCount } = makeClient([
      () => {
        throw new Error('ECONNRESET')
      },
      () => jsonResponse(validBlockBody),
    ])

    await expect(client.getBlock('block-hash')).resolves.toMatchObject({
      height: 5,
    })
    expect(getCallCount()).toBe(2)
  })

  it('gives up after maxAttempts when the API keeps returning 429', async () => {
    const { client, getCallCount } = makeClient(
      [() => new Response('nope', { status: 429 })],
      { maxAttempts: 2 },
    )

    await expect(client.getBlock('block-hash')).rejects.toBeInstanceOf(
      BlockchainApiError,
    )
    expect(getCallCount()).toBe(2)
  })

  it('does not retry a 404 and surfaces it immediately', async () => {
    const { client, getCallCount } = makeClient([
      () => new Response('not found', { status: 404 }),
    ])

    await expect(client.getBlock('missing')).rejects.toBeInstanceOf(
      BlockchainApiError,
    )
    expect(getCallCount()).toBe(1)
  })

  it('rejects a malformed block response (missing tx array)', async () => {
    const { client } = makeClient([
      () => jsonResponse({ hash: 'h', height: 1, time: 1, size: 1 }),
    ])

    await expect(client.getBlock('h')).rejects.toBeInstanceOf(
      BlockchainApiError,
    )
  })

  it('maps main_chain into mainChain, defaulting to true when absent', async () => {
    const { client } = makeClient([
      () =>
        jsonResponse({
          blocks: [
            { hash: 'a', height: 1, time: 10, main_chain: false },
            { hash: 'b', height: 2, time: 20 },
          ],
        }),
    ])

    await expect(
      client.getBlocksForDay(new Date('2026-01-01T00:00:00.000Z')),
    ).resolves.toEqual([
      { hash: 'a', height: 1, time: 10, mainChain: false },
      { hash: 'b', height: 2, time: 20, mainChain: true },
    ])
  })

  it('caches a successful response so a repeated call does not refetch', async () => {
    const { client, getCallCount } = makeClient([
      () => jsonResponse(validBlockBody),
    ])

    await client.getBlock('block-hash')
    await client.getBlock('block-hash')
    expect(getCallCount()).toBe(1)
  })
})
