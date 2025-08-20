// --- Carrega variáveis do .env ---
import "dotenv/config";

// --- OpenAI (GPT) ---
import OpenAI from "openai";

// ==== FALLBACK PARA OPENAI_API_KEY ====
const CANDIDATE_KEYS = [
  "OPENAI_API_KEY",   // nome correto
  "OPENAI_API_KEI",   // typo que vimos
  "OPENAI_APIKEY",    // variação comum
  "OPEN_AI_API_KEY",
];

let API_KEY = "";
for (const k of CANDIDATE_KEYS) {
  if (process.env[k] && process.env[k].startsWith("sk-")) {
    API_KEY = process.env[k];
    console.log("Usando variável:", k);
    break;
  }
}
console.log("OPENAI key carregada?", API_KEY.startsWith("sk-"));
// ==== FIM FALLBACK ====

// Criação do cliente OpenAI
const openai = new OpenAI({
  apiKey: API_KEY,
});

// --- HTTP / Healthcheck ---
import express from "express";
const app = express();
app.get("/", (req, res) => res.send("Bot rodando com sucesso 🚀"));
app.listen(3000, () => console.log("Servidor ativo na porta 3000"));
