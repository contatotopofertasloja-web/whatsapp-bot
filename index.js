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
import { createClient } from 'redis';

// -------- util de caminho (__dirname em ESM) --------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------- OpenAI --------
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || '').trim(),
});

// -------- Config da Lívia (JSON) --------
const LIVIA_CONFIG_PATH =
  (process.env.LIVIA_CONFIG_PATH && process.env.LIVIA_CONFIG_PATH.trim()) ||
  path.join(__dirname, 'config', 'livia_unificado_mvp.json');

function safeLoadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[LIVIA] Não foi possível carregar JSON em', filePath, '→ usando fallback.');
    return {};
  }
}
const LIVIA = safeLoadJSON(LIVIA_CONFIG_PATH);
const identityStrict = LIVIA.identity_strict || {};
const persona = LIVIA.persona || {};

// --- Produto foco básico (H1)
const productFocus =
  LIVIA?.product_focus ||
  LIVIA?.product ||
  (LIVIA?.product_catalog?.[LIVIA?.product_catalog?.default_product_key]) ||
  { name: 'Progressiva Vegetal', type: 'cosmético', payment: 'Pagamento na Entrega (COD)' };

const PRODUCT_SYNONYMS = Array.isArray(productFocus?.synonyms) && productFocus.synonyms.length
  ? productFocus.synonyms
  : ['progressiva vegetal', 'progressiva', 'escova progressiva', 'alisamento', 'alisante', 'botox capilar vegetal'];

function isProductQuery(txt = '') {
  const s = (txt || '').toLowerCase();
  return PRODUCT_SYNONYMS.some(w => s.includes(w));
}

// --- BLOCO 03A: Produto padrão do catálogo (H2)
const DEFAULT_PRODUCT_KEY = LIVIA?.product_catalog?.default_product_key;
const PRODUCT = (DEFAULT_PRODUCT_KEY && LIVIA?.product_catalog?.[DEFAULT_PRODUCT_KEY]) || productFocus || {};

const PRODUCT_NAME = PRODUCT?.name || 'Progressiva Vegetal';
const BENEFITS = Array.isArray(PRODUCT?.benefits) ? PRODUCT.benefits : [];
const DIFFERENTIALS = Array.isArray(PRODUCT?.differentials) ? PRODUCT.differentials : [];
const DELIVERY = PRODUCT?.delivery || {}; // { avg_days_min, avg_days_max, note, tracking_by }

const PRICING = PRODUCT?.pricing || {};
const PRICING_TIERS = PRICING?.tiers || {};
const PRICING_DEFAULT_TIER = PRICING?.default_tier || Object.keys(PRICING_TIERS)[0] || null;
const PRICING_DEFAULT_URL = PRICING_DEFAULT_TIER ? (PRICING_TIERS[PRICING_DEFAULT_TIER]?.checkout_url || null) : null;

// BLOCO 02: Regras de COD/Entrega (templates)
const FAQ = LIVIA?.faq_cod_entregas || {};
const CHECKOUT_CTA_TEMPLATE = FAQ?.rules?.checkout_cta_template || 'Aqui está seu link 👉 {{checkout_url}}';
function formatCheckoutCTA(url) {
  return (CHECKOUT_CTA_TEMPLATE || 'Link: {{checkout_url}}').replace('{{checkout_url}}', url || '');
}
function sendCheckoutIfReady(sock, jid, url = PRICING_DEFAULT_URL) {
  if (!url) return null;
  const msg = formatCheckoutCTA(url);
  return sendTypingMessage(sock, jid, msg);
}
// --- Anti-repetição e fechamento inteligente ---
function isDeliveryQuery(t){ return /\b(entrega|prazo|frete|chega|demora)\b/i.test(t||''); }
function isBenefitsQuery(t){ return /\b(benef[ií]cios?|vantagens?|diferenciais?)\b/i.test(t||''); }
function isPriceQuery(t){ return /\b(pre[cç]o|valor|custa|quanto)\b/i.test(t||''); }

const GENERIC_CLOSERS = [
  'Como posso te ajudar mais?',
  'Como posso ser útil hoje?',
  'Como posso te ajudar hoje?'
];

function smartClosingQuestion(userText){
  if (isDeliveryQuery(userText)) return 'Me passa seu CEP para eu calcular o prazo certinho?';
  if (isBenefitsQuery(userText)) return 'Quer que eu te mostre como aplicar passo a passo?';
  if (isPriceQuery(userText)) return 'Você pensa em 1, 2 ou 3 unidades?';
  if (isProductQuery(userText)) return 'Prefere um resultado liso intenso ou mais natural?';
  return 'Posso te ajudar em mais algum ponto?';
}

function stripRepeatedClosers(txt){
  let out = txt || '';
  for (const c of GENERIC_CLOSERS){
    const re = new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
    out = out.replace(re, '').trim();
  }
  return out;
}

function limitEmojis(txt){
  const all = (txt||'').match(/\p{Extended_Pictographic}/gu) || [];
  if (all.length <= 1) return txt;
  let kept = false;
  return (txt||'').replace(/\p{Extended_Pictographic}/gu, m => kept ? '' : (kept = true, m));
}

