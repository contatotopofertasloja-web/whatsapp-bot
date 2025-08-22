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

// util __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- OpenAI ---
const openai = new OpenAI({ apiKey: (process.env.OPENAI_API_KEY || '').trim() });

// --- JSON da Lívia ---
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
// --- Blocos da Lívia (MVP) ---
const BLOCOS_PATH =
  process.env.BLOCOS_PATH || path.join(__dirname, 'config', 'blocos_livia_mvp.json');

let BLOCOS = null;
try {
  BLOCOS = JSON.parse(fs.readFileSync(BLOCOS_PATH, 'utf8'));
  console.log('[BLOCOS] carregado:', BLOCOS?.version || 'sem versão');
} catch (e) {
  console.warn('[BLOCOS] não carregado →', e?.message || e);
  BLOCOS = null;
}

function buildSystemPromptBase(memSummary = '') {
  const product   = BLOCOS?.product || 'Progressiva Vegetal';
  const style     = BLOCOS?.rules?.style || 'curta, calorosa, objetiva';
  const ctaPolicy = BLOCOS?.rules?.cta_policy || 'evitar repetir CTA em mensagens consecutivas';

  return [
    'Você é a Lívia, vendedora da TopOfertas (Brasília).',
    `Tom: ${style}. Responda em 1–2 frases, sem jargão.`,
    `Política de CTA: ${ctaPolicy}.`,
    `Produto foco: ${product}.`,
    `RESUMO_7d: (vazio neste passo)`,
    `Se fizer sentido, use as frases sugeridas como inspiração — adapte e mantenha o tom natural.`
  ].join('\n');
}

function intentFor(text = '') {
  const s = (text || '').toLowerCase();
  if (/\b(oi|olá|bom dia|boa tarde|boa noite)\b/.test(s)) return 'greeting';
  if (isPriceQuery?.(text))  return 'price';
  if (isBuyIntent?.(text))   return 'buy';
  return 'other';
}

function blockSuggestions(text = '') {
  const blocks = BLOCOS?.blocks || {};
  const intent = intentFor(text);

  let pick = [];
  if (intent === 'greeting' && blocks.B01_saudacao?.variants)   pick = blocks.B01_saudacao.variants;
  else if (intent === 'price' && blocks.B04_objeções?.map?.preco) pick = blocks.B04_objeções.map.preco;
  else if (intent === 'buy' && blocks.B05_fechamento?.variants) pick = blocks.B05_fechamento.variants;
  else if (blocks.B02_qualificacao?.variants)                   pick = blocks.B02_qualificacao.variants;

  if (!Array.isArray(pick) || !pick.length) return '';
  const one = () => pick[Math.floor(Math.random() * pick.length)];
  const uniq = Array.from(new Set([one(), one()])).filter(Boolean);
  return uniq.length ? `Sugestões:\n- ${uniq.join('\n- ')}` : '';
}


// --- Produto (catálogo JSON + fallback) ---
const DEFAULT_PRODUCT_KEY = LIVIA?.product_catalog?.default_product_key;
const PRODUCT =
  (DEFAULT_PRODUCT_KEY && LIVIA?.product_catalog?.[DEFAULT_PRODUCT_KEY]) ||
  LIVIA?.product_focus ||
  LIVIA?.product ||
  { name: 'Progressiva Vegetal Profissional' };

const PRODUCT_NAME = PRODUCT?.name || 'Progressiva Vegetal Profissional';
const BENEFITS = Array.isArray(PRODUCT?.benefits) ? PRODUCT.benefits : [];
const DIFFERENTIALS = Array.isArray(PRODUCT?.differentials) ? PRODUCT.differentials : [];
const DELIVERY = PRODUCT?.delivery || {}; // { avg_days_min, avg_days_max, ... }

const PRICING = PRODUCT?.pricing || {};
const PRICING_TIERS = PRICING?.tiers || {};
const PRICING_DEFAULT_TIER = PRICING?.default_tier || Object.keys(PRICING_TIERS)[0] || null;
const PRICING_DEFAULT_URL = PRICING_DEFAULT_TIER ? (PRICING_TIERS[PRICING_DEFAULT_TIER]?.checkout_url || null) : null;

// FAQ / templates
const FAQ = LIVIA?.faq_cod_entregas || {};
const CHECKOUT_CTA_TEMPLATE = FAQ?.rules?.checkout_cta_template || 'Aqui está seu link de checkout seguro 👉 {{checkout_url}}';

