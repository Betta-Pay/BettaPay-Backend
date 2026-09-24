import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const latencyTrend = new Trend('latency');

const BASE_URL = __ENV.GATEWAY_URL || 'http://localhost:3000';
const MERCHANT_ID = __ENV.MERCHANT_ID || 'test-merchant';
const JWT_TOKEN = __ENV.JWT_TOKEN || '';

const headers = {
  'Content-Type': 'application/json',
  ...(JWT_TOKEN ? { Authorization: `Bearer ${JWT_TOKEN}` } : {}),
};

export const options = {
  stages: [
    { duration: '60s', target: 50 },
  ],
  thresholds: {
    http_req_duration: ['p(50)<200', 'p(95)<500', 'p(99)<1000'],
    errors: ['rate<0.05'],
  },
};

function createSettlementPayload() {
  return JSON.stringify({
    merchantId: MERCHANT_ID,
    items: [
      { amount: (Math.random() * 50 + 0.01).toFixed(2), asset: 'USDC' },
    ],
  });
}

export default function () {
  const payload = createSettlementPayload();
  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/settlements`, payload, { headers });
  const dur = Date.now() - start;
  latencyTrend.add(dur);

  const ok = check(res, {
    'status 201 or 200': (r) => r.status === 201 || r.status === 200,
  });
  if (!ok) errorRate.add(1);

  sleep(1);
}

export function setup() {
  const res = http.get(`${BASE_URL}/api/health`);
  if (res.status !== 200) {
    console.warn(`Gateway health returned ${res.status}`);
  }
  return {};
}
