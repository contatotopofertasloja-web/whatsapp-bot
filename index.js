// --- ENV ---
import 'dotenv/config';

// --- Libs ---
import express from 'express';
import OpenAI from 'openai';
import wppconnect from '@wppconnect-team/wppconnect';

// --- API key (com fallback e normalização) ---
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

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: API_KEY });

// --- HTTP / Healthcheck ---
const app = express();
app.get('/', (_, res) => res.send('ok'));
app.get('/health', (_, res)_
