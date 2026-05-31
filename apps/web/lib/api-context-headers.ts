interface ApiContextHeaderOptions {
  internalApiKey?: string;
  contentType?: string | null;
  requestedWith?: string;
}

export function buildApiContextHeaders(
  accessToken: string | null | undefined,
  options: ApiContextHeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-internal-key': options.internalApiKey ?? '',
  };

  if (options.contentType) {
    headers['content-type'] = options.contentType;
  }

  if (options.requestedWith) {
    headers['x-requested-with'] = options.requestedWith;
  }

  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }

  return headers;
}
