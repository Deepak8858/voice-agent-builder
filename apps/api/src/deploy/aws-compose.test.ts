import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const composePath = resolve(__dirname, '../../../../infra/docker/docker-compose.aws.yml');

/**
 * Returns only the mapping lines belonging to `service`, so an assertion cannot
 * be satisfied by a sibling service, an anchor block, or a later top-level key.
 * The block ends at the next line indented two spaces or less, which is where
 * the next service or top-level key begins.
 */
function serviceBlock(compose: string, service: string): string {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) throw new Error(`Service ${service} is not declared in the compose file.`);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ')) break;
    body.push(line);
  }
  return body.join('\n');
}

describe('AWS production compose', () => {
  it('runs a dedicated API worker with BullMQ workers enabled', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toContain('api-worker:');
    expect(compose).toContain('container_name: vf-api-worker');
    expect(compose).toContain('WORKERS_ENABLED: "true"');
    expect(compose).toContain('REDIS_URL: redis://redis:6379');
  });

  // The web-facing API must NOT also drain the queues, or every job would be
  // processed twice once the dedicated worker is running.
  it('leaves BullMQ workers disabled on the request-serving API', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toContain('WORKERS_ENABLED: "false"');
  });

  it('runs a LiveKit agent worker so dispatched rooms get a speaking participant', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toContain('livekit-agent:');
    expect(compose).toContain('container_name: vf-livekit-agent');
    expect(compose).toContain('LIVEKIT_AGENT_NAME: ${LIVEKIT_AGENT_NAME:-voiceforge-agent}');
  });

  it('routes LiveKit knowledge retrieval over the private API service', () => {
    const livekitService = serviceBlock(readFileSync(composePath, 'utf8'), 'livekit-agent');

    expect(livekitService).toContain('INTERNAL_API_BASE_URL: http://api:4000');
    // Retrieval targets the api service, so the worker must not start before it
    // is healthy.
    expect(livekitService).toMatch(/depends_on:\n\s+api:\n\s+condition: service_healthy/);
  });

  // INTERNAL_API_KEY is secret material inherited from the production env_file.
  // Checked across the whole file, and in both mapping and list form, because no
  // service should ever carry a literal credential in the deployment definition.
  it('never hard-codes the internal API key', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).not.toMatch(/INTERNAL_API_KEY\s*[:=]\s*\S+/);
  });

  // Deploys must be pinned to an immutable full git SHA. ECR repositories are
  // created with imageTagMutability=IMMUTABLE, so a floating tag such as
  // `latest` would make a deployed commit unidentifiable and break rollback.
  it('pins every image to an explicit registry and image tag', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toContain('ECR_REGISTRY:?');
    expect(compose).toContain('IMAGE_TAG:?');
    expect(compose).not.toContain(':${IMAGE_TAG:-latest}');
  });
});
