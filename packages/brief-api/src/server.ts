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



// ----------------------------------------
// Eigene Imports
// ----------------------------------------
import { startInterviewsForUser } from '../../brief-parser/src/start_interview_user';
import { loadInterviewContext } from '../../brief-parser/src/interview_context';
import { saveAnswer } from '../../brief-parser/src/save_answer';
import { evaluateInterview } from '../../brief-parser/src/evaluate_interview';
import { evaluateBriefSheet } from '../../brief-parser/src/evaluate_brief_sheet';
import { supabase } from './supabase_client';
import { classifyAndExtractUpload } from './llm_upload_parser';

// ----------------------------------------
// Basis-Setup Express
// ----------------------------------------
const app = express();

const API_PORT = Number(process.env.PORT ?? process.env.BRIEF_API_PORT ?? 4000);

const FALLBACK_DOMAIN_ID =
  process.env.FALLBACK_DOMAIN_ID ?? '00000000-0000-0000-0000-000000000000';
console.info('FALLBACK_DOMAIN_ID ist (' + FALLBACK_DOMAIN_ID + ').');

// Upload-Konfiguration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '3mb' }));

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



// ---- Briefs: Liste ----
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


// ---- Sheets: Liste aller Überleitungssheets ----
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



// Brief aktualisieren
app.put('/api/briefs/:briefId', async (req, res) => {
  const { briefId } = req.params;
  const payload = req.body ?? {};

  // Primärschlüssel nicht überschreiben
  delete payload.id;

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



// Sheet aktualisieren
app.put('/api/sheets/:sheetId', async (req, res) => {
  const { sheetId } = req.params;
  const payload = req.body ?? {};

  delete payload.id;

  try {
    const { data, error } = await supabase
      .from('overleitung_sheets')
      .update(payload)
      .eq('id', sheetId)
      .select('id, name, theme, status, version, created_at, theme_target_descr')
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



// ---- Briefs ----
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

      if (error && error.code !== 'PGRST116') {
        // no rows
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

// ---- Interviews ----

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

app.get('/api/interviews/:interviewId/context', async (req, res) => {
  try {
    const { interviewId } = req.params;

    if (!interviewId) {
      return res
        .status(400)
        .json({ error: 'interviewId in der URL wird benötigt.' });
    }

    const ctx = await loadInterviewContext(interviewId);
    res.json(ctx);
  } catch (e: any) {
    console.error('Fehler in /:interviewId/context:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

app.post('/api/interviews/:interviewId/answers', async (req, res) => {
  console.log('Hello answers!');

  try {
    const { interviewId } = req.params;
    const { answer_json } = req.body ?? {};

    if (!interviewId) {
      return res
        .status(400)
        .json({ error: 'interviewId in der URL wird benötigt.' });
    }

    if (answer_json === undefined) {
      return res
        .status(400)
        .json({ error: 'answer_json im Body wird benötigt.' });
    }

    const saved = await saveAnswer({
      interviewId,
      answerJson: answer_json,
    });

    res.json(saved);
  } catch (e: any) {
    console.error('Fehler in POST /:interviewId/answers:', e);
    res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});

app.post('/api/interviews/:id/evaluate', async (req, res) => {
  try {
    const interviewId = req.params.id;
    const result = await evaluateInterview(interviewId);
    res.json({ data: result });
  } catch (err) {
    console.error('Error evaluating interview', err);
    res.status(500).json({ error: 'Failed to evaluate interview' });
  }
});

// ---- Upload / Ingest ----

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