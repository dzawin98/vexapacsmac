function createCache(ttlMs, maxEntries, options = {}) {
  const store = new Map();
  // Entries stay readable for `staleMs` after their TTL so a caller can answer
  // instantly and revalidate behind the response instead of blocking on the
  // origin (stale-while-revalidate). 0 disables stale reads.
  const staleMs = Math.max(0, Number(options.staleMs || 0));
  const counters = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    evictions: 0,
    staleHits: 0,
  };

  function get(key) {
    const entry = store.get(key);
    if (!entry) {
      counters.misses += 1;
      return null;
    }
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      store.delete(key);
      counters.evictions += 1;
      counters.misses += 1;
      return null;
    }
    counters.hits += 1;
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }

  function set(key, value, ttlOverride, staleOverride) {
    if (store.size >= maxEntries) {
      const firstKey = store.keys().next().value;
      if (firstKey) {
        store.delete(firstKey);
        counters.evictions += 1;
      }
    }
    const ttl = typeof ttlOverride === 'number' ? ttlOverride : ttlMs;
    const expiresAt = ttl > 0 ? Date.now() + ttl : null;
    const staleWindow = typeof staleOverride === 'number' ? staleOverride : staleMs;
    const staleUntil = expiresAt !== null && staleWindow > 0 ? expiresAt + staleWindow : null;
    store.set(key, { value, expiresAt, staleUntil });
    counters.sets += 1;
  }

  /**
   * Cached value plus whether it is past its TTL but still inside the stale
   * window. Returns null when there is nothing usable.
   */
  function getWithMeta(key) {
    const entry = store.get(key);
    if (!entry) {
      counters.misses += 1;
      return null;
    }
    const now = Date.now();
    if (entry.expiresAt && entry.expiresAt < now) {
      if (entry.staleUntil && entry.staleUntil > now) {
        counters.staleHits += 1;
        store.delete(key);
        store.set(key, entry);
        return { value: entry.value, stale: true };
      }
      store.delete(key);
      counters.evictions += 1;
      counters.misses += 1;
      return null;
    }
    counters.hits += 1;
    store.delete(key);
    store.set(key, entry);
    return { value: entry.value, stale: false };
  }

  /** Drop every key the predicate accepts. Returns how many were removed. */
  function clearMatching(predicate) {
    let removed = 0;
    for (const key of Array.from(store.keys())) {
      let match = false;
      try {
        match = !!predicate(key);
      } catch (_) {
        match = false;
      }
      if (match) {
        store.delete(key);
        removed += 1;
      }
    }
    counters.deletes += removed;
    return removed;
  }

  function del(key) {
    if (store.delete(key)) {
      counters.deletes += 1;
    }
  }

  function clear() {
    store.clear();
    counters.deletes += 1;
  }

  function stats() {
    const total = counters.hits + counters.misses;
    return {
      backend: 'memory',
      entries: store.size,
      maxEntries,
      ttlMs,
      staleMs,
      hits: counters.hits,
      misses: counters.misses,
      staleHits: counters.staleHits,
      sets: counters.sets,
      deletes: counters.deletes,
      evictions: counters.evictions,
      hitRate: total ? Number((counters.hits / total).toFixed(4)) : 0,
    };
  }

  return { get, set, delete: del, clear, clearMatching, getWithMeta, stats };
}

module.exports = { createCache };
