// --- ENV ---
import 'dotenv/config';

// --- Libs ---
import express from 'express';
import OpenAI from 'openai';
import wppconnect from '@wppconnect-team/wppconnect';

// --- API key (com fallback e normalização) ---
const pickEnv = (names) => {
  for (const k of names) {
    let v = process.env[k];
    if (typeof v !== 'string') continue;
    v = v.trim().replace(/^['"]|['"]$/g, '');
    if (v) return v;
  }
  return '';
};
const API_KEY = pickEnv([
  'OPENAI_API_KEY',
  'OPENAI_API_KEI',
  'OPENAI_APIKEY',
  'OPEN_AI_API_KEY'
]);

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: API_KEY });

// --- Express App ---
const app = express();
app.use(express.json());

// --- Variáveis globais ---
const SESSION = 'SESSION_WHATSAPP';
let wppClient;
let lastQrDataUrl = null;
let lastQrAt = null;
let ready = false;

// --- Função para iniciar cliente WPP ---
async function startWpp() {
  console.log('[BOOT] Iniciando sessão WPP...');
  try {
    wppClient = await wppconnect.create({
      session: SESSION,

      // Sessão e login
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

      // QR Code
      catchQR: (base64Qr, asciiQR, attempts) => {
        lastQrDataUrl = normalizeQrDataUrl(base64Qr);
        lastQrAt = Date.now();
        ready = false;
        console.log(`[WPP][QR] Tentativa ${attempts} | base64 len=${(base64Qr || '').length}`);
      },

      // Status da sessão
      statusFind: (statusSession, session) => {
        console.log('[WPP][Status]', session, statusSession);
        // Sessão ativa
        if (['isLogged', 'qrReadSuccess', 'chatsAvailable'].includes(statusSession)) {
          ready = true;
          return;
        }
        // Sessão caiu → reinicia
        if (['qrReadError', 'browserClose', 'autocloseCalled'].includes(statusSession)) {
          ready = false;
          console.warn('[WPP] Status crítico:', statusSession, '→ reiniciando cliente em 3s...');
          setTimeout(() => {
            try { wppClient?.close(); } catch {}
            startWpp().catch(e => console.error('[WPP][restart][ERR]', e));
          }, 3000);
        }
      },

      onLoadingScreen: (percent, message) => {
        console.log('[WPP][Loading]', percent, message);
      },

      headless: true,

      // Ajustes do Chromium para estabilidade
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
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        headless: 'new',
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
          '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
        ]
      },

      disableSpins: true,
      logQR: false,
    });

    // Listener principal para mensagens recebidas
    wppClient.onMessage(async (message) => {
      try {
        if (!message.body || message.isGroupMsg) return;

        const prompt = message.body.trim();
        console.log(`[GPT][Prompt] ${prompt}`);

        const completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: prompt }],
        });

        const reply = completion.choices[0].message.content;
        console.log(`[GPT][Reply] ${reply}`);

        await wppClient.sendText(message.from, reply);
      } catch (err) {
        console.error('[GPT][ERR]', err);
      }
    });

  } catch (error) {
    console.error('[BOOT][ERR] Erro ao iniciar WPP:', error);
    setTimeout(() => startWpp(), 5000);
  }
}

// --- Normaliza QR Code base64 ---
function normalizeQrDataUrl(qr) {
  if (!qr) return null;
  if (qr.startsWith('data:image/png;base64,')) return qr;
  return `data:image/png;base64,${qr}`;
}

// --- Rotas Express ---
app.get('/', (_, res) => res.send('OK'));

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    wppReady: ready,
    qrAvailable: !!lastQrDataUrl,
    qrGeneratedAt: lastQrAt,
  });
});

app.get('/qr', (_, res) => {
  if (!lastQrDataUrl) return res.status(404).send('QR code ainda não gerado');
  const html = `
    <html>
      <body style="background:#000;display:flex;align-items:center;justify-content:center;height:100vh;">
        <img src="${lastQrDataUrl}" alt="QR Code" style="width:300px;height:300px;" />
      </body>
    </html>`;
  res.set('Content-Type', 'text/html').send(html);
});

// --- Inicializa servidor ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[HTTP] Servidor ouvindo na porta ${PORT}`);
  startWpp();
});
