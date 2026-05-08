// load-tests/k6/common.ts
// Shared configuration and helpers for k6 load tests

export const BASE_URL = __ENV.BASE_URL || 'https://vocal.devdeepak.me/api/v1';
export const API_KEY = __ENV.API_KEY || '';

// Default thresholds for API endpoints
export const thresholds = {
  http_req_duration: ['p(95)<2000'],  // 2s p95 latency
  http_req_failed: ['rate<0.01'],     // <1% error rate
};

// Performance thresholds for agent generation (LLM calls are slower)
export const agentThresholds = {
  http_req_duration: ['p(95)<10000'],  // 10s p95 for LLM endpoints
  http_req_failed: ['rate<0.05'],      // <5% error rate acceptable for LLM
};

// Thresholds for webhooks (high throughput, lower latency expectations)
export const webhookThresholds = {
  http_req_duration: ['p(95)<1000'],   // 1s p95 for webhooks
  http_req_failed: ['rate<0.01'],      // <1% error rate
};

export function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

export function getConfig() {
  return {
    BASE_URL,
    API_KEY,
    thresholds,
  };
}