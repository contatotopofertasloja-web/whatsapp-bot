// --- ENV ---
import 'dotenv/config';

// --- Libs ---
import express from 'express';
import OpenAI from 'openai';
import wppconnect from '@wppconnect-team/wppconnect';

// --- Hardening ---
process.on('unhandledRejection', (e) => console.error('[FATAL][unhandledRejection]', e));
process.on('uncaughtException',  (e) => console.error('[FATAL][uncaughtException]',  e));

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
const PORT     = Number(process.env.PORT || 3000);
const SESSION  = pickEnv(['WPP_SESSION','SESSION_NAME']) || 'SESSION_WHATSAPP';
const MODEL    = pickEnv(['OPENAI_MODEL','MODEL']) || 'gpt-4o-mini';
const BOT_NAME = pickEnv(['BOT_NAME']) || 'TopBot';
const LOCALE   = pickEnv(['BOT_LOCALE']) || 'pt-BR';
const API_KEY  = pickEnv(['OPENAI_API_KEY','OPENAI_API_KEI','OPENAI_APIKEY','OPEN_AI_API_KEY']);

// --- OpenAI ---
const openai = new OpenAI({ apiKey: API_KEY });

// --- Express ---
const app = express();
app.use(express.json({ limit: '2mb' }));

// --- Estado ---
let wppClient = null;
let ready = false;
let lastQrDataUrl = ''; // data:image/png;base64,...
let lastQrAt = 0;

// --- Utils ---
function normalizeQrDataUrl(b64) {
  if (!b64) return '';
  const s = String(b64).trim();
  return s.startsWith('data:image') ? s : `data:image/png;base64,${s.replace(/\s/g,'')}`;
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
app.get('/',       (_,res)=>res.send('OK'));
app.get('/health', (_,res)=>res.json({ ok:true, wppReady:ready, qrAvailable:!!lastQrDataUrl, qrGeneratedAt:lastQrAt }));

// ======== QR endpoints ========
// PNG do QR (204 se já conectado ou ainda sem QR)
app.get('/qr', (req, res) => {
  try {
    if (ready || !lastQrDataUrl) return res.status(204).end();
    const s = String(lastQrDataUrl).trim();
    const b64 = s.startsWith('data:image') ? s.split(',')[1] : s;
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(buf);
  } catch (e) {
    console.error('[QR][ERR]', e);
    res.status(500).json({ ok:false });
  }
});

// Página HTML simples que embute a /qr
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

  try {
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

      // 🔒 Forçar versão estável do WhatsApp Web para evitar "Sincronizando..."
      // Se necessário, ajuste este valor para outra release estável.
      whatsappVersion: '2.3000.1013',

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
        if (['isLogged','qrReadSuccess','chatsAvailable'].includes(statusSession)) {
          ready = true;
          return;
        }
        if (['qrReadError','browserClose','autocloseCalled'].includes(statusSession)) {
          ready = false;
          console.warn('[WPP] Status crítico:', statusSession, '→ reiniciando cliente em 3s...');
          setTimeout(() => {
            try { wppClient?.close(); } catch {}
            startWpp().catch(e => console.error('[WPP][restart][ERR]', e));
          }, 3000);
        }
      },
      onLoadingScreen: (p, msg) => console.log('[WPP][Loading]', p, msg),

      headless: true,

      // ⚙️ Chromium estável + anti-detecção
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-infobars',
        '--window-size=1280,800',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,OptimizationHints,DeviceDiscoveryNotifications,MediaRouter,AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      puppeteerOptions: {
        executablePath,
        headless: 'new',
        // remove flag que denuncia automação
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-infobars',
          '--window-size=1280,800',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=Translate,OptimizationHints,DeviceDiscoveryNotifications,MediaRouter,AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          // User-Agent real de Chrome
          '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
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
  } catch (err) {
    console.error('[BOOT][ERR] startWpp:', err);
    setTimeout(() => startWpp().catch(e => console.error('[WPP][retry][ERR]', e)), 5000);
  }
}

// --- Start HTTP primeiro; WPP depois (evita 502) ---
const server = app.listen(PORT, () => {
  console.log(`[HTTP] Servidor ouvindo em :${PORT}`);
  startWpp()
    .then(() => console.log('[BOOT] WPPConnect iniciado!'))
    .catch((err) => console.error('[BOOT][ERR]', err));
});

// Timeouts pró-proxy Railway
server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.requestTimeout   = 0;

// --- Shutdown limpo ---
async function shutdown(sig) {
  console.log(`[SYS] ${sig} recebido, finalizando...`);
  try { if (wppClient) await wppClient.close(); } catch (e) { console.error('[SYS] close err', e); }
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