function limitSentences(txt, max=3){
  const parts = (txt||'').split(/(?<=\.)\s+/).filter(Boolean);
  return parts.slice(0, max).join(' ').trim() || txt;
}

function polishReply(reply, userText){
  let out = reply || '';

  // Evitar CTA texto quando não há intenção de compra
  if (!isBuyIntent(userText)){
    out = out.replace(/(?:posso te enviar o link[^.]*\.)/gi, '').trim();
  }

  out = stripRepeatedClosers(out);
  out = limitSentences(out, 3);
  out = limitEmojis(out);

  const closing = smartClosingQuestion(userText);
  if (closing && !out.endsWith('?')) out = `${out} ${closing}`;
  return out.trim();
}

// -------- Prompt do sistema (consolidado H1 + H2)
function buildSystemPrompt() {
  const name = identityStrict.always_name || 'Lívia Martins';
  const forbidBot = identityStrict.never_reveal_bot !== false; // default true
  const city = persona.city || 'Brasília';
  const brand = persona.brand || 'TopOfertas Express';

  const entregaTxt = (DELIVERY?.avg_days_min && DELIVERY?.avg_days_max)
    ? `Entrega média ${DELIVERY.avg_days_min} a ${DELIVERY.avg_days_max} dias úteis.`
    : `Entrega rápida (em dias úteis).`;
  const codTxt = `Pagamento na entrega (COD) disponível quando aplicável.`;
  const benefitsTxt = BENEFITS.length ? `Benefícios principais: ${BENEFITS.join(', ')}.` : '';
  const diffTxt = DIFFERENTIALS.length ? `Diferenciais: ${DIFFERENTIALS.join(', ')}.` : '';

  return [
    `Você é ${name}, vendedora da ${brand}, em ${city}.`,
    `Fale de forma humana, calorosa e objetiva; tom de consultora-amiga; use no máximo 2 emojis.`,
    forbidBot ? `Nunca diga que é bot, IA ou atendente virtual.` : ``,
    `Você vende um produto cosmético chamado "${PRODUCT_NAME}" no e-commerce, com envio para todo o Brasil.`,
    `Nunca ofereça serviço presencial ou agendamento de salão; se perguntarem como serviço, explique gentilmente que é um produto para usar em casa.`,
    benefitsTxt,
    diffTxt,
    `${entregaTxt} ${codTxt}`,
    PRICING_DEFAULT_URL
      ? `Quando houver intenção de compra, apresente o checkout usando este template: "${CHECKOUT_CTA_TEMPLATE}".`
      : ``,
    `Nunca escreva "{{checkout_url}}" nas respostas; o link real será enviado separadamente quando a cliente pedir.`,
    `Se a cliente perguntar "tem progressiva?" ou variações, interprete como o produto "${PRODUCT_NAME}" (não como serviço).`
  ].filter(Boolean).join(' ');
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
    return Array.isArray(arr) ? arr : [];
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
    const delay = Math.min(3500, Math.max(500, (message || '').length * 25));
    await sleep(delay);
    await sock.sendMessage(jid, { text: message });
  } catch (e) {
    console.warn('[WPP][typing] falhou, enviando direto:', e?.message || e);
    try { await sock.sendMessage(jid, { text: message }); } catch (e2) { console.error('[WPP] sendMessage erro:', e2?.message || e2); }
  } finally {
    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
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
      printQRInTerminal: false,
    });

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

        const history = await loadHistory(from);

        const system = buildSystemPrompt();
        const hints = [];
        if (isProductQuery(text)) {
          hints.push(
            `ATENÇÃO: cliente perguntou sobre "${PRODUCT_NAME}" (progressiva). Responda como PRODUTO (e-commerce), não como serviço. ` +
            `Se fizer sentido, mencione pagamento na entrega (COD) e envio de forma objetiva.`
          );
        }

        const messages = [
          { role: 'system', content: system },
          ...hints.map(h => ({ role: 'system', content: h })),
          ...history,
          { role: 'user', content: text }
        ];

        try {
          const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages,
            temperature: 0.6,
          });

 const reply = (completion.choices?.[0]?.message?.content || '').trim() || 'Certo! Como posso te ajudar?';
const polished = polishReply(reply, text);
await sendTypingMessage(sock, from, polished);

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
app.get('/health', (_, res) => res.json({ ok: true, wppReady, qrAvailable: !!qrCodeData }));

// Versão (debug)
const BUILD_TAG = process.env.BUILD_TAG || new Date().toISOString();
app.get('/version', (_req, res) => res.json({ ok: true, build: BUILD_TAG }));

// JSON da Lívia — verificação rápida
app.get('/livia-info', (_req, res) => {
  const loaded = !!LIVIA && Object.keys(LIVIA || {}).length > 0;
  res.json({ loaded, path: LIVIA_CONFIG_PATH, name: LIVIA?.name || null, version: LIVIA?.version || null });
});

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
app.get('/qr', async (_req, res) => {
  if (!qrCodeData) return res.status(400).json({ error: 'QR não disponível' });
  res.setHeader('Content-Type', 'image/png');
  res.send(await qrcode.toBuffer(qrCodeData));
});

// QR em página HTML
app.get('/qr-page', async (_req, res) => {
  if (!qrCodeData) return res.send('<h1>✅ WhatsApp conectado!</h1>');
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
