// --- Carrega variáveis do .env ---
require('dotenv').config();

// --- OpenAI (GPT) ---
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- HTTP / Healthcheck ---
const express = require('express');
const app = express();
app.get('/health', (_, res) => res.send('ok'));

// --- WhatsApp (WPPConnect) ---
const { create } = require('@wppconnect-team/wppconnect');

// Flags importantes p/ rodar em servidor (Railway/Render/VPS)
const browserArgs = ['--no-sandbox', '--disable-setuid-sandbox'];

// Configs vindas do .env (com padrões seguros)
const WPP_SESSION = process.env.WPP_SESSION || 'default';
const WPP_HEADLESS = (process.env.WPP_HEADLESS || 'true') === 'true';
const PORT = process.env.PORT || 3000;

// Inicia o cliente do WhatsApp
create({
  session: WPP_SESSION,
  headless: WPP_HEADLESS,
  browserArgs,
  // salva sessão em disco (opcional: mudar caminho via .env)
  puppeteerOptions: {
    args: browserArgs,
  },
  // Loga o QR em base64 como Data URL (copiar dos logs e abrir no navegador)
  catchQR: (base64Qr /*, asciiQR, attempts, urlCode */) => {
    console.log('===================== QR CODE =====================');
    console.log('Abra esta URL no navegador e escaneie no celular:');
    console.log('data:image/png;base64,' + base64Qr);
    console.log('===================================================');
  },
})
  .then((client) => {
    console.log('✅ Bot do WhatsApp iniciado! Sessão:', WPP_SESSION);

    // --- ÚNICO handler de mensagens ---
    client.onMessage(async (message) => {
      try {
        // Ignora grupos e mensagens vazias
        if (message.isGroupMsg) return;
        const userText = (message.body || '').trim();
        if (!userText) return;

        console.log('📩 Mensagem recebida:', userText);

        // Chama GPT (modelo leve e barato)
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.5,
          max_tokens: 300,
          messages: [
            {
              role: 'system',
              content:
                'Você é um assistente de vendas da TopOfertas no WhatsApp. ' +
                'Responda de forma curta, clara e amigável, no idioma do cliente. ' +
                'Se perguntarem sobre entrega/prazo, peça o CEP. ' +
                'Quando fizer sentido, ofereça enviar o link do checkout.',
            },
            { role: 'user', content: userText },
          ],
        });

        const reply =
          completion.choices?.[0]?.message?.content?.trim() ||
          'Consegui te entender, mas pode detalhar um pouco mais?';

        await client.sendText(message.from, reply);
      } catch (error) {
        console.error('❌ Erro ao falar com GPT:', error?.message || error);
        try {
          await client.sendText(
            message.from,
            '⚠️ Tive um probleminha técnico agora. Pode tentar de novo?'
          );
        } catch (_) {}
      }
    });

    // (opcional) log quando a sessão muda de status
    client.onStateChange((state) => {
      console.log('ℹ️ Estado da sessão:', state);
    });
  })
  .catch((error) => {
    console.error('❌ Erro ao iniciar WPPConnect:', error?.message || error);
    process.exitCode = 1;
  });

// --- Sobe servidor HTTP (healthcheck) ---
app.listen(PORT, () => {
  console.log(`🟢 Servidor HTTP rodando na porta ${PORT}`);
});

