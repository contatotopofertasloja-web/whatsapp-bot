// ENV
import 'dotenv/config';

// Libs
import express from 'express';
import qrcode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';
import OpenAI from 'openai';
import fs from 'fs';

// Config
const PORT = Number(process.env.PORT || 3000);
const SESSION_DIR = process.env.SESSION_DIR || 'baileys-auth';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

const app = express();
app.use(express.json({ limit: '2mb' }));

// Estado
let sock = null;         // conexão Baileys
let ready = false;       // chats disponíveis
let qrString = '';       // string do QR (não imagem)
let qrAt = 0;            // timestamp do último QR

// OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function askOpenAI(text) {
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        { role: 'system', content: 'Você é um atendente via WhatsApp. Responda em pt-BR de forma breve e objetiva.' },
        { role: 'user', content: text || 'Olá' }
      ]
    });
    return r.choices?.[0]?.message?.content?.trim() || 'Certo!';
  } catch (e) {
    console.error('[OpenAI][ERR]', e);
    return 'Ops! tive um probleminha aqui.';
  }
}

// ===== Baileys (WhatsApp via WebSocket) =====
async function startBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion(); // pega versão compatível automaticamente
  console.log('[BAILEYS] usando WA Web version', version);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, fs)
    },
    printQRInTerminal: false, // QR vai por HTTP
    syncFullHistory: false,   // não precisa baixar histórico
    markOnlineOnConnect: false
  });

  // Persistência
  sock.ev.on('creds.update', saveCreds);

  // Conexão / QR / Reconexão
  sock.ev.on('connection.update', (upd) => {
    const { connection, qr, lastDisconnect } = upd;

    if (qr) {
      qrString = qr;
      qrAt = Date.now();
      ready = false;
      console.log('[BAILEYS][QR] disponível');
    }

    if (connection === 'open') {
      ready = true;
      qrString = '';
      console.log('[BAILEYS] conectado!');
    }

    if (connection === 'close') {
      ready = false;
      const code = lastDisconnect?.error?.output?.statusCode
                || lastDisconnect?.error?.statusCode
                || lastDisconnect?.error?.code;
      const reason = DisconnectReason[code] || code || 'unknown';
      console.warn('[BAILEYS] desconectado:', reason);
      setTimeout(() => startBaileys().catch(e => console.error('[BAILEYS][reconnect][ERR]', e)), 2000);
    }
  });

  // Mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      const m = messages?.[0];
      if (!m?.message || m.key.fromMe) return;

      const remoteJid = m.key.remoteJid;

      // extrai texto
      const body =
        m.message.conversation ??
        m.message.extendedTextMessage?.text ??
        m.message.imageMessage?.caption ??
        m.message.videoMessage?.caption ??
        '';

      const text = (body || '').trim();
      if (!text) return;

      await sock.presenceSubscribe(remoteJid);
      await sock.sendPresenceUpdate('composing', remoteJid);

      const reply = await askOpenAI(text);
      await sock.sendMessage(remoteJid, { text: reply });

      await sock.sendPresenceUpdate('paused', remoteJid);
    } catch (e) {
      console.error('[BAILEYS][onMessage][ERR]', e);
    }
  });
}

// ===== HTTP endpoints =====
app.get('/', (_, res) => res.send('OK'));

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    wappReady: ready,
    qrAvailable: !!qrString,
    qrGeneratedAt: qrAt
  });
});

// QR em PNG (leve pro browser)
app.get('/qr', async (_, res) => {
  try {
    if (ready || !qrString) return res.status(204).end(); // sem conteúdo
    const png = await qrcode.toBuffer(qrString, { width: 512 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(png);
  } catch (e) {
    console.error('[QR][ERR]', e);
    res.status(500).end();
  }
});

// Página do QR
app.get('/qr-page', async (_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Code - Baileys</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0e14; color:#eaeef2; padding:24px }
  .card { max-width:420px; margin:0 auto; background:#121826; border:1px solid #26304a; border-radius:16px; padding:20px; text-align:center }
  img { width:100%; height:auto; border-radius:12px }
  .muted { color:#9fb0c6; font-size:14px; margin-top:8px }
</style>
</head><body>
  <div class="card">
    <h2>Conecte o WhatsApp</h2>
    <div style="margin:16px 0;">
      ${ready ? '<p>✅ Conectado!</p>' : '<img src="/qr?ts=' + Date.now() + '" alt="QR Code" />'}
    </div>
    <p class="muted">Se o QR não aparecer, recarregue esta página.</p>
  </div>
</body></html>`);
});

// (Opcional) Envio manual para teste
app.post('/send', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(409).json({ ok:false, error:'WhatsApp ainda não está pronto (wappReady=false)' });

    const { to, text } = req.body || {};
    if (!to) return res.status(400).json({ ok:false, error:'Informe "to" (DDI+DDD+número). Ex: 5511999999999' });

    const jid = String(to).replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: text || 'ping do /send' });
    res.json({ ok:true, to: jid });
  } catch (e) {
    console.error('[HTTP][send][ERR]', e);
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// Start
const server = app.listen(PORT, () => {
  console.log(`[HTTP] Servidor ouvindo em :${PORT}`);
  startBaileys().catch(e => console.error('[BOOT][ERR]', e));
});
server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.requestTimeout   = 0;

// Shutdown limpo
async function shutdown(sig) {
  console.log(`[SYS] ${sig} recebido, finalizando...`);
  try { await sock?.ws?.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
