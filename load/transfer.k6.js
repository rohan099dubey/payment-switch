// k6 load test (ARCHITECTURE.md section 16): constant-arrival-rate, 200 iterations per
// second for 2 minutes, 100 pre-allocated VUs (at most 400). Each iteration posts a
// cross-bank transfer with a unique Idempotency-Key, random load accounts (L0001-L0200,
// created by `npm run seed -- --load`) and an amount of 100 to 10000 paise.
//
//   npm run load                                  # against http://localhost:8080
//   k6 run -e BASE_URL=http://host:8080 -e RATE=200 -e DURATION=2m load/transfer.k6.js
//
// Iterations are spread round-robin over the four development API clients, because each
// client has its own rate-limit bucket (RATE_LIMIT_RPS = 100): one client alone would be
// limited to 100 transfers per second and the run would measure the limiter (ADR-022).
//
// Afterwards, a number only counts if the invariants still hold:
//   npm run invariants -- --since <the run's start time printed below>
import { check } from 'k6';
import http from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '2m';
const RUN = __ENV.LOAD_RUN || `load-${Date.now()}`;

// Development credentials from docker-compose.yml (local stack only).
const CLIENTS = [
  { client_id: 'demo-client', client_secret: 'demo-secret' },
  { client_id: 'test-client-a', client_secret: 'test-secret-a-dev-only' },
  { client_id: 'test-client-b', client_secret: 'test-secret-b-dev-only' },
  { client_id: 'test-ratelimit', client_secret: 'test-secret-rl-dev-only' },
];

export const options = {
  scenarios: {
    transfers: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    // Starting thresholds from section 16, with chaos off. Targets, not guarantees.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// 201, 202 and 422 are all correct answers to a transfer request; anything else failed.
http.setResponseCallback(http.expectedStatuses(201, 202, 422));

export function setup() {
  const tokens = CLIENTS.map((c) => {
    const res = http.post(`${BASE_URL}/v1/auth/token`, JSON.stringify(c), {
      headers: { 'Content-Type': 'application/json' },
      responseCallback: http.expectedStatuses(200),
    });
    if (res.status !== 200) throw new Error(`token for ${c.client_id} failed with ${res.status}`);
    return res.json('access_token');
  });
  console.log(`load run ${RUN} started at ${new Date().toISOString()}`);
  return { tokens };
}

function account() {
  return `L${String(1 + Math.floor(Math.random() * 200)).padStart(4, '0')}`;
}

let counter = 0;

export default function (data) {
  counter++;
  const payerBank = Math.random() < 0.5 ? 'bank_a' : 'bank_b';
  const payeeBank = payerBank === 'bank_a' ? 'bank_b' : 'bank_a';
  const body = JSON.stringify({
    payer: { bank_id: payerBank, account_id: account() },
    payee: { bank_id: payeeBank, account_id: account() },
    amount: 100 + Math.floor(Math.random() * 9901),
    currency: 'INR',
  });
  // Unique per iteration, and prefixed with the run id so invariants can be scoped to it.
  const key = `${RUN}-${__VU}-${counter}`;
  const token = data.tokens[(__VU + counter) % data.tokens.length];
  const res = http.post(`${BASE_URL}/v1/transfers`, body, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
    tags: { name: 'POST /v1/transfers' },
  });
  check(res, { 'status is 201, 202 or 422': (r) => r.status === 201 || r.status === 202 || r.status === 422 });
}
