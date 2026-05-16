// μ-law (G.711) conversion tables
// μ-law: 8-bit companded encoding used by Twilio Media Streams

const MU_LAW_DECODE: number[] = [];
const MU_LAW_ENCODE: number[] = [];

// Build decode table (μ-law → 16-bit PCM signed)
for (let i = 0; i < 256; i++) {
  const v = ((i ^ 127) - 128) * 4;
  MU_LAW_DECODE[i] = v < -2048 ? -2048 : v > 2047 ? 2047 : v;
}

// Build encode table (16-bit PCM signed → μ-law)
for (let i = -32768; i <= 32767; i++) {
  const clamped = i < -8031 ? -8031 : i > 8030 ? 8030 : i;
  const abs = Math.abs(clamped);
  let bits = 7;
  for (let t = 1; t <= 15; t++) {
    if (abs > (((~t) << 4) & 0x7FF) + (1 << (t + 3))) bits = 15 - t;
  }
  const compressed = ((bits << 1) | (clamped >> (bits + 3))) & 0xFF;
  MU_LAW_ENCODE[i + 32768] = compressed ^ 127;
}

export function ulawToPcm16(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    const decoded = MU_LAW_DECODE[mulaw[i]!] ?? 0;
    pcm.writeInt16LE(decoded, i * 2);
  }
  return pcm;
}

export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const mulaw = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    mulaw[i / 2] = MU_LAW_ENCODE[sample + 32768] ?? 127;
  }
  return mulaw;
}

// Simple resampler: 8kHz → 16kHz (zero-insertion interpolation)
export function resample8kTo16k(input: Buffer): Buffer {
  const output = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    output[i * 2] = input[i];
    output[i * 2 + 1] = 0;
  }
  return output;
}

// Generate silence frame for μ-law
export function silenceFrame(durationMs: number = 160): Buffer {
  const frameCount = Math.ceil((durationMs / 1000) * 8000 / 160);
  return Buffer.alloc(frameCount * 160, 0x7f);
}
