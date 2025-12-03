import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'url';
import multer from 'multer';

// Pfade bestimmen
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..'); // Projektdach

// .env im Repo-Root laden (hier liegen SUPABASE_URL, FLOWISE_TARGET etc.)
dotenv.config({ path: path.join(ROOT, '.env') });

// ----------------------------------------
// Flowise-Target (interner Port 4000)
// ----------------------------------------

const FLOWISE_TARGET = process.env.FLOWISE_TARGET ?? 'http://127.0.0.1:4000';
console.log('FLOWISE_TARGET =', FLOWISE_TARGET);

// Chatflow-ID für Flowise-Chat (ENV setzen!)
const FLOWISE_CHATFLOW_ID = process.env.FLOWISE_CHATFLOW_ID;
if (!FLOWISE_CHATFLOW_ID) {
  console.warn(
    'WARNUNG: FLOWISE_CHATFLOW_ID ist nicht gesetzt – /api/flowise/chat wird nicht funktionieren.',
  );
}

// ----------------------------------------
// Eigene Imports
// ----------------------------------------
import { startInterviewsForUser } from '../../brief-parser/src/start_interview_user';
import { loadInterviewContext } from '../../brief-parser/src/interview_context';
import { loadLeanInterviewContext } from '../../brief-parser/src/interview_context';
import { saveAnswer } from '../../brief-parser/src/save_answer';
import { evaluateInterview } from '../../brief-parser/src/evaluate_interview';
import { evaluateBriefSheet } from '../../brief-parser/src/evaluate_brief_sheet';
import { supabase } from './supabase_client';
import { classifyAndExtractUpload } from './llm_upload_parser';
import test from 'node:test';

// ----------------------------------------
// Basis-Setup Express
// ----------------------------------------
const app = express();

const API_PORT = Number(process.env.PORT ?? process.env.BRIEF_API_PORT ?? 4000);

const FALLBACK_DOMAIN_ID =
  process.env.FALLBACK_DOMAIN_ID ?? '00000000-0000-0000-0000-000000000000';
console.info('FALLBACK_DOMAIN_ID ist (' + FALLBACK_DOMAIN_ID + ').');

// Middleware – CORS global erlauben + JSON Body Parser
app.use(
  cors({
    origin: true, // spiegelt den Origin zurück, egal welcher
  }),
);
app.use(express.json({ limit: '3mb' }));


