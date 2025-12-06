// src/server/routes/domains.ts
//
// Routen: /api/domains...

import { Router } from 'express';
import { supabase } from '../../supabase_client';

export const domainsRouter = Router();

// Domänen-Liste
domainsRouter.get('/api/domains', async (_req, res) => {
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
domainsRouter.get('/api/domains/:domainId', async (req, res) => {
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
domainsRouter.post('/api/domains', async (req, res) => {
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

// Domäne ändern
domainsRouter.patch('/api/domains/:domainId', async (req, res) => {
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

// Domäne löschen
domainsRouter.delete('/api/domains/:domainId', async (req, res) => {
  const { domainId } = req.params;

  try {
    const { error } = await supabase
      .from('domains')
      .delete()
      .eq('id', domainId);

    if (error) {
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