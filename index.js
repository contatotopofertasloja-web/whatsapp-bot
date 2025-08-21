// --- ENV ---
import 'dotenv/config';

// --- Libs ---
import express from 'express';
import OpenAI from 'openai';
import wppconnect from '@wppconnect-team/wppconnect';

// --- API Key ---
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

// --- Express ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- Variáveis globais ---
let wppClient = null;
let ready = false;
let lastQrDataUrl = null;
let lastQrAt = null;

// --- Função para chamar OpenAI ---
async function askOpenAI(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('[OpenAI][ERR]', err);
    return 'Ops! Tive um problema ao processar sua mensagem.';
  }
}

// --- Função para inicializar o WPPConnect ---
async function startWpp() {
  console.log('[WPP] Iniciando sessão...');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  try {
    const client = await wppconnect.create({
      session: 'SESSION_WHATSAPP',
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

      // QRCode
      catchQR: (base64Qr, asciiQR, attempts) => {
        lastQrDataUrl = `data:image/png;base64,${base64Qr}`;
        lastQrAt = Date.now();
        ready = false;
        console.log(`[WPP][QR] Tentativa ${attempts}`);
      },
      statusFind: (statusSession, session) => {
        console.log('[WPP][Status]', session, statusSession);
        ready = ['isLogged', 'qrReadSuccess', 'chatsAvailable'].includes(statusSession);
      },

      headless: true,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-infobars',
        '--window-size=1280,800',
        '--single-process',
        '--no-zygote'
      ],
      puppeteerOptions: {
        executablePath,
        headless: 'new',
      },
      disableSpins: true,
      logQR: false,
    });

    wppClient = client;

    // Eventos de mudança de estado
    wppClient.onStateChange((state) => {
      console.log('[WPP][State]', state);
      ready = state === 'CONNECTED';
    });

    // Recebimento de mensagens
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
      }
    });

    console.log('[WPP] Cliente iniciado com sucesso!');
  } catch (err) {
    console.error('[WPP][startWpp][ERR]', err);
  }
}

// --- Rota Health ---
app.get('/health', (_, res) => {
  res.json({
    ok: true,
    wppReady: ready,
    qrAvailable: !!lastQrDataUrl,
    qrGeneratedAt: lastQrAt,
  });
});

// --- Inicializa o servidor primeiro ---
app.listen(PORT, () => {
  console.log(`[HTTP] Servidor ouvindo na porta ${PORT}`);
  setTimeout(() => {
    startWpp()
      .then(() => console.log('[BOOT] WPPConnect iniciado!'))
      .catch((err) => console.error('[BOOT][ERR]', err));
  }, 3000); // atraso para evitar timeout no Railway
});
