// src/server/routes/sheets.ts
//
// Routen: /api/sheets..., /api/sheets/:id/questions,
// plus Scorecard / Evaluate für Brief/Sheet.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { supabase } from '../../supabase_client';
import { evaluateBriefSheet } from '../../../../brief-parser/src/evaluate_brief_sheet';

export const sheetsRouter = Router();

// Sheet-Detail (ohne Fragen)
sheetsRouter.get('/api/sheets/:sheetId', async (req, res) => {
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

// Sheet patchen
sheetsRouter.patch('/api/sheets/:sheetId', async (req, res) => {
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

// Liste aller Sheets
sheetsRouter.get('/api/sheets', async (_req, res) => {
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
sheetsRouter.put('/api/sheets/:sheetId', async (req, res) => {
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
sheetsRouter.delete('/api/sheets/:sheetId', async (req, res) => {
  const { sheetId } = req.params;
  const force =
    req.query.force === 'true' ||
    req.query.force === '1' ||
    req.query.confirm === 'true';

  try {
    const { data: sheet, error: sheetErr } = await supabase
      .from('overleitung_sheets')
      .select('id')
      .eq('id', sheetId)
      .maybeSingle();

    if (sheetErr) {
      console.error('Fehler beim Laden des Sheets vor DELETE:', sheetErr);
      return res.status(500).json({ error: sheetErr.message });
    }

    if (!sheet) {
      return res.status(404).json({ error: 'Sheet nicht gefunden' });
    }

    const { count: evaluationCount, error: evaluationCountErr } =
      await supabase
        .from('brief_sheet_evaluations')
        .select('id', { count: 'exact', head: true })
        .eq('sheet_id', sheetId);

    if (evaluationCountErr) {
      console.error(
        'Fehler beim Zählen abhängiger Auswertungen vor DELETE:',
        evaluationCountErr,
      );
      return res.status(500).json({ error: evaluationCountErr.message });
    }

    const { count: findingCount, error: findingCountErr } = await supabase
      .from('brief_sheet_findings')
      .select('id', { count: 'exact', head: true })
      .eq('sheet_id', sheetId);

    if (findingCountErr) {
      console.error(
        'Fehler beim Zählen abhängiger Baseline-Findings vor DELETE:',
        findingCountErr,
      );
      return res.status(500).json({ error: findingCountErr.message });
    }

    if ((evaluationCount ?? 0) > 0 && !force) {
      return res.status(409).json({
        error: 'sheet_has_evaluations',
        message:
          'Für dieses Überleitungssheet existieren gespeicherte Auswertungen.',
        evaluations_count: evaluationCount ?? 0,
        findings_count: findingCount ?? 0,
      });
    }

    const { data: questionRows, error: questionErr } = await supabase
      .from('sheet_questions')
      .select('id')
      .eq('sheet_id', sheetId);

    if (questionErr) {
      console.error('Fehler beim Laden abhängiger Fragen vor DELETE:', questionErr);
      return res.status(500).json({ error: questionErr.message });
    }

    const questionIds = (questionRows ?? [])
      .map((row: any) => row.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);

    const { error: evaluationsErr } = await supabase
      .from('brief_sheet_evaluations')
      .delete()
      .eq('sheet_id', sheetId);

    if (evaluationsErr) {
      console.error(
        'Fehler beim Löschen abhängiger Auswertungen in DELETE /api/sheets/:sheetId:',
        evaluationsErr,
      );
      return res.status(500).json({ error: evaluationsErr.message });
    }

    const { error: findingsErr } = await supabase
      .from('brief_sheet_findings')
      .delete()
      .eq('sheet_id', sheetId);

    if (findingsErr) {
      console.error(
        'Fehler beim Löschen abhängiger Baseline-Findings in DELETE /api/sheets/:sheetId:',
        findingsErr,
      );
      return res.status(500).json({ error: findingsErr.message });
    }

    if (questionIds.length > 0) {
      const { error: answersErr } = await supabase
        .from('answers')
        .update({ question_id: null })
        .in('question_id', questionIds);

      if (answersErr) {
        console.error(
          'Fehler beim Lösen abhängiger Antworten in DELETE /api/sheets/:sheetId:',
          answersErr,
        );
        return res.status(500).json({ error: answersErr.message });
      }
    }

    const { error: questionsDeleteErr } = await supabase
      .from('sheet_questions')
      .delete()
      .eq('sheet_id', sheetId);

    if (questionsDeleteErr) {
      console.error(
        'Fehler beim Löschen abhängiger Fragen in DELETE /api/sheets/:sheetId:',
        questionsDeleteErr,
      );
      return res.status(500).json({ error: questionsDeleteErr.message });
    }

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

// Alle Fragen eines Sheets laden
sheetsRouter.get('/api/sheets/:sheetId/questions', async (req, res) => {
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

// Fragen eines Sheets updaten
sheetsRouter.put('/api/sheets/:sheetId/questions', async (req, res) => {
  const { sheetId } = req.params;
  const { questions } = req.body ?? {};

  if (!Array.isArray(questions)) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Body muss ein Feld "questions" mit einem Array enthalten.',
    });
  }

  try {
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
      id?: string | null;
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
      const candidateId =
        typeof q.id === 'string' && q.id.trim().length > 0
          ? q.id.trim()
          : null;
      const existingId =
        candidateId && existingIds.has(candidateId) ? candidateId : null;
      const id = existingId ?? randomUUID();

      if (existingId) {
        seenIds.add(existingId);
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

// Scorecard: letzte Bewertung
sheetsRouter.get(
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

// Scorecard: Evaluate
sheetsRouter.post(
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
