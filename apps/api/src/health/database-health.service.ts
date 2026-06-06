import { Injectable } from '@nestjs/common';
import { createConnection } from 'net';
import { env } from '../config/env';

const POSTGRES_DEFAULT_PORT = 5432;
const DB_CONNECT_TIMEOUT_MS = 750;

@Injectable()
export class DatabaseHealthService {
  async check(): Promise<'ok' | 'error'> {
    const databaseUrl = env.DATABASE_URL ?? env.DIRECT_URL;
    if (!databaseUrl) return 'error';

    try {
      await tcpConnect(databaseUrl, DB_CONNECT_TIMEOUT_MS);
      return 'ok';
    } catch {
      return 'error';
    }
  }
}

function tcpConnect(databaseUrl: string, timeoutMs: number): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return Promise.reject(new Error('invalid database url'));
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : POSTGRES_DEFAULT_PORT;
  if (!host || !Number.isInteger(port) || port <= 0) {
    return Promise.reject(new Error('invalid database host or port'));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    timeout = setTimeout(() => finish(new Error('database health timeout')), timeoutMs);
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error));
  });
}
