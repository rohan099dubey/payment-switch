-- Token bucket, one hash per client (section 5). Atomic because Redis runs a script
-- to completion; the clock is Redis TIME, so every Gateway replica agrees on it.
--
-- KEYS[1]  bucket key, rl:{client_id}
-- ARGV[1]  refill rate, tokens per second (RATE_LIMIT_RPS)
-- ARGV[2]  capacity (RATE_LIMIT_BURST)
--
-- Returns { allowed (1|0), remaining whole tokens, retry_after_ms }.

local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])

local t = redis.call('TIME')
local now_us = tonumber(t[1]) * 1000000 + tonumber(t[2])

local stored = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(stored[1])
local ts = tonumber(stored[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now_us
end

local elapsed_us = math.max(0, now_us - ts)
tokens = math.min(burst, tokens + elapsed_us * rate / 1000000)

local allowed = 0
local retry_after_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after_ms = math.ceil((1 - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now_us))
-- An idle bucket refills completely in burst/rate seconds; after that it is just "full".
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000)

return { allowed, math.floor(tokens), retry_after_ms }