// --- Sinônimos (detectar "progressiva" como produto) ---
const PRODUCT_SYNONYMS = Array.isArray(PRODUCT?.synonyms) && PRODUCT.synonyms.length
  ? PRODUCT.synonyms
  : ['progressiva vegetal', 'progressiva', 'escova progressiva', 'alisamento', 'alisante', 'botox capilar vegetal'];

function isProductQuery(txt = '') {
  const s = (txt || '').toLowerCase();
  return PRODUCT_SYNONYMS.some(w => s.includes(w));
}

// --- Redis (histórico por JID) ---
const REDIS_URL = (process.env.REDIS_URL || '').trim();
const HISTORY_TTL = Math.max(0, parseInt(process.env.HISTORY_TTL_SECONDS || '604800', 10)); // 7 dias

let _redisClient = null;
async function getRedis() {
  if (!REDIS_URL) { console.warn('[REDIS] REDIS_URL não configurada — histórico desativado.'); return null; }
  if (_redisClient) return _redisClient;
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => console.error('[REDIS] error:', err?.message || err));
  await client.connect();
  console.log('[REDIS] conectado.');
  _redisClient = client;
  return _redisClient;
}

const HIST_LIMIT = 24;
const histKey = (jid) => `hist:${jid}`;
async function loadHistory(jid) {
  try { const cli = await getRedis(); if (!cli) return []; const raw = await cli.get(histKey(jid)); return raw ? (JSON.parse(raw) || []) : []; }
  catch { return []; }
}
async function saveHistory(jid, msgs) {
  try {
    const cli = await getRedis(); if (!cli) return;
    const data = JSON.stringify((msgs || []).slice(-HIST_LIMIT));
    if (HISTORY_TTL > 0) await cli.set(histKey(jid), data, { EX: HISTORY_TTL }); else await cli.set(histKey(jid), data);
  } catch {}
}

// --- Delay + “digitando...” ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sendTypingMessage(sock, jid, message) {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
    const delay = Math.min(3500, Math.max(500, (message || '').length * 25));
    await sleep(delay);
    await sock.sendMessage(jid, { text: message });
  } catch (e) {
    try { await sock.sendMessage(jid, { text: message }); } catch {}
  } finally {
    try { await sock.sendPresenceUpdate('paused', jid); } catch {}
  }
}

// --- Checkout helpers ---
function formatCheckoutCTA(url) { return (CHECKOUT_CTA_TEMPLATE || 'Link: {{checkout_url}}').replace('{{checkout_url}}', url || ''); }
function sendCheckoutIfReady(sock, jid, url = PRICING_DEFAULT_URL) { if (!url) return null; return sendTypingMessage(sock, jid, formatCheckoutCTA(url)); }

// --- Intenções de compra + escolha de tier ---
function isBuyIntent(txt = '') {
  const s = (txt || '').toLowerCase();

  // palavras e expressões que indicam intenção de fechar compra / pedir link
  const kws = [
    'comprar', 'quero', 'quero comprar', 'adquirir',
    'finalizar', 'fechar', 'fechar pedido', 'fechar compra',
    'checkout', 'link', 'manda o link', 'me manda o link',
    'manda', 'envia', 'me envia', 'pode enviar', 'pode mandar',
    'ok manda', 'ok pode enviar',
    'pix', 'pago', 'pagamento'
  ];

  return kws.some(k => s.includes(k));
}
function normalize(str = '') { return String(str||'').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,''); }
function tierURLFromText(_txt = '') {
  // Preço único de R$ 150,00
  return PRICING_DEFAULT_URL || 'https://entrega.logzz.com.br/pay/memmpxgmg/progcreme150';
}


// --- Anti-repetição + fechamento inteligente ---
function isDeliveryQuery(t){ return /\b(entrega|prazo|frete|chega|demora)\b/i.test(t||''); }
function isBenefitsQuery(t){ return /\b(benef[ií]cios?|vantagens?|diferenciais?)\b/i.test(t||''); }
function isPriceQuery(t){ return /\b(pre[cç]o|valor|custa|quanto)\b/i.test(t||''); }
const GENERIC_CLOSERS = ['Como posso te ajudar mais?','Como posso ser útil hoje?','Como posso te ajudar hoje?'];
function smartClosingQuestion(userText){
  if (isDeliveryQuery(userText)) return 'Me passa seu CEP para eu calcular o prazo certinho?';
  if (isBenefitsQuery(userText)) return 'Quer que eu te mostre como aplicar passo a passo?';
  if (isPriceQuery(userText)) return 'Você pensa em 1, 2 ou 3 unidades?';
  if (isProductQuery(userText)) return 'Prefere um resultado liso intenso ou mais natural?';
  return 'Posso te ajudar em mais algum ponto?';
  }
