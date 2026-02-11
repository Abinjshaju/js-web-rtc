require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const { twilioToGemini, resample, pcmBufferToMulaw } = require('./audio-utils');

// ── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  pool: {
    size: parseInt(process.env.POOL_SIZE || '3', 10),
    maxAge: parseInt(process.env.POOL_MAX_AGE || '300000', 10), // 5 min
  },
  audio: {
    chunkSize: parseInt(process.env.AUDIO_CHUNK_SIZE || '160', 10),
  },
  gemini: {
    model: process.env.GEMINI_MODEL || 'models/gemini-2.5-flash-native-audio-latest',
    voice: process.env.GEMINI_VOICE || 'Kore',
    thinkingBudget: parseInt(process.env.THINKING_BUDGET || '0', 10),
  },
  server: {
    port: parseInt(process.env.PORT || '8520', 10),
  },
};

const PORT = CONFIG.server.port;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY = process.env.TWILIO_API_KEY;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;
const TWILIO_TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const GEMINI_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const GEMINI_MODEL = CONFIG.gemini.model;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

let publicHost = process.env.DOMAIN || null;

// ── Timing helper ────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts() { return `+${((Date.now() - T0) / 1000).toFixed(2)}s`; }

// ── Safe JSON parse ──────────────────────────────────────────────────────────
function safeJSON(data, context) {
  try {
    return JSON.parse(data);
  } catch (err) {
    console.error(`[${context}] JSON parse error:`, err.message);
    if (data && typeof data.toString === 'function') {
      console.error(`[${context}] Raw (first 200 chars):`, data.toString().substring(0, 200));
    }
    return null;
  }
}

// ── Connection Pool & Pre-warming ────────────────────────────────────────────

const geminiPool = [];
let poolInitialized = false;

function getGeminiSetup() {
  return {
    setup: {
      model: GEMINI_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: CONFIG.gemini.voice } },
        },
        thinkingConfig: { thinkingBudget: CONFIG.gemini.thinkingBudget },
      },
      systemInstruction: {
        parts: [{
          text: 'You are a helpful AI phone assistant. Be very concise. Greet the caller with a short hello when the conversation starts.',
        }],
      },
    },
  };
}

function createPoolConnection() {
  const ws = new WebSocket(`${GEMINI_LIVE_URL}?key=${GEMINI_API_KEY}`);
  const state = { ws, ready: false, inUse: false, created: Date.now() };

  ws.on('open', () => {
    ws.send(JSON.stringify(getGeminiSetup()));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.setupComplete) {
        state.ready = true;
        const readyCount = geminiPool.filter(s => s.ready).length;
        console.log(`[pool] connection ready (${readyCount}/${CONFIG.pool.size})`);
      }
    } catch (_e) { /* minimal handler for pool */ }
  });

  ws.on('close', () => {
    const idx = geminiPool.indexOf(state);
    if (idx > -1) geminiPool.splice(idx, 1);
    if (geminiPool.length < CONFIG.pool.size) {
      setTimeout(createPoolConnection, 1000);
    }
  });

  ws.on('error', (err) => {
    console.error('[pool] connection error:', err.message);
  });

  geminiPool.push(state);
}

function initializePool() {
  if (poolInitialized) return;
  poolInitialized = true;
  console.log(`[pool] initializing ${CONFIG.pool.size} connections`);
  for (let i = 0; i < CONFIG.pool.size; i++) {
    setTimeout(() => createPoolConnection(), i * 500);
  }
}

function getPooledConnection() {
  const available = geminiPool.find(s => s.ready && !s.inUse);
  if (available) {
    available.inUse = true;
    const remaining = geminiPool.filter(s => !s.inUse && s.ready).length;
    console.log(`[pool] claimed connection (${remaining} remaining)`);
    createPoolConnection(); // Immediately create replacement
    return available;
  }
  console.log('[pool] no available connections');
  return null;
}