// ---- Flowise Chat ----
// Proxy-Endpoint für das Frontend: POST /api/flowise/chat
app.post('/api/flowise/chat', async (req, res) => {
  try {
    const { message, text, history, user, userId, username } = req.body ?? {};

    const questionRaw =
      (typeof message === 'string' && message.trim().length > 0 && message) ||
      (typeof text === 'string' && text.trim().length > 0 && text) ||
      null;

    if (!questionRaw) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Feld "message" (oder "text") im Body ist Pflicht.',
      });
    }

    if (!FLOWISE_CHATFLOW_ID) {
      return res.status(500).json({
        error: 'config_error',
        message: 'FLOWISE_CHATFLOW_ID ist nicht konfiguriert.',
      });
    }

    const question = questionRaw.trim();
    const userIdentifier = user ?? userId ?? username ?? null;

    // ------------------------------
    // 1) User + Interview Check
    // ------------------------------
    if (!userIdentifier || typeof userIdentifier !== 'string') {
      return res.json({
        answer:
          'Es konnte kein gültiger Benutzername ermittelt werden. ' +
          'Bitte tragen Sie oben einen gültigen Benutzernamen ein oder starten Sie den Chat direkt aus LearnWorlds.',
        raw: '',
      });
    }

    console.log('[FLOWISE_CHAT] userIdentifier =', userIdentifier);

    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('id, username')
      .eq('username', userIdentifier)
      .maybeSingle();

    if (userErr) {
      console.error('[FLOWISE_CHAT] Fehler beim User-Lookup:', userErr);
      return res.status(500).json({
        error: 'user_lookup_failed',
        message:
          'Fehler bei der Benutzerprüfung. Bitte versuchen Sie es später erneut.',
      });
    }

    if (!userRow) {
      return res.json({
        answer:
          `Für den Benutzernamen "${userIdentifier}" ist kein Zugang zum Interview verfügbar. ` +
          'Bitte prüfen Sie Ihre Kurszuordnung oder wenden Sie sich an die Kursbetreuung.',
        raw: '',
      });
    }

    const userDbId = userRow.id as string;
    console.log('[FLOWISE_CHAT] gefundener User id =', userDbId);

    // NEU: nur Interviews im Status "started", neueste zuerst
    const { data: interviewRow, error: intErr } = await supabase
      .from('interviews')
      .select('id, status, created_at')
      .eq('user_id', userDbId)
      .eq('status', 'started')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (intErr) {
      console.error(
        '[FLOWISE_CHAT] Fehler beim Interview-Lookup für User',
        userDbId,
        intErr,
      );
      return res.status(500).json({
        error: 'interview_lookup_failed',
        message:
          'Fehler bei der Interviewprüfung. Bitte versuchen Sie es später erneut.',
      });
    }

    if (!interviewRow) {
      // Es gibt Interviews, aber keins im Status "started" -> für den Chat als „kein Interview aktiv“
      return res.json({
        answer:
          'Für diesen Benutzer ist derzeit kein aktives Interview im Status "started" hinterlegt. ' +
          'Bitte starten Sie zunächst ein Interview im Editor oder wenden Sie sich an die Kursbetreuung.',
        raw: '',
      });
    }

    console.log(
      '[FLOWISE_CHAT] Interview gefunden:',
      interviewRow.id,
      'Status =',
      interviewRow.status,
    );

    const interviewId = interviewRow.id as string;

    // ------------------------------
    // 2) Flowise-Aufruf
    // ------------------------------
    const rawHistory = Array.isArray(history) ? history : [];
    const normalizedHistory = rawHistory
      .map((item: any, idx: number) => {
        if (!item || typeof item.content !== 'string') {
          console.warn(
            '[FLOWISE_CHAT] History-Item ohne content übersprungen',
            { idx, item },
          );
          return null;
        }

        const content = item.content;
        const role = item.role;

        if (role === 'user' || role === 'userMessage') {
          return { role: 'userMessage', content };
        }

        if (role === 'assistant' || role === 'apiMessage') {
          return { role: 'apiMessage', content };
        }

        console.warn(
          '[FLOWISE_CHAT] History-Item mit unbekannter Rolle übersprungen',
          { idx, role },
        );
        return null;
      })
      .filter(
        (x): x is { role: 'userMessage' | 'apiMessage'; content: string } =>
          x !== null,
      );

    const flowiseUrl = `${FLOWISE_TARGET.replace(
      /\/$/,
      '',
    )}/api/v1/prediction/${FLOWISE_CHATFLOW_ID}`;

    console.log('[FLOWISE_CHAT] Request →', flowiseUrl, {
      user: userIdentifier,
      question,
      historyLen: normalizedHistory.length,
      interviewId,
    });

    const fwRes = await fetch(flowiseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history: normalizedHistory,
        overrideConfig: {
          user: userIdentifier,
          // Hier wird die Interview-ID nach Flowise durchgereicht.
          // In Flowise kannst Du sie als {{$vars.INTERVIEW_ID}} verwenden,
          // z. B. für einen HTTP-Header x-interview-id.
          vars: {
            INTERVIEW_ID: interviewId, 
          },
        },
      }),
    });

    const textBody = await fwRes.text();

    if (!fwRes.ok) {
      console.error('Flowise-Fehler:', fwRes.status, textBody);
      return res.status(502).json({
        error: 'flowise_error',
        message: `Flowise antwortete mit Status ${fwRes.status}`,
        details: textBody,
      });
    }

    console.log(
      '[FLOWISE_CHAT] Flowise OK, raw length =',
      textBody.length,
      'preview =',
      textBody.slice(0, 200),
    );

    // ------------------------------
    // 3) Bereinigung / Entschachtelung
    // ------------------------------
    let cleanedAnswer = textBody;
    let meta: any = null;

    try {
      let outer: any = JSON.parse(textBody);

      if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
        const inner = outer as any;
        meta = inner;

        const parts: string[] = [];

        // kleine Hilfsfunktion, damit wir nie exakt die User-Frage spiegeln
        const pick = (val?: unknown): string | null => {
          if (typeof val !== 'string') return null;
          const t = val.trim();
          if (!t) return null;
          if (t === question.trim()) return null; // kein bloßes Echo
          return t;
        };

        // 1) Direktfelder auf oberster Ebene
        const directAnswer =
          pick(inner.answer) ??
          pick(inner.text) ??
          pick(inner.message) ??
          pick(inner.output) ??
          pick(inner.question) ??
          pick(inner.llm_question);

        if (directAnswer) {
          parts.push(directAnswer);
        }

        // 2) HTTP-Agent-Fall: data.responseBody auswerten
        if (parts.length === 0 && inner.data && inner.data.responseBody) {
          let rb: any = inner.data.responseBody;

          if (typeof rb === 'string') {
            const trimmed = rb.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              try {
                rb = JSON.parse(trimmed);
              } catch {
                // bleibt String
              }
            }
          }

          if (rb && typeof rb === 'object' && !Array.isArray(rb)) {
            const rbi = rb as any;

            const innerAnswer =
              pick(rbi.answer) ??
              pick(rbi.llm_question) ??
              pick(rbi.question) ??
              pick(rbi.text) ??
              pick(rbi.message) ??
              pick(rbi.output);

            if (innerAnswer) {
              parts.push(innerAnswer);
            }
          }

          // falls responseBody nur ein String ist (nicht json), aber sinnvoll:
          if (parts.length === 0 && typeof rb === 'string') {
            const v = pick(rb);
            if (v) parts.push(v);
          }
        }

        // 3) letzter Fallback: inner.text, falls noch nichts da und nicht identisch zur Frage
        if (parts.length === 0) {
          const v = pick(inner.text);
          if (v) parts.push(v);
        }

        if (parts.length > 0) {
          cleanedAnswer = parts.join('\n\n');
        }
      }
    } catch (err) {
      console.warn(
        '[FLOWISE_CHAT] Konnte Antwort nicht parsen, nutze raw.',
        err,
      );
    }

    return res.json({
      answer: cleanedAnswer,
      raw: textBody,
      meta,
    });
  } catch (e: any) {
    console.error('Unerwarteter Fehler in POST /api/flowise/chat:', e);
    return res.status(500).json({
      error: 'internal',
      message: e?.message ?? 'Unbekannter Fehler',
    });
  }
});


