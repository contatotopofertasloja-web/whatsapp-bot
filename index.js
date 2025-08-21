// --- ENV ---
import 'dotenv/config';

// --- Libs ---
import express from 'express';
import OpenAI from 'openai';
import wppconnect from '@wppconnect-team/wppconnect';

// --- Hardening contra crashes não tratados ---
process.on('unhandledRejection', (err) => console.error('[FATAL][unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[FATAL][uncaughtException]', err));

// --- Helpers ---
const pickEnv = (names) => {
  for (const k of names) {
    let v = process.env[k];
    if (typeof v !== 'string') continue;
    v = v.trim().replace(/^['"]|['"]$/g, '');
    if (v) return v;
  }
  return '';
};

// --- Config ---
const PORT = Number(process.env.PORT || 3000);
const SESSION = pickEnv(['WPP_SESSION', 'SESSION_NAME']) || 'SESSION_WHATSAPP';
const MODEL = pickEnv(['OPENAI_MODEL', 'MODEL']) || 'gpt-4o-mini';
const BOT_NAME = pickEnv(['BOT_NAME']) || 'TopBot';
const LOCALE = pickEnv(['BOT_LOCALE']) || 'pt-BR';
const API_KEY = pickEnv(['OPENAI_API_KEY', 'OPENAI_API_KEI', 'OPENAI_APIKEY', 'OPEN_AI_API_KEY']);

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: API_KEY });

// --- Express ---
const app = express();
app.use(express.json({ limit: '2mb' }));

// --- Estado em memória ---
let wppClient = null;
let ready = false;
let lastQrDataUrl = ''; // "data:image/png;base64,..."
let lastQrAt = 0;

// --- Utils ---
function normalizeQrDataUrl(b64) {
  if (!b64) return '';
  const s = String(b64).trim();
  return s.startsWith('data:image') ? s : `data:image/png;base64,${s.replace(/\s/g, '')}`;
}

async function askOpenAI(text) {
  try {
    const sys = `Você é ${BOT_NAME}, um assistente de WhatsApp. Responda em ${LOCALE}, curto e objetivo.`;
    const r = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: text || 'Olá' },
      ],
    });
    return r.choices?.[0]?.message?.content?.trim() || 'Certo!';
  } catch (e) {
    console.error('[OpenAI][ERR]', e);
    return 'Ops! Tive um problema ao processar sua mensagem.';
  }
}

// --- Rotas básicas ---
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_, res) =>
  res.json({ ok: true, wppReady: ready, qrAvailable: !!lastQrDataUrl, qrGeneratedAt: lastQrAt })
);

// ======== QR endpoints ========
// /qr -> retorna a IMAGEM PNG do QR diretamente (204 se já conectado ou sem QR)
app.get('/qr', (req, res) => {
  try {
    if (ready || !lastQrDataUrl) return res.status(204).end();
    const s = String(lastQrDataUrl).trim();
    const b64 = s.startsWith('data:image') ? s.split(',')[1] : s;
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.send(buf);
  } catch (e) {
    console.error('[QR][ERR]', e);
    return res.status(500).json({ ok: false });
  }
});

