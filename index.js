// --- ENV ---
import "dotenv/config";

// --- Libs ---
import OpenAI from "openai";
import express from "express";

// --- API key (com fallback e normalização) ---
const pickEnv = (names) => {
  for (const k of names) {
    let v = process.env[k];
    if (typeof v !== "string") continue;
    v = v.trim().replace(/^['"]|['"]$/g, "");
    if (v) return v;
  }
  return "";
};
const API_KEY = pickEnv([
  "OPENAI_API_KEY",   // correto
  "OPENAI_API_KEI",   // typo que já vimos
  "OPENAI_APIKEY",
  "OPEN_AI_API_KEY",
]);

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: API_KEY });

// --- HTTP / Healthcheck ---
const app = express();
app.get("/", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));


// rota de saúde
app.get('/health', (_, res) => res.json({ ok: true }));

// teste do GPT
app.get('/gpt-test', async (_, res) => {
  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Diga apenas: OK' }],
      temperature: 0
    });
    res.json({ reply: r.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
