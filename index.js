// --- ENV ---
import 'dotenv/config';
 
// --- Libs ---
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import qrcode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import OpenAI from 'openai';
// --- Redis (histórico) ---
import { createClient } from 'redis';

// -------- util de caminho (__dirname em ESM) --------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------- OpenAI --------
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || '').trim(),
});

// -------- Config da Livia (JSON opcional) --------
const LIVIA_CONFIG_PATH =
  (process.env.LIVIA_CONFIG_PATH && process.env.LIVIA_CONFIG_PATH.trim()) ||
  path.join(__dirname, 'config', 'livia_unificado_mvp.json');

function safeLoadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[LIVIA] Não foi possível carregar JSON em', filePath, '→ usando fallback.');
    return null;
  }
}
const LIVIA = safeLoadJSON(LIVIA_CONFIG_PATH) || {};
const identityStrict = LIVIA.identity_strict || {};
const persona = LIVIA.persona || {};

// prompt padrão se não houver JSON
function buildSystemPrompt() {
  const name = identityStrict.always_name || 'Lívia Martins';
  const forbidBot = identityStrict.never_reveal_bot !== false; // default true
  const city = persona.city || 'Brasília';
  const brand = persona.brand || 'TopOfertas Express';

  // Regras essenciais (curtas e seguras)
  return [
    `Você é ${name}, vendedora da ${brand}, em ${city}.`,
    `Fale de forma humana, calorosa e objetiva; use tom de consultora-amiga.`,
    forbidBot ? `Nunca diga que é bot, IA ou atendente virtual.` : ``,
    `Se perguntarem “você é um bot?”: responda como ${name} (humana) e siga ajudando.`,
    `Evite links desnecessários. Se não souber algo, diga que vai verificar e siga no atendimento.`,
  ]
    .filter(Boolean)
    .join(' ');
}

// -------- Redis (histórico por JID) --------
const REDIS_URL = (process.env.REDIS_URL || '').trim();
const HISTORY_TTL = Math.max(0, parseInt(process.env.HISTORY_TTL_SECONDS || '604800', 10)); // 7 dias padrão

let _redisClient = null;
async function getRedis() {
  if (!REDIS_URL) {
    console.warn('[REDIS] REDIS_URL não configurada — histórico desativado.');
    return null;
  }
  if (_redisClient) return _redisClient;
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => console.error('[REDIS] error:', err?.message || err));
  await client.connect();
  console.log('[REDIS] conectado.');
  _redisClient = client;
  return _redisClient;
}

const HIST_LIMIT = 24; // últimas 24 mensagens (12 trocas)
function histKey(jid) {
  return `hist:${jid}`;
}

async function loadHistory(jid) {
  try {
    const cli = await getRedis();
    if (!cli) return [];
    const raw = await cli.get(histKey(jid));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch (e) {
    console.warn('[HIST] load falhou:', e?.message || e);
    return [];
  }
}

async function saveHistory(jid, msgs) {
  try {
    const cli = await getRedis();
    if (!cli) return;
    const slice = (msgs || []).slice(-HIST_LIMIT);
    const data = JSON.stringify(slice);
    if (HISTORY_TTL > 0) {
      await cli.set(histKey(jid), data, { EX: HISTORY_TTL });
    } else {
      await cli.set(histKey(jid), data);
    }
  } catch (e) {
    console.warn('[HIST] save falhou:', e?.message || e);
  }
}

// -------- Delay + status "digitando..." --------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTypingMessage(sock, jid, message) {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);

    // delay proporcional ao tamanho (máx 3.5s)
    const delay = Math.min(3500, Math.max(500, message.length * 25));
    await sleep(delay);

    await sock.sendMessage(jid, { text: message });
  } catch (e) {
    console.warn('[WPP][typing] falhou, enviando direto:', e?.message || e);
    try {
      await sock.sendMessage(jid, { text: message });
    } catch (e2) {
      console.error('[WPP] sendMessage erro:', e2?.message || e2);
    }
  } finally {
    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch (_) {}
  }
}

// -------- helpers de texto do WhatsApp --------
function extractText(message) {
  return (
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.message?.imageMessage?.caption ||
    message?.message?.videoMessage?.caption ||
    ''
  );
}

// --- Estado do bot ---
let sock;
let qrCodeData = null;
let wppReady = false;

// --- Inicializa Baileys ---
async function startBaileys() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys-auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // desativa o QR no terminal
    });

    // Evento para QR Code e conexão
    sock.ev.on('connection.update', (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        qrCodeData = qr;
        wppReady = false;
        console.log('[WPP] QRCode gerado');
      }

      if (connection === 'open') {
        console.log('[WPP] Conectado com sucesso');
        qrCodeData = null;
        wppReady = true;
      }

      if (connection === 'close') {
        console.log('[WPP] Conexão fechada, tentando reconectar...', lastDisconnect?.error?.message || '');
        startBaileys();
      }
    });

    // Salva credenciais
    sock.ev.on('creds.update', saveCreds);

    // Recebe mensagens
    sock.ev.on('messages.upsert', async (msg) => {
      if (msg.type !== 'notify') return;
      for (const message of msg.messages) {
        if (!message.message || message.key.fromMe) continue;

        const from = message.key.remoteJid;
        const text = extractText(message).trim();
        if (!text) continue;

        console.log(`[MSG] ${from}: ${text}`);

        // Carrega histórico (se houver Redis)
        const history = await loadHistory(from);

        // Monta mensagens para o GPT (com histórico)
        const system = buildSystemPrompt();
        const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: text }];

        try {
          const completion = await openai.chat.completions.create({
            // use o modelo que preferir/tem acesso; mantendo compat com seu código atual
            model: 'gpt-3.5-turbo',
            messages,
            temperature: 0.6,
          });

          const reply = (completion.choices?.[0]?.message?.content || '').trim() || 'Certo! Como posso te ajudar?';
          await sendTypingMessage(sock, from, reply);

          // salva histórico atualizado
          const newHist = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply }];
          await saveHistory(from, newHist);
        } catch (err) {
          console.error('[GPT] Erro:', err?.message || err);
          await sendTypingMessage(sock, from, '⚠️ Desculpe, ocorreu um erro ao processar sua mensagem.');
        }
      }
    });
  } catch (err) {
    console.error('[BOOT][ERR]', err);
  }
}

// --- Inicializa ---
startBaileys();

// --- Express ---
const app = express();

// Healthcheck
app.get('/health', (_, res) =>
  res.json({ ok: true, wppReady, qrAvailable: !!qrCodeData })
);

// Redis ping (debug)
app.get('/redis-ping', async (_req, res) => {
  try {
    const cli = await getRedis();
    if (!cli) return res.json({ ok: false, msg: 'REDIS_URL não setada' });
    const pong = await cli.ping();
    res.json({ ok: true, pong, ttl: HISTORY_TTL });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// QR em PNG
app.get('/qr', async (_, res) => {
  if (!qrCodeData) {
    return res.status(400).json({ error: 'QR não disponível' });
  }
  res.setHeader('Content-Type', 'image/png');
  res.send(await qrcode.toBuffer(qrCodeData));
});

// QR em página HTML
app.get('/qr-page', async (_, res) => {
  if (!qrCodeData) {
    return res.send('<h1>✅ WhatsApp conectado!</h1>');
  }
  const qrPng = await qrcode.toDataURL(qrCodeData);
  res.send(`
    <html>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
        <h2>Escaneie o QR Code abaixo</h2>
        <img src="${qrPng}" width="300" height="300"/>
      </body>
    </html>
  `);
});

// Porta do Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
