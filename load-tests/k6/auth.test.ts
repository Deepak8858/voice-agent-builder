// load-tests/k6/auth.test.ts
// Load tests for authentication endpoints

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { BASE_URL, authHeaders, thresholds } from './common';

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Ramp up to 10 VUs
    { duration: '1m', target: 50 },    // Sustained 50 VUs
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: thresholds,
};

export default function () {
  const endpoint = `${BASE_URL}/auth/profile`;

  group('Auth Endpoint Performance', () => {
    // Test authenticated profile endpoint
    const res = http.get(endpoint, {
      headers: authHeaders(),
    });

    check(res, {
      'auth endpoint responded': (r) => r.status > 0,
      'auth returns 200 or 401': (r) => r.status === 200 || r.status === 401,
      'auth response time < 2s': (r) => r.timings.duration < 2000,
    });

    // Additional auth endpoints to test
    const sessionRes = http.get(`${BASE_URL}/auth/session`, {
      headers: authHeaders(),
    });

    check(sessionRes, {
      'session endpoint responded': (r) => r.status > 0,
      'session returns valid status': (r) => r.status === 200 || r.status === 401,
    });
  });

  sleep(1);
}