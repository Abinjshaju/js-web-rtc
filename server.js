require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const twilio = require('twilio');

const { twilioToGemini, resample, pcmBufferToMulaw } = require('./audio-utils');

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = 8520;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY = process.env.TWILIO_API_KEY;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;
const TWILIO_TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const GEMINI_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const GEMINI_MODEL = 'models/gemini-2.5-flash-native-audio-latest';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

let publicHost = process.env.DOMAIN || null;

// ── Timing helper ────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts() { return `+${((Date.now() - T0) / 1000).toFixed(2)}s`; }

// ── Pre-warmed Gemini connections ────────────────────────────────────────────
// Strategy: connect + setup + trigger greeting + buffer audio ALL while phone
// rings. When Twilio stream connects → flush buffered audio instantly.

const pendingGemini = new Map();

function preConnectGemini(callSid) {
  const callT0 = Date.now();
  const ct = () => `+${((Date.now() - callT0) / 1000).toFixed(2)}s`;

  const url = `${GEMINI_LIVE_URL}?key=${GEMINI_API_KEY}`;
  const ws = new WebSocket(url);

  const state = {
    ws,
    ready: false,
    greetingAudioChunks: [],   // pre-converted mulaw 160-byte chunks (base64)
    greetingDone: false,       // true when first turn is complete
    liveMessages: [],          // messages after greeting that need replay
    callT0,
  };
  pendingGemini.set(callSid, state);

  ws.on('open', () => {
    console.log(`[gemini-pre ${ct()}] WebSocket open`);
    const setupMsg = {
      setup: {
        model: GEMINI_MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          thinkingConfig: { thinkingBudget: 0 },
        },
        systemInstruction: {
          parts: [{
            text: 'You are a helpful AI phone assistant. Be very concise. Greet the caller with a short hello when the conversation starts.',
          }],
        },
      },
    };
    console.log(`[gemini-pre ${ct()}] sending setup for model: ${GEMINI_MODEL}`);
    ws.send(JSON.stringify(setupMsg));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Log any error from Gemini
      if (msg.error) {
        console.error(`[gemini-pre ${ct()}] ERROR from Gemini:`, JSON.stringify(msg.error));
        return;
      }

      if (msg.setupComplete) {
        console.log(`[gemini-pre ${ct()}] setup complete — sending greeting trigger`);
        state.ready = true;

        // Trigger greeting NOW (while phone is still ringing)
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: 'Hi' }] }],
            turnComplete: true,
          },
        }));
        return;
      }

      // Buffer audio from greeting response
      if (!state.greetingDone && msg.serverContent && msg.serverContent.modelTurn) {
        const parts = msg.serverContent.modelTurn.parts || [];
        console.log(`[gemini-pre ${ct()}] modelTurn with ${parts.length} parts: ${parts.map(p => p.inlineData ? `audio(${p.inlineData.data.length}b)` : p.text ? `text("${p.text.substring(0,50)}")` : 'other').join(', ')}`);
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            // Convert to mulaw chunks right away
            const pcm24k = Buffer.from(part.inlineData.data, 'base64');
            const pcm8k = resample(pcm24k, 24000, 8000);
            const mulawBuf = pcmBufferToMulaw(pcm8k);

            for (let off = 0; off < mulawBuf.length; off += 160) {
              const chunk = mulawBuf.slice(off, Math.min(off + 160, mulawBuf.length));
              state.greetingAudioChunks.push(chunk.toString('base64'));
            }
          }
        }
      }

      if (!state.greetingDone && msg.serverContent && msg.serverContent.turnComplete) {
        state.greetingDone = true;
        console.log(`[gemini-pre ${ct()}] greeting ready: ${state.greetingAudioChunks.length} chunks buffered`);
        return;
      }

      // Anything after greeting is stored for live replay
      if (state.greetingDone) {
        state.liveMessages.push(raw);
      }
    } catch (_e) { /* will be handled once attached */ }
  });

  ws.on('error', (err) => console.error(`[gemini-pre] error:`, err.message));
  ws.on('close', (code, reason) => {
    console.log(`[gemini-pre ${ct()}] closed code=${code} reason=${reason ? reason.toString() : 'none'}`);
  });

  return state;
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/twilio.min.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js'));
});

// Detect public host from request headers (prefers ngrok/tunnel URLs)
let twimlAppUpdated = false;

