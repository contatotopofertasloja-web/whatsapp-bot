// --- ENV ---
import 'dotenv/config';

// --- Libs ---
import express from 'express';
import OpenAI from 'openai';
import wppconnect from '@wppconnect-team/wppconnect';

const app = express();
const PORT = process.env.PORT || 3000;

// --- API key ---
const pickEnv = (names) => {
  for (const k of names) {
    let v = process.env[k];
    if (typeof v !== 'string') continue;
    v = v.trim().replace(/^['"]|['"]$/g, '');
    if (v) return v;
  }
  return '';
};
const API_KEY = pickEnv(['OPENAI_API_KEY', 'OPENAI_API_KEI', 'OPENAI_APIKEY', 'OPEN_AI_API_KEY']);
const openai = new OpenAI({ apiKey: API_KEY });

// --- Variáveis globais ---
let wppClient = null;
let ready = false;
let lastQrDataUrl = null;
let lastQrAt = null;

// --- Função para perguntar ao GPT ---
async function askOpenAI(prompt) {
  const completion = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: prompt,
  });
  return completion.output_text;
}

// --- Inicializar WPPConnect ---
async function startWpp() {
  console.log('[WPP] Inicializando sessão...');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  const client = await wppconnect.create({
    session: 'gpt-bot',
    waitForLogin: true,
    autoClose: 0,
    maxAttempts: 3,
    maxQrRetries: 9999,
    qrTimeout: 0,
    authTimeout: 0,
    deviceName: 'Railway Bot',
    poweredBy: 'WPPConnect',
    tokenStore: 'file',
    folderNameToken: 'wpp-store',
    deleteSessionToken: false,
    createOnInvalidSession: true,
    restartOnCrash: true,
    killProcessOnBrowserClose: false,
    shutdownOnCrash: false,
    catchQR: (base64Qr, asciiQR, attempts) => {
      lastQrDataUrl = base64Qr;
      lastQrAt = Date.now();
      ready = false;
      console.log(`[WPP][QR] Nova tentativa ${attempts}`);
    },
    statusFind: (statusSession) => {
      console.log('[WPP][Status]', statusSession);
      ready = ['isLogged', 'qrReadSuccess', 'chatsAvailable'].includes(statusSession);
    },
    headless: true,
    browserArgs: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-infobars',
      '--window-size=1280,800', '--single-process', '--no-zygote'
    ],
    puppeteerOptions: {
      executablePath,
      headless: 'new'
    },
    disableSpins: true,
    logQR: false,
  });

  wppClient = client;

  wppClient.onStateChange((state) => {
    console.log('[WPP][State]', state);
    ready = state === 'CONNECTED';
  });

  wppClient.onLogout(() => {
    console.error('[WPP] Logout detectado. Reiniciando...');
    ready = false;
    setTimeout(() => startWpp().catch(e => console.error('[WPP][restart][ERR]', e)), 2000);
  });

  wppClient.onMessage(async (message) => {
    try {
      if (message.fromMe || message.isGroupMsg) return;
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

// --- Rota Health ---
app.get('/health', (_, res) => {
  res.json({
    ok: true,
    wppReady: ready,
    qrAvailable: !!lastQrDataUrl,
    qrGeneratedAt: lastQrAt
  });
});

// --- Rota para exibir QR ---
app.get('/qr', (_, res) => {
  if (lastQrDataUrl) {
    const img = Buffer.from(lastQrDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(img);
  } else {
    res.status(404).json({ ok: false, message: 'QR Code ainda não gerado' });
  }
});

// --- Inicializa servidor e depois o WPP ---
app.listen(PORT, () => {
  console.log(`[HTTP] Servidor ouvindo na porta ${PORT}`);
  startWpp().catch((err) => console.error('[BOOT][ERR]', err));
});
