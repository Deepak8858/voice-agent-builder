/**
 * Drops the query string from a request URL before it reaches a log record.
 *
 * Both the request logger and the exception filter record the request URL, and
 * the query string is caller-controlled: the Google OAuth callback takes its
 * one-time `code` there (`google-connection.controller.ts:46`), and the web
 * proxy forwards `req.nextUrl.search` verbatim, so any `?code=`/`?token=`
 * parameter is persisted to the log store as plaintext. The path alone keeps
 * the debugging value.
 *
 * Not solved by pino's `redact`: 88 of the 101 `logger.*` calls in this app
 * pass a template literal as the first argument, and `redact` only rewrites the
 * merging object — it would never see them.
 *
 * ponytail: drops the whole query rather than redacting named parameters. Add a
 * keep-list here if a support workflow ever needs specific params in logs.
 */
export function stripQuery(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}
