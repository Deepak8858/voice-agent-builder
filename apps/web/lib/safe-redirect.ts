const SAFE_LOCAL_PATH = /^\/(?!\/)[^\r\n\\]*$/;

export function safeRedirectPath(
  value: string | null | undefined,
  fallback = '/dashboard',
): string {
  if (!value || !SAFE_LOCAL_PATH.test(value)) return fallback;
  return value;
}
