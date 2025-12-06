// packages/brief-api/src/server.ts
//
// Startet Express und hängt nur die Router ein.

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { chatInterviewRouter } from './server/routes/chat_interview';
import { createChatFlowiseRouter } from './server/routes/chat_flowise';
import { domainsRouter } from './server/routes/domains';
import { briefsRouter } from './server/routes/briefs';
import { sheetsRouter } from './server/routes/sheets';
import { createUploadsRouter } from './server/routes/uploads';

// Pfade bestimmen
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// .env im Repo-Root laden
dotenv.config({ path: path.join(ROOT, '.env') });

const API_PORT = Number(process.env.PORT ?? process.env.BRIEF_API_PORT ?? 4000);

// Flowise-Target
const FLOWISE_TARGET = process.env.FLOWISE_TARGET ?? 'http://127.0.0.1:4000';
console.log('FLOWISE_TARGET =', FLOWISE_TARGET);

// Chatflow-ID
const FLOWISE_CHATFLOW_ID = process.env.FLOWISE_CHATFLOW_ID;
if (!FLOWISE_CHATFLOW_ID) {
  console.warn(
    'WARNUNG: FLOWISE_CHATFLOW_ID ist nicht gesetzt – /api/flowise/chat wird nicht funktionieren.',
  );
}

// Fallback-Domäne für Uploads
const FALLBACK_DOMAIN_ID =
  process.env.FALLBACK_DOMAIN_ID ?? '00000000-0000-0000-0000-000000000000';
console.info('FALLBACK_DOMAIN_ID ist (' + FALLBACK_DOMAIN_ID + ').');

// ----------------------------------------
// Express-App
// ----------------------------------------

const app = express();

// CORS + JSON
app.use(
  cors({
    origin: true,
  }),
);
app.use(express.json({ limit: '3mb' }));

// Request-Logger
app.use((req, _res, next) => {
  console.log('REQ', req.method, req.url);
  next();
});

// Healthcheck
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'brief-api' });
});

// Router einhängen
app.use(chatInterviewRouter);
app.use(
  createChatFlowiseRouter({
    flowiseTarget: FLOWISE_TARGET,
    chatflowId: FLOWISE_CHATFLOW_ID,
  }),
);
app.use(domainsRouter);
app.use(briefsRouter);
app.use(sheetsRouter);
app.use(chatInterviewRouter);
app.use(
  createUploadsRouter({
    fallbackDomainId: FALLBACK_DOMAIN_ID,
  }),
);

// Server starten
app.listen(API_PORT, () => {
  console.log(
    `Check: Brief-API läuft auf Port ${API_PORT} (FLOWISE_TARGET=${FLOWISE_TARGET})`,
  );
});