app.use((req, _res, next) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = `${proto}://${req.headers.host}`;

  // Always prefer the non-localhost URL (ngrok/tunnel)
  if (!publicHost || (publicHost.includes('localhost') && !host.includes('localhost'))) {
    publicHost = host;
    console.log(`[host] public host: ${publicHost}`);
  }
  next();
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/token', async (_req, res) => {
  // Update TwiML App Voice URL before handing out tokens (ensures browser VoIP works)
  if (TWILIO_TWIML_APP_SID && publicHost && !publicHost.includes('localhost') && !twimlAppUpdated) {
    try {
      const voiceUrl = `${publicHost}/twiml`;
      await twilioClient.applications(TWILIO_TWIML_APP_SID)
        .update({ voiceUrl, voiceMethod: 'POST' });
      console.log(`[twiml-app] ✓ Voice URL → ${voiceUrl}`);
      twimlAppUpdated = true;
    } catch (err) {
      console.error(`[twiml-app] ✗ failed to update:`, err.message);
    }
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, { identity: 'web-user' });
  token.addGrant(new VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: true }));
  res.json({ token: token.toJwt() });
});

// ── POST /call — initiate outbound call AND pre-connect+pre-generate ─────────

app.post('/call', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });

  try {
    // Build the stream URL
    const wsHost = publicHost.replace(/^https?:\/\//, '');
    const streamUrl = `wss://${wsHost}/media-stream`;

    // Embed TwiML directly — eliminates the webhook fetch round-trip (~5-10s savings)
    const twimlStr = `<Response><Connect><Stream url="${streamUrl}"/></Connect></Response>`;

    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      twiml: twimlStr,
      statusCallback: `${publicHost}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    // Pre-connect Gemini AND generate greeting while phone rings
    preConnectGemini(call.sid);

    console.log(`[${ts()}] call started ${call.sid} → ${phoneNumber} (twiml embedded, stream: ${streamUrl})`);
    res.json({ callSid: call.sid, status: 'initiated' });
  } catch (err) {
    console.error('[call] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Handle both GET and POST — Twilio may use either depending on TwiML App config
app.all('/twiml', (req, res) => {
  console.log(`[${ts()}] /twiml hit (${req.method}) from ${req.headers['x-twilio-signature'] ? 'Twilio' : 'unknown'}`);

  if (!publicHost || publicHost.includes('localhost')) {
    // Derive from the incoming request if publicHost isn't set to a tunnel URL
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    publicHost = `${proto}://${req.headers.host}`;
    console.log(`[host] updated from /twiml request: ${publicHost}`);
  }

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  const wsHost = publicHost.replace(/^https?:\/\//, '');
  const streamUrl = `wss://${wsHost}/media-stream`;
  const connect = response.connect();
  connect.stream({ url: streamUrl });

  const twimlStr = response.toString();
  console.log(`[${ts()}] twiml response: ${twimlStr}`);
  res.type('text/xml');
  res.send(twimlStr);
});

