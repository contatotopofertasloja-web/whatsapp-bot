// --- ENV ---
import 'dotenv/config';

// --- Libs ---
import express from 'express';
import qrcode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import OpenAI from 'openai';

// --- OpenAI ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
      printQRInTerminal: false, // desativa o QR no terminal
    });

    // Evento para QR Code
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
        console.log('[WPP] Conexão fechada, tentando reconectar...');
        startBaileys();
      }
    });

    // Salva credenciais
    sock.ev.on('creds.update', saveCreds);

    // Recebe mensagens
    sock.ev.on('messages.upsert', async (msg) => {
      if (msg.type !== 'notify') return;
      for (const message of msg.messages) {
        if (!message.message || message.key.fromMe) continue;

        const from = message.key.remoteJid;
        const text =
          message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          '';

        if (!text) continue;

        console.log(`[MSG] ${from}: ${text}`);

        // Integração com GPT
        try {
          const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: 'Você é um assistente útil.' },
              { role: 'user', content: text },
            ],
          });

          const reply = completion.choices[0].message.content.trim();
          await sock.sendMessage(from, { text: reply });
        } catch (err) {
          console.error('[GPT] Erro:', err.message);
          await sock.sendMessage(from, {
            text: '⚠️ Desculpe, ocorreu um erro ao processar sua mensagem.',
          });
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
app.get('/health', (_, res) =>
  res.json({ ok: true, wppReady, qrAvailable: !!qrCodeData })
);

// QR em PNG
app.get('/qr', async (_, res) => {
  if (!qrCodeData) {
    return res.status(400).json({ error: 'QR não disponível' });
  }
  res.setHeader('Content-Type', 'image/png');
  res.send(await qrcode.toBuffer(qrCodeData));
});

// QR em página HTML
app.get('/qr-page', async (_, res) => {
  if (!qrCodeData) {
    return res.send('<h1>✅ WhatsApp conectado!</h1>');
  }
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
app.listen(PORT, () =>
  console.log(`🚀 Servidor rodando na porta ${PORT}`)
);
