import { describe, expect, it } from 'vitest';
import { createServer, connect, type Server, type AddressInfo } from 'node:net';
import {
  UnsafeOutboundUrlError,
  buildOutboundResponse,
  createPinnedLookup,
  validateOutboundUrl,
} from './safe-fetch';

describe('validateOutboundUrl', () => {
  it.each([
    'http://example.com',
    'https://127.0.0.1/admin',
    'https://10.0.0.1',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1',
    'https://[::1]/',
    'https://[fd00::1]/',
    'https://[::ffff:127.0.0.1]/',
    // WHATWG URL serialises a v4-mapped literal to hex-group form, so this is
    // the string the block list actually sees for the case above. Asserted
    // separately because it pins BlockList's native `::ffff:` un-mapping, which
    // the NAT64 reasoning in safe-fetch.ts depends on.
    'https://[::ffff:7f00:1]/',
  ])('rejects unsafe destination %s', async (url) => {
    await expect(validateOutboundUrl(url)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  /**
   * RFC 6052 NAT64. `64:ff9b::<v4>` is a public-looking IPv6 address that a
   * NAT64 gateway forwards to the embedded IPv4 address, so without the mirrored
   * subnets this is a complete SSRF bypass straight to the metadata endpoint.
   *
   * `::` compression means one address has several spellings; all of them must
   * be caught, which is why the equivalent forms are listed rather than assumed.
   */
  it.each([
    ['loopback', 'https://[64:ff9b::7f00:1]/'],
    ['metadata endpoint', 'https://[64:ff9b::a9fe:a9fe]/latest/meta-data'],
    ['RFC1918', 'https://[64:ff9b::a00:1]/'],
    ['uncompressed form of loopback', 'https://[64:ff9b:0:0:0:0:7f00:1]/'],
    ['partly-compressed form of loopback', 'https://[64:ff9b::0:7f00:1]/'],
  ])('blocks NAT64-embedded %s', async (_label, url) => {
    await expect(validateOutboundUrl(url)).rejects.toThrow('private or reserved');
  });

  it('still allows NAT64 to a public IPv4 address', async () => {
    // Blocking `64:ff9b::/96` wholesale would pass the tests above and break
    // every IPv6-only deployment's route to the v4 internet. 8.8.8.8.
    await expect(validateOutboundUrl('https://[64:ff9b::808:808]/'))
      .resolves.toMatchObject({ address: { address: '64:ff9b::808:808' } });
  });

  it('blocks a NAT64 address returned by the resolver, not just a URL literal', async () => {
    // DNS64 synthesises these records, so the resolver path must be covered
    // too. Both paths funnel through isBlockedAddress, so this is the proof.
    await expect(validateOutboundUrl(
      'https://dns64.example/hook',
      async () => [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
    )).rejects.toThrow('private or reserved');
  });

  it('rejects a public-looking hostname when DNS resolves to metadata IP space', async () => {
    await expect(validateOutboundUrl(
      'https://rebind.example/hook',
      async () => [{ address: '169.254.169.254', family: 4 }],
    )).rejects.toThrow('private or reserved');
  });

  it('rejects a hostname if any returned address is private', async () => {
    await expect(validateOutboundUrl(
      'https://mixed.example/hook',
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.2', family: 4 },
      ],
    )).rejects.toThrow('private or reserved');
  });

  it('returns the validated address that will be pinned for the TLS request', async () => {
    await expect(validateOutboundUrl(
      'https://example.test/hook',
      async () => [{ address: '93.184.216.34', family: 4 }],
    )).resolves.toMatchObject({
      address: { address: '93.184.216.34', family: 4 },
    });
  });

  it('rejects URLs carrying embedded credentials', async () => {
    await expect(validateOutboundUrl('https://user:pass@example.com/'))
      .rejects.toThrow('cannot contain credentials');
  });

  it.each([
    ['decimal', 'https://2130706433/'],
    ['octal', 'https://0177.0.0.1/'],
    ['hex', 'https://0x7f000001/'],
  ])('blocks loopback expressed in %s form', async (_label, url) => {
    await expect(validateOutboundUrl(url)).rejects.toThrow('private or reserved');
  });
});

/**
 * Regression coverage for the connection-pinning callback.
 *
 * This contract broke once and no test caught it: `validateOutboundUrl` tests
 * never open a socket, and every consumer of safeFetch mocks the module, so the
 * whole suite stayed green while every real outbound request failed.
 *
 * Node enables autoSelectFamily (Happy Eyeballs) by default from v20.0.0. It
 * calls `lookup` with `{ all: true }` and reads `addresses[0].address`. The
 * previous implementation invoked the callback with the 3-argument string form,
 * so that read produced `undefined` and the request died with
 * ERR_INVALID_IP_ADDRESS.
 */
describe('createPinnedLookup', () => {
  it('invokes the callback with an array, as Happy Eyeballs requires', () => {
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });

    let received: unknown;
    lookup('ignored.example', { all: true }, (_err, addresses) => {
      received = addresses;
    });

    // The array shape is the whole point: a bare string here is the bug.
    expect(Array.isArray(received)).toBe(true);
    expect(received).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('ignores the requested hostname and always returns the validated address', () => {
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });

    let received: { address: string; family: number }[] = [];
    lookup('attacker-rebind.example', { all: true }, (_err, addresses) => {
      received = addresses;
    });

    // Pinning is what closes the DNS-rebinding window.
    expect(received[0]?.address).toBe('93.184.216.34');
  });

  it('preserves the IPv6 family so the socket layer picks the right stack', () => {
    const lookup = createPinnedLookup({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 });

    let received: { address: string; family: number }[] = [];
    lookup('ignored.example', { all: true }, (_err, addresses) => {
      received = addresses;
    });

    expect(received[0]?.family).toBe(6);
  });

  /**
   * End-to-end proof through Node's real socket layer. `net.connect` consumes
   * `lookup` exactly the way `https.request` does, so this fails with
   * ERR_INVALID_IP_ADDRESS if the callback shape regresses -- and needs no TLS
   * certificate to do it.
   */
  it('is accepted by the real socket layer under autoSelectFamily', async () => {
    const server: Server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({
          host: 'pinned.example',
          port,
          autoSelectFamily: true,
          lookup: createPinnedLookup({ address: '127.0.0.1', family: 4 }) as never,
        });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * The Response constructor throws if given a body for a null-body status.
 * A 204 is an ordinary webhook reply, so this would turn success into a
 * confusing TypeError.
 */
describe('buildOutboundResponse', () => {
  it.each([204, 205, 304])('returns a bodyless Response for status %i', (status) => {
    const response = buildOutboundResponse(status, 'No Content', new Headers(), []);
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it('preserves the body and headers for a normal 200', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const response = buildOutboundResponse(200, 'OK', headers, [Buffer.from('{"ok":true}')]);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('reports a non-2xx status without throwing', async () => {
    const response = buildOutboundResponse(500, 'Server Error', new Headers(), [Buffer.from('boom')]);

    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('boom');
  });
});
