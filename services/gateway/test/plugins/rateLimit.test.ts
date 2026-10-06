import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bucketKey,
  RedisTokenBucket,
  retryAfterSeconds,
  TOKEN_BUCKET_LUA_PATH,
  type ScriptRunner,
} from '../../src/plugins/rateLimit';

/** Only what RedisTokenBucket uses: EVALSHA and SCRIPT LOAD. */
class FakeRedis implements ScriptRunner {
  readonly calls: unknown[][] = [];
  loaded = false;
  constructor(private readonly reply: unknown) {}
  evalsha = (...args: unknown[]): Promise<unknown> => {
    this.calls.push(['evalsha', ...args]);
    return this.loaded
      ? Promise.resolve(this.reply)
      : Promise.reject(new Error('NOSCRIPT No matching script. Please use EVAL.'));
  };
  script = (...args: unknown[]): Promise<unknown> => {
    this.calls.push(['script', ...args]);
    this.loaded = true;
    return Promise.resolve('sha');
  };
}

describe('token bucket client', () => {
  it('keys buckets as rl:{client_id}', () => {
    expect(bucketKey('demo-client')).toBe('rl:demo-client');
  });

  it('Retry-After is whole seconds, at least 1', () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(10)).toBe(1);
    expect(retryAfterSeconds(1000)).toBe(1);
    expect(retryAfterSeconds(1001)).toBe(2);
  });

  it('runs the script with EVALSHA (sha1 of the .lua file), loading it once on NOSCRIPT', async () => {
    const redis = new FakeRedis([1, 199, 0]);
    const bucket = new RedisTokenBucket(redis, 100, 200);
    const sha = createHash('sha1').update(readFileSync(TOKEN_BUCKET_LUA_PATH, 'utf8')).digest('hex');

    expect(await bucket.take('demo-client')).toEqual({ allowed: true, remaining: 199, retryAfterSeconds: 0 });
    expect(redis.calls.map((c) => c[0])).toEqual(['evalsha', 'script', 'evalsha']);
    expect(redis.calls[0]).toEqual(['evalsha', sha, 1, 'rl:demo-client', 100, 200]);
    expect(redis.calls[1]?.[1]).toBe('LOAD');

    await bucket.take('demo-client');
    expect(redis.calls.map((c) => c[0])).toEqual(['evalsha', 'script', 'evalsha', 'evalsha']);
  });

  it('turns a denial into Retry-After seconds', async () => {
    const redis = new FakeRedis([0, 0, 1500]);
    redis.loaded = true;
    expect(await new RedisTokenBucket(redis, 1, 1).take('c')).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 2,
    });
  });

  it.each([[null], ['OK'], [[1, 2]], [[1, '2', 3]]])(
    'rejects a malformed reply %j (so the hook fails open)',
    async (reply) => {
      const redis = new FakeRedis(reply);
      redis.loaded = true;
      await expect(new RedisTokenBucket(redis, 1, 1).take('c')).rejects.toThrow(/unexpected token bucket reply/);
    },
  );

  it('propagates connection errors (the hook fails open on them)', async () => {
    const redis = new FakeRedis(null);
    redis.evalsha = () => Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    await expect(new RedisTokenBucket(redis, 1, 1).take('c')).rejects.toThrow(/enableOfflineQueue/);
    expect(redis.calls).toHaveLength(0);
  });
});