// ── Memory management: clean stale connections ────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const STALE_TIME = CONFIG.pool.maxAge;

  for (let i = geminiPool.length - 1; i >= 0; i--) {
    const state = geminiPool[i];
    if (!state.inUse && (now - state.created) > STALE_TIME) {
      console.log('[pool] cleaning stale connection');
      if (state.ws.readyState === WebSocket.OPEN) state.ws.close();
      geminiPool.splice(i, 1);
    }
  }

  while (geminiPool.length < CONFIG.pool.size) {
    createPoolConnection();
  }
}, 60000);

// ── Metrics ───────────────────────────────────────────────────────────────────
const metrics = {
  calls: 0,
  avgLatency: 0,
  errors: 0,
  poolHits: 0,
  poolMisses: 0,

  recordLatency(ms) {
    this.calls++;
    this.avgLatency = (this.avgLatency * (this.calls - 1) + ms) / this.calls;
  },

  report() {
    const total = this.poolHits + this.poolMisses;
    return {
      totalCalls: this.calls,
      avgLatencyMs: Math.round(this.avgLatency),
      errorRate: `${((this.errors / Math.max(this.calls, 1)) * 100).toFixed(2)}%`,
      poolEfficiency: total > 0 ? `${((this.poolHits / total) * 100).toFixed(2)}%` : 'N/A',
      pool: {
        total: geminiPool.length,
        ready: geminiPool.filter(s => s.ready && !s.inUse).length,
        inUse: geminiPool.filter(s => s.inUse).length,
      },
    };
  },
};

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1); // for rate limiting behind ngrok/reverse proxy
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/twilio.min.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js'));
});

// ── TwiML App: update once when public host is known (non-blocking) ────────────
let twimlAppReady = false;

async function ensureTwiMLApp() {
  if (twimlAppReady) return;
  if (!TWILIO_TWIML_APP_SID || !publicHost || publicHost.includes('localhost')) return;

  try {
    const voiceUrl = `${publicHost}/twiml`;
    await twilioClient.applications(TWILIO_TWIML_APP_SID)
      .update({ voiceUrl, voiceMethod: 'POST' });
    console.log(`[twiml-app] ✓ Voice URL → ${voiceUrl}`);
    twimlAppReady = true;
  } catch (err) {
    console.error('[twiml-app] ✗ failed:', err.message);
  }
}

// Detect public host from request headers (prefers ngrok/tunnel URLs)
app.use((req, _res, next) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = `${proto}://${req.headers.host}`;

  if (!publicHost || (publicHost.includes('localhost') && !host.includes('localhost'))) {
    publicHost = host;
    console.log(`[host] public host: ${publicHost}`);
    ensureTwiMLApp(); // Non-blocking
  }
  next();
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/token', (_req, res) => {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    { identity: 'web-user' }
  );
  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: true,
  }));
  res.json({ token: token.toJwt() });
});

app.get('/metrics', (_req, res) => {
  res.json(metrics.report());
});

// ── POST /call — initiate outbound call ──────────────────────────────────────

const callLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_CALLS || '10', 10),
  message: { error: 'Too many calls, please try again later' },
});

