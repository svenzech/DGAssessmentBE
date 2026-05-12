// src/server/routes/uploads.ts
//
// Upload-/Ingest-Routen.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { supabase } from '../../supabase_client';
import { classifyAndExtractUpload } from '../../llm_upload_parser';

export interface UploadsConfig {
  fallbackDomainId: string;
}

export function createUploadsRouter(config: UploadsConfig) {
  const { fallbackDomainId } = config;
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
    },
  });

  // /api/ingest/upload (multipart)
  router.post('/api/ingest/upload', upload.single('file'), async (req, res) => {
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
          domainId = fallbackDomainId;
          warnings.push(
            `Keine Domäne erkannt – Fallback-Domäne ${fallbackDomainId} verwendet.`,
          );
        }

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
              sheetErr?.message ??
              'Fehler beim Speichern des Überleitungssheets',
          });
        }

        const sheetId = sheetRow.id;
        let orderIndex = 0;
        const warnings = [...(parseResult.warnings ?? [])];

        for (const q of parseResult.questions) {
          const { error: qErr } = await supabase.from('sheet_questions').insert({
            id: randomUUID(),
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

  // /api/ingest/uploadjson
  router.post('/api/ingest/uploadjson', async (req, res) => {
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
          domainId = fallbackDomainId;
          warnings.push(
            `Keine Domäne erkannt – Fallback-Domäne ${fallbackDomainId} verwendet.`,
          );
        }

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
              sheetErr?.message ??
              'Fehler beim Speichern des Überleitungssheets',
          });
        }

        const sheetId = sheetRow.id;
        let orderIndex = 0;
        const warnings = [...(parseResult.warnings ?? [])];

        for (const q of parseResult.questions) {
          const { error: qErr } = await supabase.from('sheet_questions').insert({
            id: randomUUID(),
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
        error: 'not_implemented',
        message: 'TODO: copy logic from /upload',
      });
    } catch (e: any) {
      console.error('Error in /api/ingest/uploadjson:', e);
      return res.status(500).json({
        error: 'internal',
        message: e?.message ?? 'Unbekannter Fehler',
      });
    }
  });

  return router;
}