// --- Fechamentos curtos e naturais ---
const SOFT_CLOSERS = [
  'Te mando o link?',
  'Quer o link agora?',
  'Te envio rapidinho?',
  'Posso te orientar no passo a passo?'
];

// Abridores leves (opcionais)
const SOFT_OPENERS = ['Opa!', 'Beleza 🙂', 'Show!', 'Claro!', 'Perfeito.'];

// util de pick (mantenha apenas UMA no arquivo)
function pick(a){ return a[Math.floor(Math.random() * a.length)] || ''; }

// helpers de pós-processamento
function stripRepeatedClosers(txt){
  let out = txt || '';
  for (const c of GENERIC_CLOSERS){
    const re = new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
    out = out.replace(re,'').trim();
  }
  return out;
}
function limitEmojis(txt){
  const all = (txt||'').match(/\p{Extended_Pictographic}/gu) || [];
  if (all.length <= 1) return txt;
  let kept = false;
  return (txt||'').replace(/\p{Extended_Pictographic}/gu, () => kept ? '' : (kept = true, ''));
}
function limitSentences(txt, max = 2){
  const parts = (txt||'').split(/(?<=\.)\s+/).filter(Boolean);
  return parts.slice(0, max).join(' ').trim() || txt;
}

function polishReply(reply, userText){
  let out = reply || '';

  // remove “posso te enviar o link...” quando não é CTA
  if (!isBuyIntent(userText)) {
    out = out.replace(/(?:posso te enviar o link[^.]*\.)/gi, '').trim();
  }

  out = stripRepeatedClosers(out);
  out = limitSentences(out, 2);
  out = limitEmojis(out);

  // abridor leve às vezes (se ainda não começou com oi/olá/boa/hey)
  if (Math.random() < 0.35 && !/^(olá|oi|boa|hey)/i.test(out)) {
    out = `${pick(SOFT_OPENERS)} ${out}`.trim();
  }

  let closing = smartClosingQuestion(userText) || pick(SOFT_CLOSERS);
  if (closing && !/[?!]$/.test(out)) out = `${out} ${closing}`;
let closing = smartClosingQuestion(userText) || pick(SOFT_CLOSERS);
if (closing && !/[?!]$/.test(out)) out = `${out} ${closing}`;

return out;
}


  // Se não for CTA, remove “posso te enviar o link...” que o modelo às vezes adiciona
  if (!isBuyIntent(userText)) {
    out = out.replace(/(?:posso te enviar o link[^.]*\.)/gi, '').trim();
  }

  out = stripRepeatedClosers(out);
  out = limitSentences(out, 2);   // respostas mais curtas
  out = limitEmojis(out);

  // Abridor leve às vezes (se ainda não começou com oi/olá/boa/hey)
  if (Math.random() < 0.35 && !/^(olá|oi|boa|hey)/i.test(out)) {
    out = `${pick(SOFT_OPENERS)} ${out}`.trim();
  }

  let closing = smartClosingQuestion(userText) || pick(SOFT_CLOSERS);
  if (closing && !/[?!]$/.test(out)) out = `${out} ${closing}`;

  return out;
}


  

  // Se não for CTA, tira “posso te enviar o link...” que o modelo às vezes adiciona
  if (!isBuyIntent(userText)) {
    out = out.replace(/(?:posso te enviar o link[^.]*\.)/gi, '').trim();
  }

  out = stripRepeatedClosers(out);
  out = limitSentences(out, 2);    // respostas mais curtas (máx. 2 frases)
  out = limitEmojis(out);

  let closing = smartClosingQuestion(userText) || pick(SOFT_CLOSERS);
  if (closing && !/[?!]$/.test(out)) out = `${out} ${closing}`;

  return out;
}

// --- Prompt do sistema (persona + produto + regras) ---
function buildSystemPrompt() {
  const name = identityStrict.always_name || 'Lívia Martins';
  const forbidBot = identityStrict.never_reveal_bot !== false;
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
    PRICING_DEFAULT_URL ? `Quando houver intenção de compra, apresente o checkout usando este template: "${CHECKOUT_CTA_TEMPLATE}".` : ``,
    `Nunca escreva "{{checkout_url}}" nas respostas; o link real será enviado separadamente quando a cliente pedir.`,
    `Se a cliente perguntar "tem progressiva?" ou variações, interprete como o produto "${PRODUCT_NAME}" (não como serviço).`
  ].filter(Boolean).join(' ');
}

// --- Helpers WhatsApp ---
function extractText(m){
  return m?.message?.conversation ||
         m?.message?.extendedTextMessage?.text ||
         m?.message?.imageMessage?.caption ||
         m?.message?.videoMessage?.caption || '';
}

