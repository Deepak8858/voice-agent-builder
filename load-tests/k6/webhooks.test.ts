// load-tests/k6/webhooks.test.ts
// Load tests for call event webhook ingestion

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { BASE_URL, webhookThresholds } from './common';

export const options = {
  stages: [
    { duration: '1m', target: 20 },    // Warm up
    { duration: '2m', target: 100 },  // High concurrent VUs for webhooks
    { duration: '1m', target: 100 },  // Sustained peak load
    { duration: '30s', target: 0 },   // Cool down
  ],
  thresholds: webhookThresholds,
};

// Generate realistic call event payload
function generateCallEvent(callIndex) {
  const now = new Date().toISOString();
  return JSON.stringify({
    eventType: ['call_started', 'call_ended', 'transcription'][callIndex % 3],
    callId: `call_${__VU}_${__ITER}_${callIndex}`,
    timestamp: now,
    duration: Math.floor(Math.random() * 300) + 10,  // 10-310 seconds
    participantCount: Math.random() > 0.8 ? 2 : 1,
    metadata: {
      region: ['us-east-1', 'us-west-2', 'eu-west-1'][callIndex % 3],
      deviceType: ['mobile', 'desktop', 'tablet'][callIndex % 3],
    },
  });
}

export default function () {
  group('Webhook Ingestion Performance', () => {
    // Send single call event
    const eventPayload = generateCallEvent(__ITER);

    const res = http.post(
      `${BASE_URL}/webhooks/call-events`,
      eventPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': 'test-signature',  // Test signature header
        },
      }
    );

    check(res, {
      'webhook accepted': (r) => r.status >= 200 && r.status < 300,
      'webhook < 1s': (r) => r.timings.duration < 1000,
    });

    // Batch event test - multiple events in single request
    group('Batch Webhook Performance', () => {
      const batchPayload = JSON.stringify({
        events: [
          generateCallEvent(0),
          generateCallEvent(1),
          generateCallEvent(2),
        ].map(e => JSON.parse(e)),
      });

      const batchRes = http.post(
        `${BASE_URL}/webhooks/call-events/batch`,
        batchPayload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      check(batchRes, {
        'batch webhook accepted': (r) => r.status >= 200 && r.status < 300,
        'batch webhook < 2s': (r) => r.timings.duration < 2000,
      });
    });
  });

  // Minimal sleep for high-throughput webhook testing
  sleep(0.1);
}