app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[${ts()}] status ${CallSid}: ${CallStatus}`);
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    const pre = pendingGemini.get(CallSid);
    if (pre && pre.ws.readyState === WebSocket.OPEN) pre.ws.close();
    pendingGemini.delete(CallSid);
  }
  res.sendStatus(200);
});

// ── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

// ── /media-stream WebSocket — bridge Twilio ↔ Gemini ─────────────────────────

wss.on('connection', (twilioWs) => {
  console.log(`[${ts()}] twilio stream connected`);

  let geminiWs = null;
  let streamSid = null;
  let geminiReady = false;
  let callSid = null;
  let geminiSendCount = 0;
  let twilioSendCount = 0;

  // ── Per-turn timing ─────────────────────────────────────────────────
  let lastUserAudioTime = 0;     // timestamp of last audio chunk FROM user
  let turnFirstChunkTime = 0;    // timestamp of first Gemini audio chunk in current turn
  let turnChunkCount = 0;        // chunks in current turn
  let turnStarted = false;       // are we in a Gemini response turn?

  function sendMulawToTwilio(mulawBase64) {
    if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: mulawBase64 },
      }));
      twilioSendCount++;
    }
  }

  function handleGeminiMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.setupComplete) {
        geminiReady = true;
        return;
      }

      if (msg.serverContent && msg.serverContent.modelTurn) {
        const parts = msg.serverContent.modelTurn.parts || [];
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            // ── First chunk of a new turn? Log latency ──
            if (!turnStarted) {
              turnStarted = true;
              turnFirstChunkTime = Date.now();
              turnChunkCount = 0;
              const sinceLastUserAudio = lastUserAudioTime
                ? `${(turnFirstChunkTime - lastUserAudioTime).toFixed(0)}ms since last user audio`
                : 'no user audio yet';
              console.log(`[${ts()}] 🎙️ gemini FIRST audio chunk (${sinceLastUserAudio})`);
            }

            const pcm24k = Buffer.from(part.inlineData.data, 'base64');
            const pcm8k = resample(pcm24k, 24000, 8000);
            const mulawBuf = pcmBufferToMulaw(pcm8k);

            for (let off = 0; off < mulawBuf.length; off += 160) {
              const chunk = mulawBuf.slice(off, Math.min(off + 160, mulawBuf.length));
              sendMulawToTwilio(chunk.toString('base64'));
              turnChunkCount++;
            }
          }
        }
      }

      if (msg.serverContent && msg.serverContent.interrupted) {
        console.log(`[${ts()}] ⚡ gemini interrupted (was sending turn with ${turnChunkCount} chunks)`);
        turnStarted = false;
        turnChunkCount = 0;
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
      }

      if (msg.serverContent && msg.serverContent.turnComplete) {
        const turnDuration = turnFirstChunkTime ? `${((Date.now() - turnFirstChunkTime) / 1000).toFixed(2)}s` : '?';
        const turnAudioMs = turnChunkCount * 20;
        console.log(`[${ts()}] ✅ gemini turn complete: ${turnChunkCount} chunks (${turnAudioMs}ms audio) streamed over ${turnDuration} | total sent: ${twilioSendCount}`);
        turnStarted = false;
        turnChunkCount = 0;
      }
    } catch (err) {
      console.error('[gemini] parse error:', err.message);
    }
  }

  function attachGeminiLive(gws) {
    geminiWs = gws;
    gws.on('message', handleGeminiMessage);
    gws.on('error', (err) => console.error('[gemini] error:', err.message));
    gws.on('close', (code) => {
      console.log(`[gemini] closed (code=${code})`);
      geminiReady = false;
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });
  }

  function connectGeminiFresh() {
    const gws = new WebSocket(`${GEMINI_LIVE_URL}?key=${GEMINI_API_KEY}`);
    gws.on('open', () => {
      gws.send(JSON.stringify({
        setup: {
          model: GEMINI_MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
            thinkingConfig: { thinkingBudget: 0 },
          },
          systemInstruction: {
            parts: [{ text: 'You are a helpful AI phone assistant. Be very concise. Greet the caller with a short hello.' }],
          },
        },
      }));
    });
    attachGeminiLive(gws);
  }

  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.event) {
        case 'connected':
          console.log(`[${ts()}] twilio stream protocol: ${msg.protocol}`);
          break;

        case 'start': {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          const streamStartTime = Date.now();
          console.log(`[${ts()}] stream start: ${streamSid} / ${callSid}`);

          const pre = pendingGemini.get(callSid);
          if (pre && pre.ws.readyState === WebSocket.OPEN) {
            geminiReady = pre.ready;

            // ── FLUSH pre-buffered greeting audio INSTANTLY ──
            if (pre.greetingAudioChunks.length > 0) {
              const ct = () => `+${((Date.now() - pre.callT0) / 1000).toFixed(2)}s`;
              console.log(`[${ts()}] flushing ${pre.greetingAudioChunks.length} pre-buffered greeting chunks (call ${ct()})`);
              for (const b64 of pre.greetingAudioChunks) {
                sendMulawToTwilio(b64);
              }
              console.log(`[${ts()}] flush done in ${Date.now() - streamStartTime}ms`);
            } else {
              console.log(`[${ts()}] no greeting chunks buffered yet (greeting may still be generating)`);
            }

            // Switch to live handler
            pre.ws.removeAllListeners('message');
            attachGeminiLive(pre.ws);

            // Replay any messages that came in after the greeting
            if (pre.liveMessages && pre.liveMessages.length > 0) {
              for (const m of pre.liveMessages) handleGeminiMessage(m);
            }

            // If greeting wasn't done yet, the live handler will catch remaining audio
            if (!pre.greetingDone) {
              console.log(`[${ts()}] greeting still generating — live handler will catch it`);
            }

            pendingGemini.delete(callSid);
          } else {
            console.log(`[${ts()}] no pre-warmed connection, connecting fresh`);
            if (pre) pendingGemini.delete(callSid);
            connectGeminiFresh();
          }
          break;
        }

        case 'media': {
          if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !geminiReady) break;

          lastUserAudioTime = Date.now();

          const mulawBuf = Buffer.from(msg.media.payload, 'base64');
          const pcm16kBase64 = twilioToGemini(mulawBuf);

          geminiWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{
                mimeType: 'audio/pcm;rate=16000',
                data: pcm16kBase64,
              }],
            },
          }));
          geminiSendCount++;
          break;
        }

        case 'stop':
          console.log(`[${ts()}] stream stop | in=${geminiSendCount} out=${twilioSendCount}`);
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
          break;
      }
    } catch (err) {
      console.error('[twilio-ws] error:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('[twilio-ws] disconnected');
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });
  twilioWs.on('error', (err) => console.error('[twilio-ws] error:', err.message));
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Model: ${GEMINI_MODEL}`);
  console.log(`Twilio: ${TWILIO_PHONE_NUMBER || 'NOT SET'}`);
  console.log(`API key: ${GEMINI_API_KEY ? 'yes' : 'NO'}`);
});
