import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const composePath = resolve(__dirname, '../../../../infra/docker/docker-compose.gcp.yml');

describe('GCP production compose', () => {
  it('runs a dedicated API worker with BullMQ workers enabled', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toContain('api-worker:');
    expect(compose).toContain('container_name: vf-api-worker');
    expect(compose).toContain('WORKERS_ENABLED: "true"');
    expect(compose).toContain('REDIS_URL: redis://redis:6379');
  });

  it('runs a LiveKit agent worker so dispatched rooms get a speaking participant', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toContain('livekit-agent:');
    expect(compose).toContain('voiceforge-livekit-agent:${IMAGE_TAG:-latest}');
    expect(compose).toContain('container_name: vf-livekit-agent');
    expect(compose).toContain('LIVEKIT_AGENT_NAME: ${LIVEKIT_AGENT_NAME:-voiceforge-agent}');
  });
});
