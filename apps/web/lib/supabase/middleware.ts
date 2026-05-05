/**
 * Session refresh helper for @supabase/ssr cookie-based auth.
 * Use when proxy.ts needs Supabase to refresh session cookies on every request.
 * Clerk handles its own cookie; this helper is purely for @supabase/ssr session continuity.
 *
 * NOTE: This function is unused until proxy.ts is implemented.
 * Kept here for future integration with Supabase Edge Functions or middleware.
 */
// export async function updateSupabaseSession(req: NextRequest) {
//   let res = NextResponse.next({ request: req });
//
//   const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
//   const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
//   if (!url || !key) return res;
//
//   const supabase = createServerClient(url, key, {
//     cookies: {
//       getAll() {
//         return req.cookies.getAll().map(({ name, value }) => ({ name, value }));
//       },
//       setAll(list) {
//         for (const { name, value } of list) {
//           req.cookies.set(name, value);
//         }
//         res = NextResponse.next({ request: req });
//         for (const { name, value, options } of list) {
//           res.cookies.set(name, value, options);
//         }
//       },
//     },
//   });
//
//   await supabase.auth.getUser();
//   return res;
// }
