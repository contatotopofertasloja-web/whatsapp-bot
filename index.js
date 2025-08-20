// --- ENV ---
import 'dotenv/config';

// --- Libs ---
import express from 'express';
import OpenAI from 'openai';
import wppconnect from '@wppconnect-team/wppconnect';

// =============== UTIL / CONFIG ===============
const pickEnv = (names) => {
  for (const k of names) {
    let v = process.env[k];
    if (typeof v !== 'string') continue;
    v = v.trim().replace(/^['"]|['"]$/g, ''); // remove aspas acidentais
    if (v) return v;
  }
  return '';
};

const API_KEY = pickEnv([
  'OPENAI_API_KEY',
  'OPENAI_API_KEI',
  'OPENAI_APIKEY',
  'OPEN_AI_API_KEY',
]);

if (!API_KEY) {
  console.warn('[WARN] OPENAI_API_KEY não encontrado nas ENV vars.');
}

const MODEL = pickEnv(['OPENAI_MODEL', 'MODEL']) || 'gpt-4o-mini';
const PORT = Number(process.env.PORT || 3000);
const SESSION = pickEnv(['WPP_SESSION', 'SESSION_NAME']) || 'railway-bot';
const BOT_NAME = pickEnv(['BOT_NAME']) || 'TopBot';
const LOCALE = pickEnv(['BOT_LOCALE']) || 'pt-BR';

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: API_KEY });

// --- Express ---
const app = express();
app.use(express.json({ limit: '2mb' }));

// Estado simples em memória
let lastQrDataUrl = '';          // data:image/png;base64,....
let lastQrAt = 0;                 // Date.now()
let wppClient = null;
let ready = false;

// =============== ROTAS HTTP ===============
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_, res) => res.json({ ok: true, wppReady: ready }));

app.get('/gpt-test', async (_, res) => {
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'Responda "OK" e nada mais.' },
        { role: 'user', content: 'teste' },
      ],
    });
    const reply = r.choices?.[0]?.message?.content ?? 'OK';
    res.json({ reply });
  } catch (e) {
    console.error('[GPT-TEST]', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Página do QR com auto-refresh
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
  .badge { display:inline-block; margin: 0 6px; padding:4px 10px; border-radius: 999px; background:#1d263b; color:#c3d1e9; font-size:12px; border:1px solid #2a3552; }
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
            ? `<img src="${lastQrDataUrl}" alt="QR Code" />`
            : '<p>Gerando QR… se não aparecer, aguarde alguns segundos e esta página recarregará sozinha.</p>'
      }
    </div>
    <p class="muted">Esta página recarrega automaticamente a cada 5 segundos.</p>
  </div>
<script>setTimeout(()=>location.reload(), 5000)</script>
</body>
</html>`);
});

// =============== FUNÇÕES GPT ===============
async function askOpenAI(userText, contextHints = '') {
  const sys = `Você é ${BOT_NAME}, um assistente de atendimento via WhatsApp.
- Idioma padrão: ${LOCALE}.
- Seja claro, curto e útil.
- Evite respostas muito longas em mensagens únicas.
- Se a pergunta for sobre status de pedido/entrega, solicite dados essenciais (nome, telefone, email, nº do pedido) de forma objetiva.`;

  const msgs = [
    { role: 'system', content: sys },
    ...(contextHints ? [{ role: 'system', content: `Contexto: ${contextHints}` }] : []),
    { role: 'user', content: userText || 'Olá' },
  ];

  const r = await openai.chat.completions.create({
    model: MODEL,
    messages: msgs,
    temperature: 0.3,
    max_tokens: 400,
  });

  return r.choices?.[0]?.message?.content?.trim() || 'Certo!';
}

// =============== WPPCONNECT ===============
async function startWpp() {
  console.log('[WPP] Inicializando sessão:', SESSION);

  wppClient = await wppconnect.create({
    session: SESSION,
    catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
      // Mantém em memória para /qr
      lastQrDataUrl = `data:image/png;base64,${base64Qr}`;
      lastQrAt = Date.now();
      ready = false;
      console.log(`[WPP][QR] Tentativa ${attempts} | urlCode len=${urlCode?.length || 0}`);
      // Opcional: exibe ascii no log
      if (asciiQR) console.log(asciiQR);
    },
    statusFind: (statusSession, session) => {
      console.log('[WPP][Status]', session, statusSession);
      if (['isLogged', 'qrReadSuccess', 'chatsAvailable'].includes(statusSession)) {
        ready = true;
      }
    },
    headless: true,
    // Para Railway/containers headless:
    browserArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
    disableSpins: true,
    logQR: false,
  });

  // Eventos
  wppClient.onStateChange((state) => {
    console.log('[WPP][State]', state);
    if (state === 'CONNECTED') ready = true;
  });

  wppClient.onMessage(async (message) => {
    try {
      // Ignore mensagens do próprio bot
      if (message.fromMe) return;

      // Apenas texto por enquanto
      const body =
        (message?.body || '').trim() ||
        (message?.caption || '').trim();

      if (!body) return;

      // Ignora grupos (opcional)
      if (message.isGroupMsg) {
        // Se quiser responder em grupos, remova este return
        return;
      }

      // Indica "digitando..."
      wppClient.simulateTyping(message.from, true);

      // Chama o GPT
      const reply = await askOpenAI(body);

      // Envia resposta
      await wppClient.sendText(message.from, reply);

      // Para de "digitar"
      wppClient.simulateTyping(message.from, false);
    } catch (err) {
      console.error('[WPP][onMessage][ERR]', err);
      try {
        await wppClient.sendText(
          message.from,
          'Desculpe, tive um erro aqui. Pode repetir a pergunta de outro jeito?'
        );
      } catch (_) {}
    }
  });

  console.log('[WPP] Cliente criado.');
}

// =============== START SERVER ===============
app.listen(PORT, async () => {
  console.log(`[HTTP] Servidor ouvindo em :${PORT}`);
  try {
    await startWpp();
  } catch (e) {
    console.error('[BOOT][ERR]', e);
  }
});

// =============== SHUTDOWN LIMPO ===============
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
