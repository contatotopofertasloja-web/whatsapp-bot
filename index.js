// --- Carrega variáveis do .env ---
import "dotenv/config";

// --- OpenAI (GPT) ---
import OpenAI from "openai";

// ==== FALLBACK PARA OPENAI_API_KEY (com trim) ====
const CANDIDATE_KEYS = [
  "OPENAI_API_KEY",   // nome correto
  "OPENAI_API_KEI",   // typo que vimos
  "OPENAI_APIKEY",
  "OPEN_AI_API_KEY",
];

let API_KEY = "";
let USED_NAME = "";
for (const k of CANDIDATE_KEYS) {
  const raw = process.env[k];
  const val = typeof raw === "string" ? raw.trim() : "";
  if (val) {
    API_KEY = val;
    USED_NAME = k;
    break;
  }
}
console.log("Usando variável:", USED_NAME || "nenhuma");
console.log("OPENAI key carregada?", API_KEY.startsWith("sk-"), "prefix:", API_KEY ? API_KEY.slice(0,7) : "n/d");
// ==== FIM FALLBACK ====

console.log("HELLO env =", process.env.HELLO || "n/d");

// Criação do cliente OpenAI
const openai = new OpenAI({
  apiKey: API_KEY,
});

// --- HTTP / Healthcheck ---
import express from "express";
const app = express();
app.get("/", (req, res) => res.send("Bot rodando com sucesso 🚀"));
app.listen(3000, () => console.log("Servidor ativo na porta 3000"));


// Teste rápido do GPT no startup (só loga; não derruba o servidor)
setTimeout(async () => {
  try {
    const r = await openai.responses.create({
      model: "gpt-4o-mini",
      input: "Responda apenas: ok",
      temperature: 0,
    });

    let out = r.output_text || r.choices?.[0]?.message?.content || "";
    console.log("GPT ok:", out || "(vazio)");
  } catch (err) {
    console.error("GPT erro:", err?.status || "", err?.message || "", err?.response?.data || "");
  }
}, 500);
