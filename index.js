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
