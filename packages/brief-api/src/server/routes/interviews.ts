// src/server/routes/interviews.ts
//
// Routen: /api/interviews/... (ohne Chat – der ist in chat_interview.ts)

import { Router } from 'express';
import { startInterviewsForUser } from '../../../../brief-parser/src/start_interview_user';
import { saveAnswer } from '../../../../brief-parser/src/save_answer';
import { evaluateInterview } from '../../../../brief-parser/src/evaluate_interview';
import {
  loadContextForUserIdentifier,
  loadContextForInterviewId,
} from '../core/context';

export const interviewsRouter = Router();

// Kontext für einen bestimmten Benutzer (Lean-Variante)
interviewsRouter.get(
  '/api/interviews/context-for-user',
  async (req, res) => {
    try {
      const userParam = req.query.user;
      // hier reicht die einfache Variante: String-Trim in context-Funktion
      const result = await loadContextForUserIdentifier(
        typeof userParam === 'string' ? userParam : '',
      );

      if (!result) {
        return res.status(404).json({ error: 'no active interview or user' });
      }

      return res.json({
        brief: result.context.brief,
        interview: result.context.interview,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// Interview für User starten
interviewsRouter.post('/api/interviews/start-for-user', async (req, res) => {
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

// Interview-Kontext per Interview-ID
interviewsRouter.get(
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

      const ctx = await loadContextForInterviewId(interviewId);
      res.json(ctx);
    } catch (e: any) {
      console.error('Fehler in GET /api/interviews/.../context:', e);
      res.status(500).json({ error: e.message ?? 'Unknown error' });
    }
  },
);

// Interview-Antwort speichern (generischer Endpoint)
interviewsRouter.post(
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

      // Skip-Mechanismus
      if (answer_json?.internal?.skipSave === true) {
        console.log(
          '[answers] skipSave=true → Antwort wird nicht gespeichert',
        );
        return res.status(200).json({ skipped: true });
      }

      const saved = await saveAnswer({
        interviewId,
        answerJson: answer_json,
      });

      console.log('[answers] Antwort: ' + JSON.stringify(answer_json));

      res.json(saved);
    } catch (e: any) {
      console.error('Fehler in POST /api/interviews/.../answers:', e);
      res.status(500).json({ error: e.message ?? 'Unknown error' });
    }
  },
);

// Interview auswerten
interviewsRouter.post(
  ['/api/interviews/:id/evaluate', '/api/interviews/evaluate'],
  async (req, res) => {
    try {
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

      const result = await evaluateInterview(interviewId);

      return res.json({ data: result });
    } catch (err: any) {
      console.error(
        'Error evaluating interview for id/header:',
        err?.message ?? err,
      );

      return res.status(500).json({
        error: 'evaluate_failed',
        message:
          err?.message ??
          'Fehler bei evaluateInterview – bitte später erneut versuchen.',
      });
    }
  },
);
