// src/server/routes/chat_flowise.ts
//
// Route: POST /api/flowise/chat
// Proxy zum Flowise-Server, inkl. User-/Interview-Check.

import { Router } from 'express';
import {
  resolveUserIdentifier,
  findUserByUsername,
} from '../core/users';
import { loadActiveInterviewForUser } from '../core/interviews';

export interface ChatFlowiseConfig {
  flowiseTarget: string;
  chatflowId?: string | null;
}

export function createChatFlowiseRouter(config: ChatFlowiseConfig) {
  const { flowiseTarget, chatflowId } = config;
  const router = Router();

  router.post('/api/flowise/chat', async (req, res) => {
    try {
      const {
        message,
        text,
        history,
        user,
        userId,
        username,
        overrideConfig: clientOverrideConfig,
      } = req.body ?? {};

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

      if (!chatflowId) {
        return res.status(500).json({
          error: 'config_error',
          message: 'FLOWISE_CHATFLOW_ID ist nicht konfiguriert.',
        });
      }

      const question = questionRaw.trim();

      // 1) User + Interview-Check
      const userIdentifier = resolveUserIdentifier({ user, userId, username });

      if (!userIdentifier) {
        return res.json({
          answer:
            'Es konnte kein gültiger Benutzername ermittelt werden. ' +
            'Bitte tragen Sie oben einen gültigen Benutzernamen ein oder starten Sie den Chat direkt aus LearnWorlds.',
          raw: '',
        });
      }

      console.log('[FLOWISE_CHAT] userIdentifier =', userIdentifier);

      let userRow: { id: string; username: string } | null = null;
      try {
        userRow = await findUserByUsername(userIdentifier);
      } catch (userErr) {
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

      let interviewRow = null;
      try {
        interviewRow = await loadActiveInterviewForUser(userDbId);
      } catch (intErr) {
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

      // 2) History normalisieren
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
          (
            x,
          ): x is { role: 'userMessage' | 'apiMessage'; content: string } =>
            x !== null,
        );

      // 3) Flowise-Aufruf
      const flowiseUrl = `${flowiseTarget.replace(
        /\/$/,
        '',
      )}/api/v1/prediction/${chatflowId}`;

      const clientOC =
        clientOverrideConfig && typeof clientOverrideConfig === 'object'
          ? clientOverrideConfig
          : {};

      const payload = {
        user: userIdentifier,
        question,
        history: normalizedHistory,
        overrideConfig: {
          sessionId: interviewId,
          chatId: interviewId,
          userId: userIdentifier,
          ...clientOC,
          vars: {
            ...(clientOC as any).vars,
            INTERVIEW_ID: interviewId,
          },
        },
      };

      console.log('[FLOWISE_CHAT] Request →', flowiseUrl, {
        user: userIdentifier,
        question,
        historyLen: normalizedHistory.length,
        interviewId,
        overrideConfig: payload.overrideConfig,
      });

      const fwRes = await fetch(flowiseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

      // 4) Antwort bereinigen / entpacken
      let cleanedAnswer = textBody;
      let meta: any = null;

      try {
        let outer: any = JSON.parse(textBody);

        if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
          const inner = outer as any;
          meta = inner;

          const parts: string[] = [];
          const pick = (val?: unknown): string | null => {
            if (typeof val !== 'string') return null;
            const t = val.trim();
            if (!t) return null;
            if (t === question.trim()) return null;
            return t;
          };

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

          if (parts.length === 0 && inner.data && inner.data.responseBody) {
            let rb: any = inner.data.responseBody;

            if (typeof rb === 'string') {
              const trimmed = rb.trim();
              if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                  rb = JSON.parse(trimmed);
                } catch {
                  // ignore
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

            if (parts.length === 0 && typeof rb === 'string') {
              const v = pick(rb);
              if (v) parts.push(v);
            }
          }

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

  return router;
}