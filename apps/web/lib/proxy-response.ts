import { NextResponse } from 'next/server';

/** Statuses for which the Response constructor forbids a body. */
export function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

/**
 * Relay a non-streaming upstream reply to the browser. A null-body status such
 * as 204 must carry no body, so return a body-free Response for it. Passing a
 * body to those statuses makes the Response constructor throw and turns a
 * successful upstream reply into an unhandled 500.
 */
export async function relayJsonResponse(apiRes: Response): Promise<Response> {
  if (isNullBodyStatus(apiRes.status)) {
    return new Response(null, { status: apiRes.status });
  }
  const data = await apiRes.json().catch(() => null);
  return NextResponse.json(data ?? {}, { status: apiRes.status });
}
