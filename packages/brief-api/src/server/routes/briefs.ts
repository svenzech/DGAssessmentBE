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

  try {
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