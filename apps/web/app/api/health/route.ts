export async function GET() {
  return new Response(JSON.stringify({ status: 'ok', service: 'voiceforge-web' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
