// src/server/routes/briefs.ts
//
// Routen rund um Steckbriefe (/api/briefs...)

import { Router } from 'express';
import { supabase } from '../../supabase_client';

export const briefsRouter = Router();

// Briefs: Liste
briefsRouter.get('/api/briefs', async (_req, res) => {
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

// Brief patchen (Titel, Status, Domäne, Markdown – NICHT Version)
briefsRouter.patch('/api/briefs/:briefId', async (req, res) => {
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

// Brief aktualisieren (vollständig)
briefsRouter.put('/api/briefs/:briefId', async (req, res) => {
  const { briefId } = req.params;
  const payload = req.body ?? {};

  delete (payload as any).id;

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
briefsRouter.get('/api/briefs/:briefId', async (req, res) => {
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
briefsRouter.get('/api/briefs/:briefId/sheets', async (req, res) => {
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
briefsRouter.delete('/api/briefs/:briefId', async (req, res) => {
  const { briefId } = req.params;
  const force =
    req.query.force === 'true' ||
    req.query.force === '1' ||
    req.query.confirm === 'true';

  try {
    const { data: brief, error: briefErr } = await supabase
      .from('briefs')
      .select('id')
      .eq('id', briefId)
      .maybeSingle();

    if (briefErr) {
      console.error('Fehler beim Laden des Briefs vor DELETE:', briefErr);
      return res.status(500).json({ error: briefErr.message });
    }

    if (!brief) {
      return res.status(404).json({ error: 'Brief nicht gefunden' });
    }

    const { count: evaluationCount, error: evaluationCountErr } =
      await supabase
        .from('brief_sheet_evaluations')
        .select('id', { count: 'exact', head: true })
        .eq('brief_id', briefId);

    if (evaluationCountErr) {
      console.error(
        'Fehler beim Zählen abhängiger Auswertungen vor DELETE /api/briefs/:briefId:',
        evaluationCountErr,
      );
      return res.status(500).json({ error: evaluationCountErr.message });
    }

    const { count: findingCount, error: findingCountErr } = await supabase
      .from('brief_sheet_findings')
      .select('id', { count: 'exact', head: true })
      .eq('brief_id', briefId);

    if (findingCountErr) {
      console.error(
        'Fehler beim Zählen abhängiger Baseline-Findings vor DELETE /api/briefs/:briefId:',
        findingCountErr,
      );
      return res.status(500).json({ error: findingCountErr.message });
    }

    const { count: interviewCount, error: interviewCountErr } = await supabase
      .from('interviews')
      .select('id', { count: 'exact', head: true })
      .eq('brief_id', briefId);

    if (interviewCountErr) {
      console.error(
        'Fehler beim Zählen abhängiger Interviews vor DELETE /api/briefs/:briefId:',
        interviewCountErr,
      );
      return res.status(500).json({ error: interviewCountErr.message });
    }

    const hasRelatedData =
      (evaluationCount ?? 0) > 0 ||
      (findingCount ?? 0) > 0 ||
      (interviewCount ?? 0) > 0;

    if (hasRelatedData && !force) {
      return res.status(409).json({
        error: 'brief_has_related_data',
        message: 'Für diesen Steckbrief existieren abhängige Daten.',
        evaluations_count: evaluationCount ?? 0,
        findings_count: findingCount ?? 0,
        interviews_count: interviewCount ?? 0,
      });
    }

    const { data: interviewRows, error: interviewErr } = await supabase
      .from('interviews')
      .select('id')
      .eq('brief_id', briefId);

    if (interviewErr) {
      console.error(
        'Fehler beim Laden abhängiger Interviews vor DELETE /api/briefs/:briefId:',
        interviewErr,
      );
      return res.status(500).json({ error: interviewErr.message });
    }

    const interviewIds = (interviewRows ?? [])
      .map((row: any) => row.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);

    if (interviewIds.length > 0) {
      const { error: answersErr } = await supabase
        .from('answers')
        .delete()
        .in('interview_id', interviewIds);

      if (answersErr) {
        console.error(
          'Fehler beim Löschen abhängiger Antworten in DELETE /api/briefs/:briefId:',
          answersErr,
        );
        return res.status(500).json({ error: answersErr.message });
      }

      const { error: interviewsErr } = await supabase
        .from('interviews')
        .delete()
        .eq('brief_id', briefId);

      if (interviewsErr) {
        console.error(
          'Fehler beim Löschen abhängiger Interviews in DELETE /api/briefs/:briefId:',
          interviewsErr,
        );
        return res.status(500).json({ error: interviewsErr.message });
      }
    }

    const { error: evaluationsErr } = await supabase
      .from('brief_sheet_evaluations')
      .delete()
      .eq('brief_id', briefId);

    if (evaluationsErr) {
      console.error(
        'Fehler beim Löschen abhängiger Auswertungen in DELETE /api/briefs/:briefId:',
        evaluationsErr,
      );
      return res.status(500).json({ error: evaluationsErr.message });
    }

    const { error: findingsErr } = await supabase
      .from('brief_sheet_findings')
      .delete()
      .eq('brief_id', briefId);

    if (findingsErr) {
      console.error(
        'Fehler beim Löschen abhängiger Baseline-Findings in DELETE /api/briefs/:briefId:',
        findingsErr,
      );
      return res.status(500).json({ error: findingsErr.message });
    }

    const { error } = await supabase
      .from('briefs')
      .delete()
      .eq('id', briefId);

    if (error) {
      console.error('Fehler in DELETE /api/briefs/:briefId:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(204).send();
  } catch (e: any) {
    console.error('Unerwarteter Fehler in DELETE /api/briefs/:briefId:', e);
    return res.status(500).json({ error: e.message ?? 'Unknown error' });
  }
});