// --- Estado WPP ---
let sock; let qrCodeData = null; let wppReady = false;

// --- Baileys ---
async function startBaileys() {
  try {
const { state, saveCreds } = await useMultiFileAuthState('/app/baileys-auth');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false });

    sock.ev.on('connection.update', (update) => {
      const { qr, connection, lastDisconnect } = update;
      if (qr) { qrCodeData = qr; wppReady = false; console.log('[WPP] QRCode gerado'); }
      if (connection === 'open') { qrCodeData = null; wppReady = true; console.log('[WPP] Conectado com sucesso'); }
      if (connection === 'close') { console.log('[WPP] Conexão fechada, tentando reconectar...', lastDisconnect?.error?.message || ''); startBaileys(); }
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (msg) => {
      if (msg.type !== 'notify') return;
      for (const message of msg.messages) {
        if (!message.message || message.key.fromMe) continue;
        const from = message.key.remoteJid;
        const text = extractText(message).trim();
        if (!text) continue;
        console.log(`[MSG] ${from}: ${text}`);

        const history = await loadHistory(from);
       // (mantém isto) const history = await loadHistory(from);

// APAGUE estas duas linhas antigas:
// const system = buildSystemPrompt();
// const messages = [ ... ]

// Deixe os hints como já estão
const hints = [];
if (isProductQuery(text)) {
  hints.push(`ATENÇÃO: cliente perguntou sobre "${PRODUCT_NAME}" (progressiva sem formol).`);
}

// P2 — prompt base + sugestões de blocos
const sys = buildSystemPromptBase('');      // memSummary vazio (P3 entra depois)
const suggest = blockSuggestions(text);

// messages final (mantém hints e history)
const messages = [
  { role: 'system', content: suggest ? `${sys}\n\n${suggest}` : sys },
  ...hints.map(h => ({ role: 'system', content: h })),
  ...history,
  { role: 'user', content: text }
];


        try {
          // Defina antes no topo, perto do OpenAI:
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
console.log('[GPT] Model em uso:', MODEL);


const completion = await openai.chat.completions.create({
  model: MODEL,
  messages,
  temperature: 0.8,      // + solta, porém ainda controlada
  top_p: 0.9,
  frequency_penalty: 0.3, // evita repetir frases
  presence_penalty: 0.2   // incentiva variar um pouco
});



          const reply = (completion.choices?.[0]?.message?.content || '').trim() || 'Certo! Como posso te ajudar?';
          let polished = polishReply(reply, text);
if (isPriceQuery(text)) {
  polished = 'Hoje estamos com preço promocional: de R$ 197,00 por R$ 150,00. O estoque está acabando, Quer o link para aproveitar a oferta?';
}

          await sendTypingMessage(sock, from, polished);

          try {
            if ((isBuyIntent(text) || isPriceQuery(text)) && !replyHasURL(polished)) {
              const tierUrl = tierURLFromText(text) || PRICING_DEFAULT_URL;
              if (tierUrl) await sendCheckoutIfReady(sock, from, tierUrl);
            }
          } catch (e) { console.warn('[CTA] falhou ao enviar checkout:', e?.message || e); }

          const newHist = [...history, { role: 'user', content: text }, { role: 'assistant', content: polished }];
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
startBaileys();



// --- Express ---
const app = express();

app.get('/health', (_, res) => res.json({ ok: true, wppReady, qrAvailable: !!qrCodeData }));

// Versão do build e modelo (mantenha UMA vez só)
const BUILD_TAG = process.env.BUILD_TAG || new Date().toISOString();
app.get('/version', (_req, res) => {
  res.json({ ok: true, build: BUILD_TAG, model: MODEL });
});

app.get('/livia-info', (_req, res) => {
  const loaded = !!LIVIA && Object.keys(LIVIA || {}).length > 0;
  res.json({ loaded, path: LIVIA_CONFIG_PATH, name: LIVIA?.name || null, version: LIVIA?.version || null });
});

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

app.get('/qr', async (_req, res) => {
  if (!qrCodeData) return res.status(400).json({ error: 'QR não disponível' });
  res.setHeader('Content-Type', 'image/png');
  res.send(await qrcode.toBuffer(qrCodeData));
});

app.get('/qr-page', async (_req, res) => {
  if (!qrCodeData) return res.send('<h1>✅ WhatsApp conectado!</h1>');
  const qrPng = await qrcode.toDataURL(qrCodeData);
  res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;"><h2>Escaneie o QR Code abaixo</h2><img src="${qrPng}" width="300" height="300"/></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
