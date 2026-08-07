import { describe, expect, it } from 'vitest';
import { UnsafeOutboundUrlError, validateOutboundUrl } from './safe-fetch';

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
  ])('rejects unsafe destination %s', async (url) => {
    await expect(validateOutboundUrl(url)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
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
});
