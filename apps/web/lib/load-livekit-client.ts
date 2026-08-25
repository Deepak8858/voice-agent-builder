export async function loadLiveKitClient(): Promise<typeof import('livekit-client')> {
  return import('livekit-client');
}
