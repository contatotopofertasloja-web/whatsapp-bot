// --- ENV ---
import 'dotenv/config';
 
// --- Libs ---
import express from 'express';
import OpenAI from 'openai';
import wppconnect from '@wppconnect-team/wppconnect';

// --- Hardening contra crashes não tratados ---
process.on('unhandledRejection', (err) => {
  console.error('[FATAL][unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL][uncaughtException]', err);
});

// --- Utils / ENV helpers ---
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
const API_KEY = pickEnv(['OPENAI_API_KEY', 'OPENAI_API_KEI', 'OPENAI_APIKEY', 'OPEN_AI_API_KEY']);
const MODEL = pickEnv(['OPENAI_MODEL', 'MODEL']) || 'gpt-4o-mini';
const PORT = Number(process.env.PORT || 3000);
const SESSION = pickEnv(['WPP_SESSION', 'SESSION_NAME']) || 'railway-bot';
const BOT_NAME = pickEnv(['BOT_NAME']) || 'TopBot';
const LOCALE = pickEnv(['BOT_LOCALE']) || 'pt-BR';

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: API_KEY });

// --- Express app ---
const app = express();
app.use(express.json({ limit: '2mb' }));

// --- Estado em memória ---
let lastQrDataUrl = ''; // data:image/png;base64,..
let lastQrAt = 0;
let wppClient = null;
let ready = false;

// --- Rotas básicas ---
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_, res) => res.json({ ok: true, wppReady: ready }));