// Upload-Konfiguration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});


// Request-Logger (nur zu Debugzwecken)
app.use((req, _res, next) => {
  console.log('REQ', req.method, req.url);
  next();
});

// ----------------------------------------
// Eigene API-Routen (alles unter /api/…)
// ----------------------------------------

// Healthcheck nur für Deine API
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'brief-api' });
});

//
// ---- DOMAINS ---------------------------------------------------------
//

// Domänen-Liste
app.get('/api/domains', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('domains')
      .select('id, name, description, created_at, updated_at')
      .order('name', { ascending: true });

    if (error) {
      console.error('Fehler in GET /api/domains:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data ?? []);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in GET /api/domains:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Einzelne Domäne
app.get('/api/domains/:domainId', async (req, res) => {
  const { domainId } = req.params;

  try {
    const { data, error } = await supabase
      .from('domains')
      .select('id, name, description, created_at, updated_at')
      .eq('id', domainId)
      .maybeSingle();

    if (error) {
      console.error('Fehler in GET /api/domains/:domainId:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Domäne nicht gefunden' });
    }

    res.json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in GET /api/domains/:domainId:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Domäne anlegen
app.post('/api/domains', async (req, res) => {
  const { name, description } = req.body ?? {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Feld "name" (string) ist Pflicht.',
    });
  }

  try {
    const { data, error } = await supabase
      .from('domains')
      .insert({
        name: name.trim(),
        description:
          typeof description === 'string' ? description.trim() : null,
      })
      .select('id, name, description, created_at, updated_at')
      .single();

    if (error || !data) {
      console.error('Fehler in POST /api/domains:', error);
      return res.status(500).json({
        error: 'insert_failed',
        message: error?.message ?? 'Fehler beim Anlegen der Domäne',
      });
    }

    res.status(201).json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in POST /api/domains:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Domäne ändern (nur Name/Beschreibung)
app.patch('/api/domains/:domainId', async (req, res) => {
  const { domainId } = req.params;
  const { name, description } = req.body ?? {};

  try {
    const updates: any = {};

    if (typeof name === 'string') {
      if (name.trim().length === 0) {
        return res.status(400).json({
          error: 'bad_request',
          message: 'Feld "name" darf nicht leer sein.',
        });
      }
      updates.name = name.trim();
    }

    if (typeof description === 'string') {
      updates.description = description.trim();
    } else if (description === null) {
      updates.description = null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Keine gültigen Felder zum Aktualisieren übergeben.',
      });
    }

    const { data, error } = await supabase
      .from('domains')
      .update(updates)
      .eq('id', domainId)
      .select('id, name, description, created_at, updated_at')
      .maybeSingle();

    if (error) {
      console.error('Fehler in PATCH /api/domains/:domainId:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Domäne nicht gefunden' });
    }

    res.json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in PATCH /api/domains/:domainId:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Domäne löschen (verhindert durch FK, wenn noch in Benutzung)
app.delete('/api/domains/:domainId', async (req, res) => {
  const { domainId } = req.params;

  try {
    const { error } = await supabase
      .from('domains')
      .delete()
      .eq('id', domainId);

    if (error) {
      // Foreign-Key-Verletzung -> Domäne wird noch verwendet
      if ((error as any).code === '23503') {
        console.error(
          'Domäne wird noch referenziert, DELETE /api/domains/:domainId:',
          error,
        );
        return res.status(409).json({
          error: 'domain_in_use',
          message:
            'Domäne kann nicht gelöscht werden, da sie noch von Steckbriefen verwendet wird.',
        });
      }

      console.error('Fehler in DELETE /api/domains/:domainId:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(204).send();
  } catch (e: any) {
    console.error('Unerwarteter Fehler in DELETE /api/domains/:domainId:', e);
    return res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

//
// ---- BRIEFS ----------------------------------------------------------
//

// Briefs: Liste
app.get('/api/briefs', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('briefs')
      .select('id, title, domain_id, status, version, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fehler in GET /api/briefs:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data ?? []);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in GET /api/briefs:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Brief patchen (Titel, Status, Domäne, Markdown – aber NICHT Version)
app.patch('/api/briefs/:briefId', async (req, res) => {
  const { briefId } = req.params;
  const { title, status, raw_markdown, domain_id } = req.body ?? {};

  try {
    const updates: any = {};

    if (typeof title === 'string') updates.title = title;
    if (typeof status === 'string') updates.status = status;
    if (typeof raw_markdown === 'string') updates.raw_markdown = raw_markdown;
    if (typeof domain_id === 'string') updates.domain_id = domain_id;

    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ error: 'Keine gültigen Felder zum Aktualisieren übergeben.' });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('briefs')
      .update(updates)
      .eq('id', briefId)
      .select(
        'id, title, domain_id, status, version, raw_markdown, created_at, updated_at',
      )
      .single();

    if (error) {
      console.error('Fehler in PATCH /api/briefs/:briefId:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Brief nicht gefunden' });
    }

    res.json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in PATCH /api/briefs/:briefId:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Brief aktualisieren (vollständig – inkl. Version, wenn Du es brauchst)
app.put('/api/briefs/:briefId', async (req, res) => {
  const { briefId } = req.params;
  const payload = req.body ?? {};

  delete (payload as any).id; // Primärschlüssel nicht überschreiben

  try {
    const { data, error } = await supabase
      .from('briefs')
      .update(payload)
      .eq('id', briefId)
      .select(
        'id, title, domain_id, status, version, raw_markdown, created_at, updated_at',
      )
      .maybeSingle();

    if (error) {
      console.error('Fehler in PUT /api/briefs/:briefId:', error);
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'Brief nicht gefunden' });
    }

    res.json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in PUT /api/briefs/:briefId:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Brief-Detail
app.get('/api/briefs/:briefId', async (req, res) => {
  const { briefId } = req.params;

  try {
    const { data, error } = await supabase
      .from('briefs')
      .select(
        'id, title, domain_id, status, version, raw_markdown, created_at, updated_at',
      )
      .eq('id', briefId)
      .maybeSingle();

    if (error) {
      console.error('Fehler in GET /api/briefs/:briefId:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Brief nicht gefunden' });
    }

    res.json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in GET /api/briefs/:briefId:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Brief -> aktive Sheets
app.get('/api/briefs/:briefId/sheets', async (req, res) => {
  const { briefId } = req.params;

  try {
    const { data: brief, error: briefErr } = await supabase
      .from('briefs')
      .select('id')
      .eq('id', briefId)
      .maybeSingle();

    if (briefErr) {
      console.error(
        'Fehler beim Laden des Briefs in /briefs/:briefId/sheets:',
        briefErr,
      );
      return res.status(500).json({ error: briefErr.message });
    }
    if (!brief) {
      return res.status(404).json({ error: 'Brief nicht gefunden' });
    }

    const { data: sheets, error: sheetsErr } = await supabase
      .from('overleitung_sheets')
      .select('id, name, theme, status, version, created_at')
      .eq('status', 'active')
      .order('theme', { ascending: true })
      .order('version', { ascending: false });

    if (sheetsErr) {
      console.error(
        'Fehler beim Laden der Sheets in /briefs/:briefId/sheets:',
        sheetsErr,
      );
      return res.status(500).json({ error: sheetsErr.message });
    }

    res.json({
      brief_id: briefId,
      sheets: sheets ?? [],
    });
  } catch (e: any) {
    console.error('Unerwarteter Fehler in GET /api/briefs/:briefId/sheets:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Brief löschen
app.delete('/api/briefs/:briefId', async (req, res) => {
  const { briefId } = req.params;

  try {
    const { error } = await supabase
      .from('briefs')
      .delete()
      .eq('id', briefId);

    if (error) {
      console.error('Fehler in DELETE /api/briefs/:briefId:', error);
      return res.status(500).json({ error: error.message });
    }

    // 204: erfolgreich, kein Body
    return res.status(204).send();
  } catch (e: any) {
    console.error('Unerwarteter Fehler in DELETE /api/briefs/:briefId:', e);
    return res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

//
// ---- SHEETS (Metadaten) ----------------------------------------------
//

// Sheets: Detail (ohne Fragen)
app.get('/api/sheets/:sheetId', async (req, res) => {
  const { sheetId } = req.params;

  try {
    const { data, error } = await supabase
      .from('overleitung_sheets')
      .select(
        'id, name, theme, status, version, created_at, theme_target_description',
      )
      .eq('id', sheetId)
      .maybeSingle();

    if (error) {
      console.error('Fehler in GET /api/sheets/:sheetId:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Sheet nicht gefunden' });
    }

    res.json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in GET /api/sheets/:sheetId:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

app.patch('/api/sheets/:sheetId', async (req, res) => {
  const { sheetId } = req.params;
  const { name, theme, status, version, theme_target_description } =
    req.body ?? {};

  try {
    const updates: any = {};

    if (typeof name === 'string') updates.name = name;
    if (typeof theme === 'string') updates.theme = theme;
    if (typeof status === 'string') updates.status = status;
    if (typeof version === 'number') updates.version = version;
    if (typeof theme_target_description === 'string') {
      updates.theme_target_description = theme_target_description;
    }

    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ error: 'Keine gültigen Felder zum Aktualisieren übergeben.' });
    }

    const { data, error } = await supabase
      .from('overleitung_sheets')
      .update(updates)
      .eq('id', sheetId)
      .select(
        'id, name, theme, status, version, created_at, theme_target_description',
      )
      .single();

    if (error) {
      console.error('Fehler in PATCH /api/sheets/:sheetId:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Sheet nicht gefunden' });
    }

    res.json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in PATCH /api/sheets/:sheetId:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Sheets: Liste aller Überleitungssheets
app.get('/api/sheets', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('overleitung_sheets')
      .select('id, name, theme, status, version, created_at')
      .order('theme', { ascending: true })
      .order('version', { ascending: false });

    if (error) {
      console.error('Fehler in GET /api/sheets:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data ?? []);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in GET /api/sheets:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Sheet aktualisieren (vollständig)
app.put('/api/sheets/:sheetId', async (req, res) => {
  const { sheetId } = req.params;
  const payload = req.body ?? {};

  delete (payload as any).id;

  try {
    const { data, error } = await supabase
      .from('overleitung_sheets')
      .update(payload)
      .eq('id', sheetId)
      .select(
        'id, name, theme, status, version, created_at, theme_target_description',
      )
      .maybeSingle();

    if (error) {
      console.error('Fehler in PUT /api/sheets/:sheetId:', error);
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'Sheet nicht gefunden' });
    }

    res.json(data);
  } catch (e: any) {
    console.error('Unerwarteter Fehler in PUT /api/sheets/:sheetId:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Sheet löschen
app.delete('/api/sheets/:sheetId', async (req, res) => {
  const { sheetId } = req.params;

  try {
    const { error } = await supabase
      .from('overleitung_sheets')
      .delete()
      .eq('id', sheetId);

    if (error) {
      console.error('Fehler in DELETE /api/sheets/:sheetId:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(204).send();
  } catch (e: any) {
    console.error('Unerwarteter Fehler in DELETE /api/sheets/:sheetId:', e);
    return res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

//
// ---- SHEET-QUESTIONS -------------------------------------------------
//

// Alle Fragen eines Sheets laden
app.get('/api/sheets/:sheetId/questions', async (req, res) => {
  const { sheetId } = req.params;

  try {
    const { data, error } = await supabase
      .from('sheet_questions')
      .select(
        'id, sheet_id, code, question, checkpoints, order_index, active, created_at',
      )
      .eq('sheet_id', sheetId)
      .order('order_index', { ascending: true });

    if (error) {
      console.error(
        'Fehler in GET /api/sheets/:sheetId/questions:',
        error,
      );
      return res.status(500).json({ error: error.message });
    }

    res.json(data ?? []);
  } catch (e: any) {
    console.error(
      'Unerwarteter Fehler in GET /api/sheets/:sheetId/questions:',
      e,
    );
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

// Fragen eines Sheets in einem Rutsch updaten (inkl. löschen/anlegen)
app.put('/api/sheets/:sheetId/questions', async (req, res) => {
  const { sheetId } = req.params;
  const { questions } = req.body ?? {};

  if (!Array.isArray(questions)) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Body muss ein Feld "questions" mit einem Array enthalten.',
    });
  }

  try {
    // 1) Vorhandene Fragen für dieses Sheet laden
    const { data: existing, error: existingErr } = await supabase
      .from('sheet_questions')
      .select('id')
      .eq('sheet_id', sheetId);

    if (existingErr) {
      console.error(
        'Fehler beim Laden existierender Fragen in PUT /api/sheets/:sheetId/questions:',
        existingErr,
      );
      return res.status(500).json({ error: existingErr.message });
    }

    const existingIds = new Set((existing ?? []).map((r: any) => r.id as string));

    type IncomingQuestion = {
      id?: string;
      code: string;
      question: string;
      checkpoints: string[];
      order_index?: number;
      active?: boolean;
    };

    const toUpsert: any[] = [];
    const seenIds = new Set<string>();

    let idx = 0;
    for (const q of questions as IncomingQuestion[]) {
      const id = q.id && String(q.id).length > 0 ? String(q.id) : undefined;

      if (id) {
        seenIds.add(id);
      }

      toUpsert.push({
        id,
        sheet_id: sheetId,
        code: q.code?.trim() ?? '',
        question: q.question?.trim() ?? '',
        checkpoints: Array.isArray(q.checkpoints) ? q.checkpoints : [],
        order_index:
          typeof q.order_index === 'number' ? q.order_index : idx,
        active: q.active ?? true,
      });

      idx++;
    }

    // 3) Nicht mehr vorhandene Fragen löschen
    const idsToDelete = [...existingIds].filter((id) => !seenIds.has(id));
    if (idsToDelete.length > 0) {
      const { error: delErr } = await supabase
        .from('sheet_questions')
        .delete()
        .in('id', idsToDelete);

      if (delErr) {
        console.error(
          'Fehler beim Löschen von Fragen in PUT /api/sheets/:sheetId/questions:',
          delErr,
        );
        return res.status(500).json({ error: delErr.message });
      }
    }

    // 4) Upsert aller (neuen + bestehenden) Fragen
    if (toUpsert.length > 0) {
      const { error: upErr } = await supabase
        .from('sheet_questions')
        .upsert(toUpsert, { onConflict: 'id' });

      if (upErr) {
        console.error(
          'Fehler beim Upsert in PUT /api/sheets/:sheetId/questions:',
          upErr,
        );
        return res.status(500).json({ error: upErr.message });
      }
    }

    // 5) Aktualisierte Liste zurückgeben
    const { data: finalList, error: finalErr } = await supabase
      .from('sheet_questions')
      .select(
        'id, sheet_id, code, question, checkpoints, order_index, active, created_at',
      )
      .eq('sheet_id', sheetId)
      .order('order_index', { ascending: true });

    if (finalErr) {
      console.error(
        'Fehler beim Reload in PUT /api/sheets/:sheetId/questions:',
        finalErr,
      );
      return res.status(500).json({ error: finalErr.message });
    }

    res.json(finalList ?? []);
  } catch (e: any) {
    console.error(
      'Unerwarteter Fehler in PUT /api/sheets/:sheetId/questions:',
      e,
    );
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

//
// ---- SCORECARD / EVALUATION -----------------------------------------
//

app.get(
  '/api/briefs/:briefId/sheets/:sheetId/scorecard-latest',
  async (req, res) => {
    const { briefId, sheetId } = req.params;
    try {
      const { data, error } = await supabase
        .from('brief_sheet_evaluations')
        .select('id, source, scorecard_json, created_at')
        .eq('brief_id', briefId)
        .eq('sheet_id', sheetId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error && (error as any).code !== 'PGRST116') {
        // "no rows" ist ok, sonst Fehler
        throw error;
      }

      if (!data) {
        return res
          .status(404)
          .json({ error: 'Keine Scorecard für diese Kombination gefunden.' });
      }

      res.json(data);
    } catch (e: any) {
      console.error('Fehler in GET /scorecard-latest:', e);
      res.status(500).json({ error: e.message ?? 'Unknown error' });
    }
  },
);

app.post(
  '/api/briefs/:briefId/sheets/:sheetId/evaluate',
  async (req, res) => {
    const { briefId, sheetId } = req.params;
    try {
      const scorecard = await evaluateBriefSheet(briefId, sheetId);
      res.json(scorecard);
    } catch (e: any) {
      console.error('Fehler in POST /evaluate:', e);
      res.status(500).json({ error: e.message ?? 'Unknown error' });
    }
  },
);

//
// ---- INTERVIEWS ------------------------------------------------------
//

app.post('/api/interviews/start-for-user', async (req, res) => {
  try {
    const { user_id, interview_type } = req.body ?? {};

    if (!user_id || typeof user_id !== 'string') {
      return res
        .status(400)
        .json({ error: 'user_id (string, uuid) wird benötigt.' });
    }

    const type =
      interview_type === 'practice' || interview_type === 'structure'
        ? interview_type
        : 'structure';

    const ids = await startInterviewsForUser(user_id, type);

    res.json({
      user_id,
      interview_type: type,
      interview_ids: ids,
    });
  } catch (e: any) {
    console.error('Fehler in /start-for-user:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

app.get(
  ['/api/interviews/:interviewId/context', '/api/interviews/context'],
  async (req, res) => {
    try {
      const interviewId =
        (req.header('x-interview-id') ?? '').trim() ||
        (req.params.interviewId ?? '').trim();

      if (!interviewId) {
        return res.status(400).json({
          error: 'bad_request',
          message:
            'Es wurde keine Interview-ID übermittelt (Header x-interview-id oder URL-Parameter).',
        });
      }

      const ctx = await loadLeanInterviewContext(interviewId);
      res.json(ctx);

    } catch (e: any) {
      console.error('Fehler in GET /api/interviews/.../context:', e);
      res.status(500).json({ error: e.message ?? 'Unknown error' });
    }
  },
);


app.post(
  ['/api/interviews/:interviewId/answers', '/api/interviews/answers'],
  async (req, res) => {
    console.log('Hello answers!');

    try {
      const interviewId =
        (req.header('x-interview-id') ?? '').trim() ||
        (req.params.interviewId ?? '').trim();

      const { answer_json } = req.body ?? {};

      if (!interviewId) {
        return res
          .status(400)
          .json({ error: 'bad_request', message: 'interviewId fehlt.' });
      }

      if (answer_json === undefined) {
        return res
          .status(400)
          .json({ error: 'bad_request', message: 'answer_json fehlt.' });
      }

      const saved = await saveAnswer({
        interviewId,
        answerJson: answer_json,
      });

      res.json(saved);
    } catch (e: any) {
      console.error('Fehler in POST /api/interviews/.../answers:', e);
      res.status(500).json({ error: e.message ?? 'Unknown error' });
    }
  },
);


app.post(
  ['/api/interviews/:id/evaluate', '/api/interviews/evaluate'],
  async (req, res) => {
    try {
      // 1) Interview-ID aus Header oder URL
      const interviewId =
        (req.header('x-interview-id') ?? '').trim() ||
        (req.params.id ?? '').trim();

      if (!interviewId) {
        return res.status(400).json({
          error: 'bad_request',
          message:
            'Keine Interview-ID übermittelt. Bitte übergeben Sie x-interview-id im Header oder :id in der URL.',
        });
      }

      // 2) Auswertung starten
      const result = await evaluateInterview(interviewId);

      // 3) Response
      return res.json({ data: result });
    } catch (err: any) {
      console.error(
        'Error evaluating interview for id/header:',
        err?.message ?? err
      );

      return res.status(500).json({
        error: 'evaluate_failed',
        message:
          err?.message ?? 'Fehler bei evaluateInterview – bitte später erneut versuchen.',
      });
    }
  }
);


//
// ---- UPLOAD / INGEST -------------------------------------------------
//

app.post('/api/ingest/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'file ist Pflicht (multipart/form-data mit Feld "file").',
      });
    }

    const filename = file.originalname;
    const mimetype = file.mimetype;
    const buffer = file.buffer;

    const parseResult = await classifyAndExtractUpload({
      filename,
      mimetype,
      buffer,
    });

    if (parseResult.kind === 'unknown') {
      return res.status(200).json(parseResult);
    }

    if (parseResult.kind === 'brief') {
      // Domäne bestimmen
      let domainId: string | null = null;
      const warnings = [...(parseResult.warnings ?? [])];

      if (parseResult.domain_hint && parseResult.domain_hint.trim().length > 0) {
        const hint = parseResult.domain_hint.trim();

        const { data: domainRow, error: domainErr } = await supabase
          .from('domains')
          .select('id, name')
          .ilike('name', `%${hint}%`)
          .maybeSingle();

        if (domainErr) {
          console.error('Fehler beim Domänen-Lookup:', domainErr);
          warnings.push(`Domänen-Lookup-Fehler: ${domainErr.message}`);
        } else if (domainRow) {
          domainId = domainRow.id;
        } else {
          warnings.push(
            `Keine passende Domäne zu Hint "${hint}" gefunden – verwende Fallback.`,
          );
        }
      }

      if (!domainId) {
        domainId = FALLBACK_DOMAIN_ID;
        warnings.push(
          `Keine Domäne erkannt – Fallback-Domäne ${FALLBACK_DOMAIN_ID} verwendet.`,
        );
      }

      // Nächste freie Version bestimmen
      let nextVersion = 1;

      const { data: latestBrief, error: latestErr } = await supabase
        .from('briefs')
        .select('version')
        .eq('domain_id', domainId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestErr) {
        console.error('Fehler beim Laden der letzten Version:', latestErr);
        warnings.push(
          `Version-Lookup-Fehler: ${latestErr.message} – setze version = 1.`,
        );
      } else if (latestBrief && latestBrief.version != null) {
        nextVersion = Number(latestBrief.version) + 1;
      }

      const { data, error } = await supabase
        .from('briefs')
        .insert({
          domain_id: domainId,
          title: parseResult.title,
          status: 'draft',
          raw_markdown: parseResult.raw_text,
          version: nextVersion,
        })
        .select('id, title, version')
        .single();

      if (error || !data) {
        console.error('Supabase insert briefs failed:', error);
        return res.status(500).json({
          error: 'insert_failed',
          message: error?.message ?? 'Fehler beim Speichern des Steckbriefs',
        });
      }

      return res.status(200).json({
        kind: 'brief',
        brief_id: data.id,
        title: data.title,
        version: data.version,
        warnings,
      });
    }

    if (parseResult.kind === 'sheet') {
      const { data: sheetRow, error: sheetErr } = await supabase
        .from('overleitung_sheets')
        .insert({
          name: filename,
          theme: parseResult.theme,
          status: 'draft',
        })
        .select('id')
        .single();

      if (sheetErr || !sheetRow) {
        console.error('Supabase insert overleitung_sheets failed:', sheetErr);
        return res.status(500).json({
          error: 'insert_failed (sheet)',
          message:
            sheetErr?.message ?? 'Fehler beim Speichern des Überleitungssheets',
        });
      }

      const sheetId = sheetRow.id;
      let orderIndex = 0;
      const warnings = [...(parseResult.warnings ?? [])];

      for (const q of parseResult.questions) {
        const { error: qErr } = await supabase.from('sheet_questions').insert({
          sheet_id: sheetId,
          code: q.code,
          question: q.question,
          checkpoints: q.checkpoints,
          order_index: orderIndex,
          active: true,
        });

        if (qErr) {
          console.error('Supabase insert sheet_questions failed:', qErr);
          warnings.push(`Fehler bei Frage "${q.question}": ${qErr.message}`);
        } else {
          orderIndex++;
        }
      }

      return res.status(200).json({
        kind: 'sheet',
        sheet_id: sheetId,
        theme: parseResult.theme,
        questions_imported: orderIndex,
        warnings,
      });
    }

    return res.status(500).json({
      error: 'unexpected_result',
      message: 'Parser-Ergebnis hatte einen unbekannten kind-Wert.',
    });
  } catch (e: any) {
    console.error('Error in /api/ingest/upload:', e);
    return res.status(500).json({
      error: 'internal',
      message: e?.message ?? 'Unbekannter Fehler',
    });
  }
});

app.post('/api/ingest/uploadjson', async (req, res) => {
  console.log('Hello Uploadjson!');

  console.log(
    '[UPLOAD_JSON_HIT]',
    new Date().toISOString(),
    'filename =',
    req.body?.filename,
    'mimetype =',
    req.body?.mimetype,
  );

  try {
    const { filename, mimetype, content_base64 } = req.body ?? {};

    if (!filename || !mimetype || !content_base64) {
      return res.status(400).json({
        error: 'bad_request',
        message:
          'JSON-Body muss filename, mimetype und content_base64 enthalten.',
      });
    }

    const parseResult = await classifyAndExtractUpload({
      filename,
      mimetype,
      base64: content_base64,
    });

    if (parseResult.kind === 'unknown') {
      return res.status(200).json(parseResult);
    }

    if (parseResult.kind === 'brief') {
      // Domäne bestimmen
      let domainId: string | null = null;
      const warnings = [...(parseResult.warnings ?? [])];

      if (parseResult.domain_hint && parseResult.domain_hint.trim().length > 0) {
        const hint = parseResult.domain_hint.trim();

        const { data: domainRow, error: domainErr } = await supabase
          .from('domains')
          .select('id, name')
          .ilike('name', `%${hint}%`)
          .maybeSingle();

        if (domainErr) {
          console.error('Fehler beim Domänen-Lookup:', domainErr);
          warnings.push(`Domänen-Lookup-Fehler: ${domainErr.message}`);
        } else if (domainRow) {
          domainId = domainRow.id;
        } else {
          warnings.push(
            `Keine passende Domäne zu Hint "${hint}" gefunden – verwende Fallback.`,
          );
        }
      }

      if (!domainId) {
        domainId = FALLBACK_DOMAIN_ID;
        warnings.push(
          `Keine Domäne erkannt – Fallback-Domäne ${FALLBACK_DOMAIN_ID} verwendet.`,
        );
      }

      // Nächste freie Version bestimmen
      let nextVersion = 1;

      const { data: latestBrief, error: latestErr } = await supabase
        .from('briefs')
        .select('version')
        .eq('domain_id', domainId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestErr) {
        console.error('Fehler beim Laden der letzten Version:', latestErr);
        warnings.push(
          `Version-Lookup-Fehler: ${latestErr.message} – setze version = 1.`,
        );
      } else if (latestBrief && latestBrief.version != null) {
        nextVersion = Number(latestBrief.version) + 1;
      }

      const { data, error } = await supabase
        .from('briefs')
        .insert({
          domain_id: domainId,
          title: parseResult.title,
          status: 'draft',
          raw_markdown: parseResult.raw_text,
          version: nextVersion,
        })
        .select('id, title, version')
        .single();

      if (error || !data) {
        console.error('Supabase insert briefs failed:', error);
        return res.status(500).json({
          error: 'insert_failed',
          message: error?.message ?? 'Fehler beim Speichern des Steckbriefs',
        });
      }

      return res.status(200).json({
        kind: 'brief',
        brief_id: data.id,
        title: data.title,
        version: data.version,
        warnings,
      });
    }

    if (parseResult.kind === 'sheet') {
      const { data: sheetRow, error: sheetErr } = await supabase
        .from('overleitung_sheets')
        .insert({
          name: filename,
          theme: parseResult.theme,
          status: 'draft',
        })
        .select('id')
        .single();

      if (sheetErr || !sheetRow) {
        console.error('Supabase insert overleitung_sheets failed:', sheetErr);
        return res.status(500).json({
          error: 'insert_failed (sheet)',
          message:
            sheetErr?.message ?? 'Fehler beim Speichern des Überleitungssheets',
        });
      }

      const sheetId = sheetRow.id;
      let orderIndex = 0;
      const warnings = [...(parseResult.warnings ?? [])];

      for (const q of parseResult.questions) {
        const { error: qErr } = await supabase.from('sheet_questions').insert({
          sheet_id: sheetId,
          code: q.code,
          question: q.question,
          checkpoints: q.checkpoints,
          order_index: orderIndex,
          active: true,
        });

        if (qErr) {
          console.error('Supabase insert sheet_questions failed:', qErr);
          warnings.push(`Fehler bei Frage "${q.question}": ${qErr.message}`);
        } else {
          orderIndex++;
        }
      }

      return res.status(200).json({
        kind: 'sheet',
        sheet_id: sheetId,
        theme: parseResult.theme,
        questions_imported: orderIndex,
        warnings,
      });
    }

    return res
      .status(500)
      .json({ error: 'not_implemented', message: 'TODO: copy logic from /upload' });
  } catch (e: any) {
    console.error('Error in /api/ingest/uploadjson:', e);
    return res.status(500).json({
      error: 'internal',
      message: e?.message ?? 'Unbekannter Fehler',
    });
  }
});

// Kein eigener 404-Handler – den übernimmt Flowise für Nicht-/api-Routen.

// ----------------------------------------
// Server starten
// ----------------------------------------
app.listen(API_PORT, () => {
  console.log(
    `Check: Brief-API läuft auf Port ${API_PORT} (FLOWISE_TARGET=${FLOWISE_TARGET})`,
  );
});