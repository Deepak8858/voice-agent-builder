// load-tests/k6/knowledge-retrieval.test.ts
// Load tests for knowledge embedding and retrieval

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { BASE_URL, authHeaders, thresholds } from './common';

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Ramp up
    { duration: '2m', target: 50 },    // Sustained 50 VUs
    { duration: '30s', target: 0 },    // Cool down
  ],
  thresholds: thresholds,
};

// Sample document for knowledge upload
const testDocument = JSON.stringify({
  title: `LoadTestDoc_${__VU}_${__ITER}`,
  content: 'This is test content for knowledge base load testing. ' +
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10),
  metadata: {
    source: 'load-test',
    category: 'testing',
  },
});

// Sample query for retrieval testing
const queryPayload = JSON.stringify({
  query: 'test content for knowledge retrieval',
  topK: 5,
});

export default function () {
  group('Knowledge Upload Performance', () => {
    const uploadRes = http.post(
      `${BASE_URL}/knowledge/documents`,
      testDocument,
      { headers: authHeaders() }
    );

    check(uploadRes, {
      'document upload succeeded': (r) => r.status === 200 || r.status === 201,
      'upload < 3s': (r) => r.timings.duration < 3000,
    });

    let docId = null;
    try {
      const body = JSON.parse(uploadRes.body);
      docId = body.id || body.data?.id;
    } catch (e) {
      // Continue without doc ID
    }

    // Test retrieval if we got a document ID
    if (docId) {
      group('Knowledge Retrieval Performance', () => {
        const retrieveRes = http.post(
          `${BASE_URL}/knowledge/query`,
          queryPayload,
          { headers: authHeaders() }
        );

        check(retrieveRes, {
          'query succeeded': (r) => r.status === 200,
          'query < 2s': (r) => r.timings.duration < 2000,
        });
      });

      // Clean up
      http.del(`${BASE_URL}/knowledge/documents/${docId}`, null, {
        headers: authHeaders(),
      });
    }
  });

  sleep(1);
}