app.get('/gpt-test', async (_, res) => {
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'Responda "OK" e nada mais.' },
        { role: 'user', content: 'ping' },
      ],
    });
    res.json({ reply: r.choices?.[0]?.message?.content ?? 'OK' });
  } catch (e) {
    console.error('[GPT-TEST]', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ================== QR ENDPOINTS (leve e estável) ==================
// Serve somente a imagem PNG do QR (evita HTML gigante com base64)
app.get('/qr.png', (req, res) => {
  try {
    if (ready || !lastQrDataUrl) {
      res.status(204).end(); // No Content
      return;
    }
    const idx = lastQrDataUrl.indexOf(',');
    const b64 = idx >= 0 ? lastQrDataUrl.slice(idx + 1) : lastQrDataUrl;
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(buf);
  } catch (e) {
    console.error('[QR.PNG][ERR]', e);
    res.status(500).end();
  }
});

// Página HTML que referencia a imagem acima e auto-atualiza
app.get('/qr', (_, res) => {
  const hasQr = !!lastQrDataUrl && Date.now() - lastQrAt < 5 * 60 * 1000;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Code - ${SESSION}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 24px; background:#0b0e14; color:#eaeef2; }
  .card { max-width: 420px; margin: 0 auto; background:#121826; border:1px solid #26304a; border-radius:16px; padding:20px; text-align:center; }
  img { width: 100%; height:auto; border-radius:12px; }
  .muted { color:#9fb0c6; font-size:14px; margin-top:8px; }
  .badge { display:inline-block; margin: 0 6px; padding:4px 10px; border-radius:999px; background:#1d263b; color:#c3d1e9; font-size:12px; border:1px solid #2a3552; }
  .grid { display:flex; gap:8px; justify-content:center; margin-top:10px; flex-wrap:wrap; }
</style>
</head>
<body>
  <div class="card">
    <h2>Conecte o WhatsApp</h2>
    <div class="grid">
      <span class="badge">Sessão: ${SESSION}</span>
      <span class="badge">${hasQr ? 'QR ativo' : (ready ? 'Conectado' : 'Aguardando QR')}</span>
    </div>
    <div style="margin:16px 0;">
      ${
        ready
          ? '<p>✅ Cliente já conectado. Você pode fechar esta página.</p>'
          : hasQr
              ? '<img src="/qr.png?ts=' + Date.now() + '" alt="QR Code" />'
              : '<p>Gerando QR… se não aparecer, aguarde alguns segundos e esta página recarregará sozinha.</p>'
      }
    </div>
    <p class="muted">Esta página recarrega automaticamente a cada 5 segundos.</p>
  </div>
<script>setTimeout(()=>location.reload(), 30000)</script>
</body>
</html>`);
});
// ================== FIM QR ENDPOINTS ==================

// --- Utils ---
function normalizeQrDataUrl(b64) {
  if (!b64) return '';
  const s = String(b64).trim();
  return s.startsWith('data:image') ? s : `data:image/png;base64,${s.replace(/\s/g, '')}`;
}

async function askOpenAI(userText, contextHints = '') {
  const sys = `Você é ${BOT_NAME}, um assistente de atendimento via WhatsApp.
- Idioma: ${LOCALE}.
- Seja claro e objetivo, evitando textões.
- Para dúvidas de pedido/entrega, peça apenas os dados essenciais (nome, telefone, email, nº do pedido).`;

  const messages = [
    { role: 'system', content: sys },
    ...(contextHints ? [{ role: 'system', content: `Contexto: ${contextHints}` }] : []),
    { role: 'user', content: userText || 'Olá' },
  ];

  const r = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    max_tokens: 400,
    messages,
  });
  return r.choices?.[0]?.message?.content?.trim() || 'Certo!';
}

// --- WPPConnect ---
async function startWpp() {
  console.log('[WPP] Inicializando sessão:', SESSION);
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  const client = await wppconnect.create({
    session: SESSION,

    // Login / sessão
    waitForLogin: true,
    autoClose: 0,
    maxAttempts: 3,
    maxQrRetries: 9999,          // mantém a mesma sessão até conectar
qrTimeout: 0,                // QR não expira (espera indefinidamente)
authTimeout: 0,              // dá tempo ilimitado pro login
autoClose: 0,                // nunca fecha sozinho
    
    deviceName: 'Railway Bot',
    poweredBy: 'WPPConnect',

    // Persistência
    tokenStore: 'file',
    folderNameToken: 'wpp-store',
folderNameToken: 'wpp-store', // já configurado

    deleteSessionToken: false,
    createOnInvalidSession: true,
    restartOnCrash: true,
    killProcessOnBrowserClose: false,
    shutdownOnCrash: false,

    // Handlers
    catchQR: (base64Qr, asciiQR, attempts) => {
      lastQrDataUrl = normalizeQrDataUrl(base64Qr);
      lastQrAt = Date.now();
      ready = false;
      console.log(`[WPP][QR] Tentativa ${attempts} | base64 len=${(base64Qr || '').length}`);
      // if (asciiQR) console.log(asciiQR); // silencie o ASCII (gigante)
    },
    statusFind: (statusSession, session) => {
      console.log('[WPP][Status]', session, statusSession);
      ready = ['isLogged', 'qrReadSuccess', 'chatsAvailable'].includes(statusSession);
    },
    onLoadingScreen: (percent, message) => {
      console.log('[WPP][Loading]', percent, message);
    },

    headless: true,

    // Chromium (container-friendly)
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

  wppClient = client;

  // Eventos de estado
  wppClient.onStateChange((state) => {
    console.log('[WPP][State]', state);
    if (state === 'CONNECTED') ready = true;
    if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED', 'DISCONNECTED'].includes(state)) {
      ready = false;
    }
  });

  wppClient.onLogout(() => {
    console.error('[WPP] Logout detectado. Reiniciando cliente...');
    ready = false;
    setTimeout(() => startWpp().catch(e => console.error('[WPP][restart][ERR]', e)), 2000);
  });

  // Mensagens
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
app.listen(PORT, () => {
  console.log(`[HTTP] Servidor ouvindo em :${PORT}`);
  startWpp()
    .then(() => console.log('[BOOT] WPPConnect iniciado com sucesso!'))
    .catch((err) => console.error('[BOOT][ERR]', err));
});

// --- Shutdown limpo ---
async function shutdown(sig) {
  console.log(`[SYS] Recebido ${sig}, finalizando...`);
  try {
    if (wppClient) await wppClient.close();
  } catch (e) {
    console.error('[SYS] Erro ao fechar WPP:', e);
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
