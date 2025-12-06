// src/server/core/history.ts

import { ChatHistoryEntry } from './llm';

/**
 * Normalisiert das History-Array aus dem Frontend
 * (Browser-Session), sodass daraus später eine LLM-History
 * werden kann.
 */
export function normalizeSessionHistory(raw: any[]): ChatHistoryEntry[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: any) => {
      if (!item || typeof item.content !== 'string') return null;

      const content = item.content.trim();
      if (!content) return null;

      const role = item.role;

      if (role === 'user' || role === 'userMessage') {
        return { role: 'user' as const, content };
      }
      if (role === 'assistant' || role === 'apiMessage') {
        return { role: 'assistant' as const, content };
      }

      return null;
    })
    .filter((h): h is ChatHistoryEntry => h !== null);
}

/**
 * Kürzt eine History auf maximale Länge.
 */
export function trimHistory(
  history: ChatHistoryEntry[],
  max: number,
): ChatHistoryEntry[] {
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

/**
 * Baut eine LLM-History aus DB-Answer-Records.
 * Erwartet Rows mit answer_json.llm_question und answer_json.user_answer.
 */
export function buildChatHistoryFromAnswers(
  answers: { answer_json: any }[],
): ChatHistoryEntry[] {
  const out: ChatHistoryEntry[] = [];

  for (const a of answers) {
    const j = a.answer_json;
    if (!j) continue;

    if (typeof j.llm_question === 'string') {
      out.push({ role: 'assistant', content: j.llm_question.trim() });
    }

    if (typeof j.user_answer === 'string') {
      out.push({ role: 'user', content: j.user_answer.trim() });
    }
  }

  return out;
}

/**
 * Kombiniert DB-History + Session-History.
 */
export function combineHistories(
  dbHistory: ChatHistoryEntry[],
  sessionHistory: ChatHistoryEntry[],
  maxTotal = 40,
): ChatHistoryEntry[] {
  const merged = [...dbHistory, ...sessionHistory];
  return trimHistory(merged, maxTotal);
}