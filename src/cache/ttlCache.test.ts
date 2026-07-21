import { TtlCache } from './ttlCache'

describe('TtlCache', () => {
  it('returns cached values until they expire', () => {
    let now = 100
    const cache = new TtlCache(2, () => now)

    cache.set('key', 'value', 50)
    expect(cache.get('key')).toBe('value')

    now = 150
    expect(cache.get('key')).toBeUndefined()
  })

  it('coalesces concurrent loads for the same key', async () => {
    const cache = new TtlCache(2)
    let loadCount = 0
    const loader = async () => {
      loadCount += 1
      await Promise.resolve()
      return 'loaded'
    }

    await expect(
      Promise.all([
        cache.getOrLoad('key', 1000, loader),
        cache.getOrLoad('key', 1000, loader),
      ]),
    ).resolves.toEqual(['loaded', 'loaded'])
    expect(loadCount).toBe(1)
  })

  it('evicts the least-recently-used entry when over capacity', () => {
    let now = 0
    const cache = new TtlCache(2, () => now)

    cache.set('a', 'A', 1000)
    cache.set('b', 'B', 1000)
    // Touch 'a' so 'b' becomes the least-recently-used entry.
    expect(cache.get('a')).toBe('A')
    cache.set('c', 'C', 1000)

    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('A')
    expect(cache.get('c')).toBe('C')
  })

  it('does not cache a failed load, so the next call retries', async () => {
    const cache = new TtlCache(2)
    let calls = 0
    const flakyLoader = async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('boom')
      }
      return 'ok'
    }

    await expect(cache.getOrLoad('key', 1000, flakyLoader)).rejects.toThrow(
      'boom',
    )
    // The failure was not cached, so a second attempt runs the loader again.
    await expect(cache.getOrLoad('key', 1000, flakyLoader)).resolves.toBe('ok')
    expect(calls).toBe(2)
  })

  it('rejects a non-positive ttl', () => {
    const cache = new TtlCache(2, () => 0)
    expect(() => cache.set('k', 'v', 0)).toThrow()
  })
})
