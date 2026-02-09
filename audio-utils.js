/**
 * Pure JS audio conversion utilities.
 * No native dependencies required.
 *
 * Handles:
 *   Twilio  → Gemini : mulaw 8 kHz  →  PCM-16 16 kHz
 *   Gemini  → Twilio : PCM-16 24 kHz →  mulaw 8 kHz
 */

// ── mu-law lookup tables ─────────────────────────────────────────────────────

const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

/**
 * Encode a single 16-bit linear PCM sample to mu-law (8-bit).
 */
function mulawEncode(sample) {
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
  const byte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return byte;
}

/**
 * Decode a single mu-law byte to a 16-bit linear PCM sample.
 */
function mulawDecode(byte) {
  byte = ~byte & 0xff;
  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

// ── Bulk conversions ─────────────────────────────────────────────────────────

/**
 * Convert a Buffer of mu-law bytes to a Buffer of 16-bit PCM (little-endian).
 * Output length = input length * 2.
 */
function mulawBufferToPcm(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = mulawDecode(mulawBuf[i]);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

/**
 * Convert a Buffer of 16-bit PCM (little-endian) to a Buffer of mu-law bytes.
 * Output length = input length / 2.
 */
function pcmBufferToMulaw(pcmBuf) {
  const numSamples = pcmBuf.length / 2;
  const mulaw = Buffer.alloc(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    mulaw[i] = mulawEncode(sample);
  }
  return mulaw;
}

// ── Resampling ───────────────────────────────────────────────────────────────

/**
 * Resample a 16-bit PCM buffer using linear interpolation.
 * @param {Buffer} pcmBuf  – 16-bit LE PCM
 * @param {number} fromRate – e.g. 8000
 * @param {number} toRate   – e.g. 16000
 * @returns {Buffer} resampled 16-bit LE PCM
 */
function resample(pcmBuf, fromRate, toRate) {
  if (fromRate === toRate) return pcmBuf;

  const srcSamples = pcmBuf.length / 2;
  const ratio = toRate / fromRate;
  const dstSamples = Math.round(srcSamples * ratio);
  const dst = Buffer.alloc(dstSamples * 2);

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;

    const s0 = pcmBuf.readInt16LE(Math.min(idx, srcSamples - 1) * 2);
    const s1 = pcmBuf.readInt16LE(Math.min(idx + 1, srcSamples - 1) * 2);

    const interpolated = Math.round(s0 + (s1 - s0) * frac);
    // Clamp to int16 range
    const clamped = Math.max(-32768, Math.min(32767, interpolated));
    dst.writeInt16LE(clamped, i * 2);
  }

  return dst;
}

// ── High-level helpers ───────────────────────────────────────────────────────

/**
 * Twilio → Gemini
 * mulaw 8 kHz  →  PCM-16 16 kHz (base64)
 */
function twilioToGemini(mulawBuf) {
  const pcm8k = mulawBufferToPcm(mulawBuf);
  const pcm16k = resample(pcm8k, 8000, 16000);
  return pcm16k.toString('base64');
}

/**
 * Gemini → Twilio
 * PCM-16 24 kHz (raw bytes)  →  mulaw 8 kHz (base64)
 */
function geminiToTwilio(pcm24kBuf) {
  const pcm8k = resample(pcm24kBuf, 24000, 8000);
  const mulaw = pcmBufferToMulaw(pcm8k);
  return mulaw.toString('base64');
}

module.exports = {
  mulawEncode,
  mulawDecode,
  mulawBufferToPcm,
  pcmBufferToMulaw,
  resample,
  twilioToGemini,
  geminiToTwilio,
};