app.post('/call', callLimiter, async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });

  try {
    const wsHost = publicHost.replace(/^https?:\/\//, '');
    const streamUrl = `wss://${wsHost}/media-stream`;

    const twimlStr = `<Response><Connect><Stream url="${streamUrl}"/></Connect></Response>`;

    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      twiml: twimlStr,
      statusCallback: `${publicHost}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    metrics.calls++;
    console.log(`[${ts()}] call started ${call.sid} → ${phoneNumber} (stream: ${streamUrl})`);
    res.json({ callSid: call.sid, status: 'initiated' });
  } catch (err) {
    metrics.errors++;
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
  const { CallSid, CallStatus, From, To } = req.body;
  console.log(`[${ts()}] [CALL] status callback: ${CallSid} → ${CallStatus} (From=${From} To=${To})`);
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
  console.log(`[${ts()}] [CALL] twilio stream connected`);

  let geminiWs = null;
  let streamSid = null;
  let geminiReady = false;
  let callSid = null;
  let geminiSendCount = 0;
  let twilioSendCount = 0;
  let twilioRecvCount = 0;  // audio chunks received FROM phone
  let pendingGreeting = false; // true when using fresh connection, need to send Hi after setupComplete

  // ── Per-turn timing ─────────────────────────────────────────────────
  let lastUserAudioTime = 0;     // timestamp of last audio chunk FROM user
  let turnFirstChunkTime = 0;    // timestamp of first Gemini audio chunk in current turn
  let turnChunkCount = 0;        // chunks in current turn
  let turnStarted = false;       // are we in a Gemini response turn?

  const chunkSize = CONFIG.audio.chunkSize;

  function sendMulawToTwilio(mulawBase64) {
    if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: mulawBase64, track: 'outbound' },
      }));
      twilioSendCount++;
      // Log: first 5, then every 25th, then every 100th
      if (twilioSendCount <= 5 || twilioSendCount % 25 === 0 || twilioSendCount % 100 === 0) {
        console.log(`[${ts()}] [CALL] AUDIO-OUT → Twilio chunk #${twilioSendCount} (${mulawBase64.length}b base64)`);
      }
    } else {
      console.log(`[${ts()}] [CALL] AUDIO-OUT BLOCKED (ws=${twilioWs?.readyState} streamSid=${!!streamSid})`);
    }
  }

  function handleGeminiMessage(raw) {
    const msg = safeJSON(raw, 'gemini');
    if (!msg) return;

    if (msg.error) {
      console.error('[gemini] API error:', JSON.stringify(msg.error));
      metrics.errors++;
      return;
    }

    if (msg.setupComplete) {
      geminiReady = true;
      console.log(`[${ts()}] [CALL] GEMINI setupComplete — ready to send/receive`);
      if (pendingGreeting && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        pendingGreeting = false;
        geminiWs.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: 'Hi' }] }],
            turnComplete: true,
          },
        }));
        console.log(`[${ts()}] [CALL] GEMINI-IN → sent greeting trigger "Hi" (fresh connection)`);
      }
      return;
    }

    if (msg.serverContent && msg.serverContent.modelTurn) {
      const parts = msg.serverContent.modelTurn.parts || [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          if (!turnStarted) {
            turnStarted = true;
            turnFirstChunkTime = Date.now();
            turnChunkCount = 0;
            const sinceLastUserAudio = lastUserAudioTime
              ? `${(turnFirstChunkTime - lastUserAudioTime).toFixed(0)}ms since last user audio`
              : 'no user audio yet';
            console.log(`[${ts()}] [CALL] GEMINI-IN ← FIRST audio chunk (${sinceLastUserAudio}) — forwarding to Twilio`);
            if (lastUserAudioTime) {
              metrics.recordLatency(turnFirstChunkTime - lastUserAudioTime);
            }
          }

          // Convert and stream immediately (no buffering)
          const pcm24k = Buffer.from(part.inlineData.data, 'base64');
          const pcm8k = resample(pcm24k, 24000, 8000);
          const mulawBuf = pcmBufferToMulaw(pcm8k);

          for (let off = 0; off < mulawBuf.length; off += chunkSize) {
            const chunk = mulawBuf.slice(off, Math.min(off + chunkSize, mulawBuf.length));
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
      console.log(`[${ts()}] [CALL] GEMINI turn complete: ${turnChunkCount} chunks (${turnAudioMs}ms) over ${turnDuration} | total out: ${twilioSendCount}`);
      turnStarted = false;
      turnChunkCount = 0;
    }
  }

  function attachGeminiLive(gws) {
    geminiWs = gws;
    gws.on('message', handleGeminiMessage);
    gws.on('error', (err) => {
      console.error('[gemini] error:', err.message);
      metrics.errors++;
      const oldWs = geminiWs;
      if (twilioWs.readyState === WebSocket.OPEN && oldWs) {
        if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
          oldWs.removeAllListeners();
          oldWs.close();
        }
        console.log('[gemini] attempting reconnect...');
        setTimeout(() => {
          const pooled = getPooledConnection();
          if (pooled) {
            geminiReady = true;
            attachGeminiLive(pooled.ws);
          } else {
            pendingGreeting = false;
            connectGeminiFresh();
          }
        }, 100);
      }
    });
    gws.on('close', (code) => {
      console.log(`[gemini] closed (code=${code})`);
      geminiReady = false;
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });
  }

  function connectGeminiFresh() {
    const gws = new WebSocket(`${GEMINI_LIVE_URL}?key=${GEMINI_API_KEY}`);
    gws.on('open', () => {
      gws.send(JSON.stringify(getGeminiSetup()));
    });
    attachGeminiLive(gws);
  }

  twilioWs.on('message', (raw) => {
    const msg = safeJSON(raw, 'twilio-ws');
    if (!msg) return;

    try {
      switch (msg.event) {
        case 'connected':
          console.log(`[${ts()}] [CALL] Twilio connected — protocol: ${msg.protocol}, version: ${msg.version || 'n/a'}`);
          break;

        case 'start': {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          const startCustom = msg.start.customParameters || {};
          console.log(`[${ts()}] [CALL] ═══ STREAM START ═══ callSid=${callSid} streamSid=${streamSid}`);
          console.log(`[${ts()}] [CALL] start payload: ${JSON.stringify(msg.start)}`);

          const pooled = getPooledConnection();

          if (pooled) {
            metrics.poolHits++;
            geminiWs = pooled.ws;
            geminiReady = true;
            attachGeminiLive(pooled.ws);

            // Trigger greeting immediately (connection already warm)
            geminiWs.send(JSON.stringify({
              clientContent: {
                turns: [{ role: 'user', parts: [{ text: 'Hi' }] }],
                turnComplete: true,
              },
            }));

            console.log(`[${ts()}] [CALL] using POOLED connection — greeting "Hi" sent immediately`);
          } else {
            metrics.poolMisses++;
            console.log(`[${ts()}] [CALL] pool empty — connecting FRESH (greeting after setupComplete)`);
            pendingGreeting = true;
            connectGeminiFresh();
          }
          break;
        }

        case 'media': {
          twilioRecvCount++;
          const payload = msg.media?.payload;
          const isFirstFew = twilioRecvCount <= 5;
          const isSample = twilioRecvCount % 50 === 0;
          if (isFirstFew || isSample) {
            console.log(`[${ts()}] [CALL] AUDIO-IN ← from phone chunk #${twilioRecvCount} (${payload?.length || 0}b base64, track=${msg.media?.track || 'unknown'})`);
          }

          if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
            if (twilioRecvCount <= 10 || twilioRecvCount % 50 === 0) {
              console.log(`[${ts()}] [CALL] AUDIO-IN BLOCKED — no Gemini WS (state=${geminiWs?.readyState ?? 'null'})`);
            }
            break;
          }
          if (!geminiReady) {
            if (twilioRecvCount <= 10 || twilioRecvCount % 50 === 0) {
              console.log(`[${ts()}] [CALL] AUDIO-IN BLOCKED — Gemini not ready yet`);
            }
            break;
          }

          lastUserAudioTime = Date.now();

          const mulawBuf = Buffer.from(payload, 'base64');
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
          if (twilioRecvCount <= 5 || twilioRecvCount % 50 === 0) {
            console.log(`[${ts()}] [CALL] AUDIO-IN → Gemini forwarded #${geminiSendCount}`);
          }
          break;
        }

        case 'stop':
          console.log(`[${ts()}] [CALL] ═══ STREAM STOP ═══ phone→gemini=${geminiSendCount} gemini→phone=${twilioSendCount} (twilioRecv=${twilioRecvCount})`);
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
          break;

        default:
          console.log(`[${ts()}] [CALL] twilio event: ${msg.event}`, msg.event === 'mark' ? `mark=${msg.mark?.name}` : '');
          break;
      }
    } catch (err) {
      console.error('[twilio-ws] error:', err.message);
      metrics.errors++;
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
  initializePool();
});
