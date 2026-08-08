import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('100.64.0.0', 10, 'ipv4');
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
blockedAddresses.addSubnet('192.0.0.0', 24, 'ipv4');
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
blockedAddresses.addSubnet('198.18.0.0', 15, 'ipv4');
blockedAddresses.addSubnet('224.0.0.0', 4, 'ipv4');
blockedAddresses.addSubnet('240.0.0.0', 4, 'ipv4');
blockedAddresses.addAddress('::', 'ipv6');
blockedAddresses.addAddress('::1', 'ipv6');
blockedAddresses.addSubnet('fc00::', 7, 'ipv6');
blockedAddresses.addSubnet('fe80::', 10, 'ipv6');
blockedAddresses.addSubnet('ff00::', 8, 'ipv6');

export class UnsafeOutboundUrlError extends Error {
  readonly code = 'UNSAFE_OUTBOUND_URL';

  constructor(message = 'Outbound URL is not allowed.') {
    super(message);
    this.name = 'UnsafeOutboundUrlError';
  }
}

export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolver?: AddressResolver;
}

export async function validateOutboundUrl(
  input: string | URL,
  resolver: AddressResolver = resolveAll,
): Promise<{ url: URL; address: LookupAddress }> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new UnsafeOutboundUrlError('Outbound URL is invalid.');
  }

  if (url.protocol !== 'https:') {
    throw new UnsafeOutboundUrlError('Outbound requests require HTTPS.');
  }
  if (url.username || url.password) {
    throw new UnsafeOutboundUrlError('Outbound URLs cannot contain credentials.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname);

  if (addresses.length === 0) {
    throw new UnsafeOutboundUrlError('Outbound host did not resolve.');
  }
  if (addresses.some((entry) => isBlockedAddress(entry.address, entry.family))) {
    throw new UnsafeOutboundUrlError('Outbound host resolves to a private or reserved address.');
  }

  return { url, address: addresses[0]! };
}

/**
 * Build the `lookup` implementation that pins a connection to an
 * already-validated address, so DNS cannot be re-resolved to a different
 * (internal) host between the check and the connect. This is what closes the
 * TOCTOU / DNS-rebinding window.
 *
 * The callback MUST receive an ARRAY. Node enables autoSelectFamily (Happy
 * Eyeballs) by default from v20.0.0 onward, which invokes `lookup` with
 * `{ all: true }` and then reads `addresses[0].address`. Passing the
 * 3-argument string form yields `undefined` there, and every outbound request
 * fails with ERR_INVALID_IP_ADDRESS.
 *
 * Exported so this contract is covered by a test; it previously regressed
 * silently because all consumers mock the module.
 */
export function createPinnedLookup(address: LookupAddress) {
  return (
    _hostname: string,
    _options: unknown,
    callback: (
      error: NodeJS.ErrnoException | null,
      addresses: { address: string; family: number }[],
    ) => void,
  ): void => {
    callback(null, [{ address: address.address, family: address.family }]);
  };
}

/** Statuses for which the Response constructor forbids a body. */
function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

/**
 * Assemble the Response. Exported for tests: passing a zero-length Buffer for
 * a 204 makes the constructor throw, which would turn an ordinary webhook
 * reply into a confusing TypeError.
 */
export function buildOutboundResponse(
  status: number,
  statusText: string | undefined,
  headers: Headers,
  chunks: Buffer[],
): Response {
  return new Response(isNullBodyStatus(status) ? null : Buffer.concat(chunks), {
    status,
    statusText,
    headers,
  });
}

export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    resolver = resolveAll,
    signal,
    ...requestInit
  } = options;
  const { url, address } = await validateOutboundUrl(input, resolver);
  const method = (requestInit.method ?? 'GET').toUpperCase();
  const headers = new Headers(requestInit.headers);
  const body = toRequestBody(requestInit.body);

  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers.entries()),
      servername: url.hostname,
      lookup: createPinnedLookup(address) as never,
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;

      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxResponseBytes) {
          request.destroy(new Error('Outbound response exceeded the configured size limit.'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400 && response.headers.location) {
          reject(new UnsafeOutboundUrlError('Outbound redirects are not allowed.'));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            value.forEach((item) => responseHeaders.append(name, item));
          } else if (value !== undefined) {
            responseHeaders.set(name, String(value));
          }
        }
        resolve(buildOutboundResponse(status, response.statusMessage, responseHeaders, chunks));
      });
    });

    const abort = () => request.destroy(new DOMException('The operation was aborted.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => signal?.removeEventListener('abort', abort));
    request.once('timeout', () => request.destroy(new Error('Outbound request timed out.')));
    request.once('error', reject);
    if (signal?.aborted) {
      abort();
      return;
    }
    if (body) request.write(body);
    request.end();
  });
}

function resolveAll(hostname: string): Promise<LookupAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function isBlockedAddress(address: string, familyHint?: number): boolean {
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped?.[1]) return isBlockedAddress(mapped[1], 4);
  const family = familyHint ?? isIP(address);
  if (family === 4) return blockedAddresses.check(address, 'ipv4');
  if (family === 6) return blockedAddresses.check(address, 'ipv6');
  return true;
}

function toRequestBody(body: BodyInit | null | undefined): Buffer | string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError('safeFetch supports string and byte request bodies only.');
}
