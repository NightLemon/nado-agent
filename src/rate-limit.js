export class FixedWindowRateLimiter {
  constructor(options = {}) {
    this.windowMs = Math.max(100, Number(options.windowMs || 60_000));
    this.buckets = new Map();
    this.operations = 0;
  }

  consume(key, limit, now = Date.now()) {
    const maximum = Math.max(0, Math.floor(Number(limit || 0)));
    if (!maximum) {
      return {
        allowed: true,
        limit: 0,
        remaining: null,
        retryAfterMs: 0,
        resetAt: null,
      };
    }
    const bucketKey = String(key || 'anonymous');
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    this.operations += 1;
    if (this.operations % 1000 === 0) {
      for (const [candidateKey, candidate] of this.buckets) {
        if (now >= candidate.resetAt) {
          this.buckets.delete(candidateKey);
        }
      }
    }
    const allowed = bucket.count <= maximum;
    return {
      allowed,
      limit: maximum,
      remaining: Math.max(0, maximum - bucket.count),
      retryAfterMs: allowed ? 0 : Math.max(1, bucket.resetAt - now),
      resetAt: new Date(bucket.resetAt).toISOString(),
    };
  }
}

export function rateLimitError(result) {
  const error = new Error(`Request rate limit exceeded; retry in ${result.retryAfterMs}ms`);
  error.status = 429;
  error.retryAfterMs = result.retryAfterMs;
  error.rateLimit = result;
  return error;
}