// /qr-page -> página simples que embute a imagem de /qr (para abrir no navegador)
app.get('/qr-page', (_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Code - ${SESSION}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0e14; color:#eaeef2; padding:24px }
  .card { max-width:420px; margin:0 auto; background:#121826; border:1px solid #26304a; border-radius:16px; padding:20px; text-align:center }
  img { width:100%; height:auto; border-radius:12px }
  .muted { color:#9fb0c6; font-size:14px; margin-top:8px }
  .badge { display:inline-block; margin:0 6px; padding:4px 10px; border-radius:999px; background:#1d263b; color:#c3d1e9; font-size:12px; border:1px solid #2a3552 }
  .grid { display:flex; gap:8px; justify-content:center; margin-top:10px; flex-wrap:wrap }
</style>
</head><body>
  <div class="card">
    <h2>Conecte o WhatsApp</h2>
    <div class="grid">
      <span class="badge">Sessão: ${SESSION}</span>
      <span class="badge">${ready ? 'Conectado' : (lastQrDataUrl ? 'QR ativo' : 'Gerando QR…')}</span>
    </div>
    <div style="margin:16px 0;">
      ${ready ? '<p>✅ Cliente já conectado.</p>' : '<img src="/qr?ts=' + Date.now() + '" alt="QR Code" />'}
    </div>
    <p class="muted">Esta página recarrega automaticamente a cada 30s.</p>
  </div>
<script>setTimeout(()=>location.reload(), 30000)</script>
</body></html>`);
});
// ======== fim QR endpoints ========

// --- WPPConnect ---
async function startWpp() {
  console.log('[WPP] Inicializando sessão:', SESSION);
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  wppClient = await wppconnect.create({
    session: SESSION,

    // Login / sessão (tempo livre p/ autenticar)
    waitForLogin: true,
    autoClose: 0,
    maxAttempts: 3,
    maxQrRetries: 9999,
    qrTimeout: 0,
    authTimeout: 0,
    deviceName: 'Railway Bot',
    poweredBy: 'WPPConnect',

    // Persistência
    tokenStore: 'file',
    folderNameToken: 'wpp-store',
    deleteSessionToken: false,
    createOnInvalidSession: true,
    restartOnCrash: true,
    killProcessOnBrowserClose: false,
    shutdownOnCrash: false,

    // QR
    catchQR: (base64Qr, asciiQR, attempts) => {
      lastQrDataUrl = normalizeQrDataUrl(base64Qr);
      lastQrAt = Date.now();
      ready = false;
      console.log(`[WPP][QR] Tentativa ${attempts} | base64 len=${(base64Qr || '').length}`);
      // if (asciiQR) console.log(asciiQR); // deixe comentado (ASCII gigante)
    },
    statusFind: (statusSession, session) => {
      console.log('[WPP][Status]', session, statusSession);
      ready = ['isLogged', 'qrReadSuccess', 'chatsAvailable'].includes(statusSession);
    },
    onLoadingScreen: (percent, message) => {
      console.log('[WPP][Loading]', percent, message);
    },

    headless: true,

    // Chromium em container
    browserArgs: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-infobars',
      '--window-size=1280,800', '--single-process', '--no-zygote'
    ],
    puppeteerOptions: {
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-extensions', '--disable-infobars',
        '--window-size=1280,800', '--single-process', '--no-zygote'
      ],
    },

    disableSpins: true,
    logQR: false,
  });

  // Eventos
  wppClient.onStateChange((state) => {
    console.log('[WPP][State]', state);
    ready = state === 'CONNECTED';
    if (['CONFLICT','UNPAIRED','UNLAUNCHED','DISCONNECTED'].includes(state)) ready = false;
  });

  wppClient.onLogout(() => {
    console.error('[WPP] Logout detectado. Reiniciando cliente...');
    ready = false;
    setTimeout(() => startWpp().catch(e => console.error('[WPP][restart][ERR]', e)), 2000);
  });

  wppClient.onMessage(async (message) => {
    try {
      if (message.fromMe) return;
      if (message.isGroupMsg) return; // remova se quiser grupos
      const body = (message?.body || message?.caption || '').trim();
      if (!body) return;

      await wppClient.simulateTyping(message.from, true);
      const reply = await askOpenAI(body);
      await wppClient.sendText(message.from, reply);
      await wppClient.simulateTyping(message.from, false);
    } catch (err) {
      console.error('[WPP][onMessage][ERR]', err);
      try { await wppClient.sendText(message.from, 'Ops! Tive um erro aqui. Pode tentar de novo?'); } catch (_) {}
    }
  });

  console.log('[WPP] Cliente criado.');
}

// --- Start HTTP primeiro; WPP inicia assíncrono (evita timeout no Railway) ---
const server = app.listen(PORT, () => {
  console.log(`[HTTP] Servidor ouvindo em :${PORT}`);
  startWpp()
    .then(() => console.log('[BOOT] WPPConnect iniciado com sucesso!'))
    .catch((err) => console.error('[BOOT][ERR]', err));
});

// Timeouts amigáveis ao proxy do Railway
server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.requestTimeout   = 0;

// --- Shutdown limpo ---
async function shutdown(sig) {
  console.log(`[SYS] Recebido ${sig}, finalizando...`);
  try { if (wppClient) await wppClient.close(); } catch (e) { console.error('[SYS] Erro ao fechar WPP:', e); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
