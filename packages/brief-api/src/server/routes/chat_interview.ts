// src/server/routes/chat_interview.ts
//
// Route: POST /api/interview/chat
// Direkter Interview-Chat ohne Flowise.

import { Router } from 'express';

import {
  runInterviewTurn,
  InterviewMode,
  ChatHistoryEntry,
} from '../core/llm';

import {
  resolveUserIdentifier,
  findUserByUsername,
} from '../core/users';

import {
  loadActiveInterviewForUser,
  loadLeanContext,
  loadAnswers,
  buildChatHistoryFromAnswers,
} from '../core/interviews';

import { saveAnswer } from '../../../../brief-parser/src/save_answer';

export const chatInterviewRouter = Router();

chatInterviewRouter.post('/api/interview/chat', async (req, res) => {
  try {
    const {
      message,
      text,
      history,
      user,
      userId,
      username,
      mode: clientMode,
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

    const userAnswer = questionRaw.trim();

    // ------------------------------
    // 1) User ermitteln
    // ------------------------------
    const userIdentifier = resolveUserIdentifier({ user, userId, username });

    if (!userIdentifier) {
      return res.json({
        answer:
          'Es konnte kein gültiger Benutzername ermittelt werden. ' +
          'Bitte tragen Sie oben einen gültigen Benutzernamen ein oder starten Sie den Chat direkt aus LearnWorlds.',
        raw: '',
      });
    }

    console.log('[INTERVIEW_CHAT] userIdentifier =', userIdentifier);

    let userRow: { id: string; username: string } | null = null;
    try {
      userRow = await findUserByUsername(userIdentifier);
    } catch (userErr) {
      console.error('[INTERVIEW_CHAT] Fehler beim User-Lookup:', userErr);
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
    console.log('[INTERVIEW_CHAT] gefundener User id =', userDbId);

    // ------------------------------
    // 2) Aktives Interview ermitteln
    // ------------------------------
    let interviewRow = null;
    try {
      interviewRow = await loadActiveInterviewForUser(userDbId);
    } catch (intErr) {
      console.error(
        '[INTERVIEW_CHAT] Fehler beim Interview-Lookup für User',
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

    const interviewId = interviewRow.id as string;
    console.log(
      '[INTERVIEW_CHAT] Interview gefunden:',
      interviewId,
      'Status =',
      interviewRow.status,
    );

    //
    // 3) Session-History (nur aktueller Browser) normalisieren
    //
    const rawHistory = Array.isArray(history) ? history : [];

    const normalizedSessionHistory = rawHistory
      .map((item: any, idx: number) => {
        if (!item || typeof item.content !== 'string') return null;
        const content = item.content;
        const role = item.role;

        if (role === 'user' || role === 'userMessage') {
          return { role: 'userMessage' as const, content };
        }
        if (role === 'assistant' || role === 'apiMessage') {
          return { role: 'apiMessage' as const, content };
        }

        console.warn(
          '[INTERVIEW_CHAT] History-Item mit unbekannter Rolle übersprungen',
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

    // Session-History im LLM-Format
    const sessionHistory: ChatHistoryEntry[] = normalizedSessionHistory.map(
      (h) => ({
        role: h.role === 'apiMessage' ? 'assistant' : 'user',
        content: h.content,
      }),
    );

    const MAX_SESSION_HISTORY = 20;
    const sessionHistoryTrimmed =
      sessionHistory.length > MAX_SESSION_HISTORY
        ? sessionHistory.slice(sessionHistory.length - MAX_SESSION_HISTORY)
        : sessionHistory;

    //
    // 4) DB-History aus answers (Kontext über Sessions hinweg)
    //
    let dbHistory: ChatHistoryEntry[] = [];
    try {
      const answerRows = await loadAnswers(interviewId);
      const coreHistory = buildChatHistoryFromAnswers(answerRows);

      dbHistory = coreHistory
        .map((m) => ({
          role: m.role as 'assistant' | 'user',
          content: typeof m.content === 'string' ? m.content.trim() : '',
        }))
        .filter((m) => m.content.length > 0);
    } catch (err) {
      console.warn(
        '[INTERVIEW_CHAT] Unerwarteter Fehler beim Laden der DB-History:',
        err,
      );
    }

    //
    // 5) Modus bestimmen – NUR über die Session-History!
    //
    let mode: InterviewMode;

    if (
      clientMode === 'start' ||
      clientMode === 'answer' ||
      clientMode === 'user_question'
    ) {
      mode = clientMode;
    } else {
      const hasAssistantTurn = normalizedSessionHistory.some(
        (h) => h.role === 'apiMessage',
      );

      if (!hasAssistantTurn) {
        // Erste Interaktion in dieser Browser-Session → start
        mode = 'start';
      } else {
        const trimmed = userAnswer.trim();
        if (trimmed.endsWith('?') && trimmed.length > 3) {
          mode = 'user_question';
        } else {
          mode = 'answer';
        }
      }
    }

    console.log('[INTERVIEW_CHAT] mode =', mode, {
      sessionHistoryLen: normalizedSessionHistory.length,
      dbHistoryLen: dbHistory.length,
    });

    //
    // 6) LLM-History = DB-History + Session-History (nur Kontext)
    //
    const combinedHistory: ChatHistoryEntry[] = [
      ...dbHistory,
      ...sessionHistoryTrimmed,
    ];

    const MAX_TOTAL_HISTORY = 40;
    const llmHistoryTrimmed =
      combinedHistory.length > MAX_TOTAL_HISTORY
        ? combinedHistory.slice(combinedHistory.length - MAX_TOTAL_HISTORY)
        : combinedHistory;

    // 7) Interview-Kontext laden (Lean)
    const ctx = await loadLeanContext(interviewId);

    // 8) LLM-Turn ausführen
    const llmResult = await runInterviewTurn({
      mode,
      lastUserMessage: userAnswer,
      interviewContext: ctx,
      chatHistory: llmHistoryTrimmed,
    });

    const {
      answer = '',
      question: nextQuestion = '',
      status = 'continue',
      finding_id: answeredFindingId = null,
    } = llmResult as any;

    // ------------------------------------------------------
    // 9) Antwort speichern: previous Bot-Frage + User-Antwort
    //    MAPPING nur über die Session-History
    // ------------------------------------------------------
    try {
      if (mode === 'answer') {
        // Nur letzte Assistant-Nachricht der aktuellen Browser-Session betrachten
        const lastAssistantMsg = [...sessionHistoryTrimmed]
          .reverse()
          .find((h) => h.role === 'assistant');

        const previousQuestion = lastAssistantMsg?.content?.trim() || null;

        if (previousQuestion) {
          let matchedItem: any | null = null;

          if (answeredFindingId && Array.isArray(ctx.interview)) {
            matchedItem =
              ctx.interview.find(
                (item: any) => item.id === answeredFindingId,
              ) ?? null;
          }

          const answerJson = {
            kind: 'interview_chat_v1',

            // Leitfrage-Mapping (für spätere Auswertung)
            finding_id: answeredFindingId,
            theme: matchedItem?.theme ?? null,
            sheet_id: matchedItem?.sheet_id ?? null,
            sheet_name: matchedItem?.sheet_name ?? null,

            // Tatsächliches Q&A-Paar in diesem Turn
            llm_question: previousQuestion,
            user_answer: userAnswer,

            status,
          };

          await saveAnswer({
            interviewId,
            answerJson,
          });

          console.log('[INTERVIEW_CHAT] Antwort gespeichert:', answerJson);
        } else {
          console.log(
            '[INTERVIEW_CHAT] Keine previousQuestion gefunden → nichts gespeichert.',
          );
        }
      } else {
        console.log(
          '[INTERVIEW_CHAT] mode != answer (',
          mode,
          ') → keine Antwort gespeichert.',
        );
      }
    } catch (saveErr) {
      console.error(
        '[INTERVIEW_CHAT] Fehler beim Speichern der Antwort:',
        saveErr,
      );
    }

    //
    // 10) Meta-Infos zur NÄCHSTEN Frage (für Badge im Frontend)
    //
    let nextQuestionMeta: {
      finding_id: string | null;
      theme: string | null;
      sheet_id: string | null;
      sheet_name: string | null;
    } | null = null;

    try {
      if (Array.isArray(ctx.interview) && nextQuestion) {
        // Heuristik: das Finding mit derselben finding_id wie im LLM-Result
        const nextFindingId =
          typeof (llmResult as any).finding_id === 'string'
            ? (llmResult as any).finding_id
            : null;

        let matchedNext: any | null = null;

        if (nextFindingId) {
          matchedNext =
            ctx.interview.find((item: any) => item.id === nextFindingId) ??
            null;
        }

        if (matchedNext) {
          nextQuestionMeta = {
            finding_id: matchedNext.id ?? nextFindingId,
            theme: matchedNext.theme ?? null,
            sheet_id: matchedNext.sheet_id ?? null,
            sheet_name: matchedNext.sheet_name ?? null,
          };
        }
      }
    } catch (metaErr) {
      console.warn(
        '[INTERVIEW_CHAT] Konnte Meta-Infos zur nächsten Frage nicht bestimmen:',
        metaErr,
      );
    }

    // 11) Antwort an das Frontend
    return res.json({
      answer,
      question: nextQuestion,
      status,
      meta: nextQuestionMeta ?? null,
      raw: llmResult,
    });
  } catch (e: any) {
    console.error('Unerwarteter Fehler in POST /api/interview/chat:', e);
    return res.status(500).json({
      error: 'internal',
      message: e?.message ?? 'Unbekannter Fehler',
    });
  }
});