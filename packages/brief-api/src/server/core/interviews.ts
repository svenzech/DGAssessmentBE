// packages/brief-api/src/server/core/interviews.ts
//
// Zentrale Logik für Interviews, Findings und Chat-History.
//

import { supabase } from '../../supabase_client';

// -------------------------------
// Typen
// -------------------------------

// Backend-eigener ChatMessage-Typ, damit wir nicht das Frontend importieren müssen
export interface CoreChatMessage {
  role: 'assistant' | 'user';
  content: string;
}

export interface InterviewRow {
  id: string;
  user_id: string;
  brief_id: string;
  status: string | null;
  interview_type: string | null;
}

export interface LeanFinding {
  id: string;
  sheet_id: string | null;
  sheet_name: string | null;
  theme: string | null;
  question_id: string;
  question_code: string | null;
  question: string;
  score_1_5: number | null;
  rationale: string | null;
  evidence: string[];
  open_questions: string[];
  status: string | null;
}

export interface LeanInterviewContext {
  brief: {
    id: string;
    title: string | null;
    raw_markdown: string;
  };
  interview: LeanFinding[];
}

export interface AnswerRecord {
  id: string;
  interview_id: string;
  created_at: string;
  answer_json: any;
}



// ======================================================
// 1) Interview für einen User holen (das "laufende" Interview)
// ======================================================

export async function loadActiveInterviewForUser(
  userId: string,
): Promise<InterviewRow | null> {
  const { data, error } = await supabase
    .from('interviews')
    .select('id, user_id, brief_id, status, interview_type')
    .eq('user_id', userId)
    .eq('status', 'started')        // nur aktive Interviews
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data[0] as InterviewRow;
}

// ======================================================
// 2) Findings + Brief laden → Lean-Kontext
// ======================================================

export async function loadLeanContext(
  interviewId: string,
): Promise<LeanInterviewContext> {
  // Interview laden
  const { data: interviewRow, error: errInterview } = await supabase
    .from('interviews')
    .select('id, brief_id')
    .eq('id', interviewId)
    .single();

  if (errInterview) throw errInterview;
  if (!interviewRow) throw new Error('Interview nicht gefunden');

  const briefId = interviewRow.brief_id;

  // Brief + Findings gemeinsam laden
  const [brief, findingsBase] = await Promise.all([
    supabase
      .from('briefs')
      .select('id, title, raw_markdown')
      .eq('id', briefId)
      .single(),

    supabase
      .from('brief_sheet_findings')
      .select('id, sheet_id, question_id, finding_json')
      .eq('brief_id', briefId),
  ]);

  if (brief.error) throw brief.error;
  if (findingsBase.error) throw findingsBase.error;

  const rows = findingsBase.data ?? [];
  const sheetIds = Array.from(new Set(rows.map((r: any) => r.sheet_id).filter(Boolean)));
  const questionIds = Array.from(new Set(rows.map((r: any) => r.question_id).filter(Boolean)));

  const [sheetRows, questionRows] = await Promise.all([
    sheetIds.length > 0
      ? supabase
          .from('overleitung_sheets')
          .select('id, name, theme')
          .in('id', sheetIds)
      : Promise.resolve({ data: [], error: null }),
    questionIds.length > 0
      ? supabase
          .from('sheet_questions')
          .select('id, question, code, checkpoints')
          .in('id', questionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (sheetRows.error) throw sheetRows.error;
  if (questionRows.error) throw questionRows.error;

  const sheetById = new Map((sheetRows.data ?? []).map((s: any) => [s.id, s]));
  const questionById = new Map((questionRows.data ?? []).map((q: any) => [q.id, q]));

  const items: LeanFinding[] = [];

  for (const row of rows) {
    const sheetRel = sheetById.get(row.sheet_id);
    const questionRel = questionById.get(row.question_id);
    if (!sheetRel || !questionRel) {
      continue;
    }

    const fj = row.finding_json ?? {};
    const inner = fj.finding ?? fj;

    const score_1_5 =
      typeof inner.score_1_5 === 'number'
        ? inner.score_1_5
        : typeof inner.score === 'number'
        ? inner.score
        : null;

    const rationale =
      typeof inner.rationale === 'string' ? inner.rationale : null;

    const status =
      typeof inner.status === 'string' ? inner.status : null;

    const evidence = Array.isArray(fj.evidence)
      ? fj.evidence.map((e: any) =>
          typeof e === 'string'
            ? e
            : typeof e.quote === 'string'
            ? e.quote
            : JSON.stringify(e),
        )
      : [];

    const open_questions = Array.isArray(fj.open_questions)
      ? fj.open_questions.map((q: any) => String(q))
      : [];

    items.push({
      id: row.id,
      sheet_id: sheetRel?.id ?? null,
      sheet_name: sheetRel?.name ?? null,
      theme: sheetRel?.theme ?? null,
      question_id: questionRel?.id ?? row.question_id,
      question_code: questionRel?.code ?? null,
      question: questionRel?.question ?? '',
      score_1_5,
      rationale,
      evidence,
      open_questions,
      status,
    });
  }

  return {
    brief: {
      id: brief.data.id,
      title: brief.data.title,
      raw_markdown: brief.data.raw_markdown,
    },
    interview: items,
  };
}

// ======================================================
// 3) Answers laden
// ======================================================

export async function loadAnswers(
  interviewId: string,
): Promise<AnswerRecord[]> {
  const { data, error } = await supabase
    .from('answers')
    .select('id, interview_id, created_at, answer_json')
    .eq('interview_id', interviewId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data ?? []) as AnswerRecord[];
}

// ======================================================
// 4) Chat-History aus DB-Answers rekonstruieren
// ======================================================

export function buildChatHistoryFromAnswers(
  answers: AnswerRecord[],
): CoreChatMessage[] {
  const history: CoreChatMessage[] = [];

  for (const rec of answers) {
    const j = rec.answer_json;
    if (!j) continue;

    // Assistant → stellt Frage
    if (typeof j.llm_question === 'string') {
      history.push({
        role: 'assistant',
        content: j.llm_question,
      });
    }

    // User → gibt Antwort
    if (typeof j.user_answer === 'string') {
      history.push({
        role: 'user',
        content: j.user_answer,
      });
    }
  }

  return history;
}

// ======================================================
// 5) Helper: letzte Assistant-Frage + Finding-ID
// ======================================================

export function getLastAssistantTurnWithFindingId(
  answers: AnswerRecord[],
): { question: string; finding_id: string } | null {
  const reversed = [...answers].reverse();

  for (const rec of reversed) {
    const j = rec.answer_json;
    if (j?.llm_question && j?.finding_id) {
      return {
        question: j.llm_question,
        finding_id: j.finding_id,
      };
    }
  }

  return null;
}
