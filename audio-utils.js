/**
 * Optimized pure-JS audio conversion utilities.
 * Drop-in replacement (same API).
 *
 * Faster because of:
 *  - μ-law lookup tables
 *  - TypedArray processing
 *  - Unsafe buffer allocation where safe
 *  - Reduced math + bounds checks
 *
 * Handles:
 *   Twilio  → Gemini : mulaw 8 kHz  → PCM-16 16 kHz
 *   Gemini  → Twilio : PCM-16 24 kHz → mulaw 8 kHz
 */

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

// ─────────────────────────────────────────────
// μ-law Lookup Tables
// ─────────────────────────────────────────────

// Decode: 8-bit → 16-bit
const MULAW_DECODE_TABLE = new Int16Array(256);

for (let i = 0; i < 256; i++) {
  let byte = ~i & 0xff;

  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;

  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;

  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

// Encode table (optional but fast)
const MULAW_ENCODE_TABLE = new Uint8Array(65536);

for (let i = -32768; i <= 32767; i++) {
  MULAW_ENCODE_TABLE[i & 0xffff] = mulawEncodeSample(i);
}

// ─────────────────────────────────────────────
// Single-sample μ-law encode (used for table)
// ─────────────────────────────────────────────

function mulawEncodeSample(sample) {
  let sign = 0;

  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }

  if (sample > MULAW_CLIP) sample = MULAW_CLIP;

  sample += MULAW_BIAS;

  let exponent = 7;
  let mask = 0x4000;

  for (; exponent > 0; exponent--, mask >>= 1) {
    if (sample & mask) break;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Public encode (kept for API compatibility)
function mulawEncode(sample) {
  return MULAW_ENCODE_TABLE[sample & 0xffff];
}

// Public decode (kept for API compatibility)
function mulawDecode(byte) {
  return MULAW_DECODE_TABLE[byte];
}

// ─────────────────────────────────────────────
// TypedArray helpers
// ─────────────────────────────────────────────

function toInt16Array(buf) {
  return new Int16Array(
    buf.buffer,
    buf.byteOffset,
    buf.length / 2
  );
}

// ─────────────────────────────────────────────
// Bulk conversions
// ─────────────────────────────────────────────

/**
 * μ-law Buffer → PCM16 Buffer
 */
function mulawBufferToPcm(mulawBuf) {
  const len = mulawBuf.length;

  const pcmArray = new Int16Array(len);

  for (let i = 0; i < len; i++) {
    pcmArray[i] = MULAW_DECODE_TABLE[mulawBuf[i]];
  }

  return Buffer.from(pcmArray.buffer);
}

/**
 * PCM16 Buffer → μ-law Buffer
 */
function pcmBufferToMulaw(pcmBuf) {
  const pcm = toInt16Array(pcmBuf);
  const len = pcm.length;

  const mulaw = Buffer.allocUnsafe(len);

  for (let i = 0; i < len; i++) {
    mulaw[i] = MULAW_ENCODE_TABLE[pcm[i] & 0xffff];
  }

  return mulaw;
}

// ─────────────────────────────────────────────
// Resampling (linear interpolation)
// ─────────────────────────────────────────────

function resample(pcmBuf, fromRate, toRate) {
  if (fromRate === toRate) return pcmBuf;

  const src = toInt16Array(pcmBuf);

  const ratio = toRate / fromRate;
  const dstLength = Math.round(src.length * ratio);

  const dst = new Int16Array(dstLength);

  for (let i = 0; i < dstLength; i++) {
    const srcPos = i / ratio;
    const idx = srcPos | 0;
    const frac = srcPos - idx;

    const s0 = src[idx];
    const s1 = src[Math.min(idx + 1, src.length - 1)];

    dst[i] = s0 + (s1 - s0) * frac;
  }

  return Buffer.from(dst.buffer);
}

// ─────────────────────────────────────────────
// High-level helpers
// ─────────────────────────────────────────────

/**
 * Twilio → Gemini
 * mulaw 8 kHz → PCM16 16 kHz (base64)
 */
function twilioToGemini(mulawBuf) {
  const pcm8k = mulawBufferToPcm(mulawBuf);
  const pcm16k = resample(pcm8k, 8000, 16000);
  return pcm16k.toString("base64");
}

/**
 * Gemini → Twilio
 * PCM16 24 kHz → mulaw 8 kHz (base64)
 */
function geminiToTwilio(pcm24kBuf) {
  const pcm8k = resample(pcm24kBuf, 24000, 8000);
  const mulaw = pcmBufferToMulaw(pcm8k);
  return mulaw.toString("base64");
}

// ─────────────────────────────────────────────
// Exports (unchanged)
// ─────────────────────────────────────────────

module.exports = {
  mulawEncode,
  mulawDecode,
  mulawBufferToPcm,
  pcmBufferToMulaw,
  resample,
  twilioToGemini,
  geminiToTwilio,
};
