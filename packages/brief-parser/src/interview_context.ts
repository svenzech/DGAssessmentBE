import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ==== Pfade & .env laden ====

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(PKG_ROOT, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ==== Basis-Typen aus dem DB-Schema ====

export type InterviewType = 'structure' | 'practice';

export interface InterviewRow {
  id: string;
  user_id: string;
  domain_id: string | null;
  brief_id: string;
  interview_type: InterviewType;
  status: string;
  created_at: string;
  completed_at: string | null;
  scorecard_json?: any | null;
}

export interface DomainInfo {
  id: string;
  name: string;
  description: string | null;
}

export interface BriefInfo {
  id: string;
  domain_id: string | null;
  title: string | null;
  version: number | null;
  status: string | null;
  raw_markdown: string;
}

export interface AnswerRecord {
  id: string;
  question_id: string | null;
  answer_json: any;
  created_at: string;
}

// ==== Ausführliche Findings (ehemals LeanFinding) ====

export interface FindingForInterview {
  id: string;
  sheet_id: string;
  sheet_name: string;
  theme: string;

  question_id: string;
  question_code: string;
  question: string;
  checkpoints: string[];

  status: string | null;
  score_1_5: number | null;
  rationale: string | null;
  evidence: string[];
  open_questions: string[];
}

// ==== Ausführlicher Interview-Context (neuer "Standard") ====

export interface InterviewContext {
  interview: InterviewRow;
  user: { id: string };
  domain: DomainInfo | null;
  brief: BriefInfo;
  findings: FindingForInterview[];
  answers: AnswerRecord[];
}

// ==== Schlanke Typen für Flowise / LLM ====

export interface LeanFinding {
  question: string;
  score_1_5: number | null;
  evidence: string[];
  open_questions: string[];
}

export interface LeanInterviewContext {
  brief: {
    raw_markdown: string;
  };
  interview: LeanFinding[];
}

// ==== Hilfsfunktionen zum Laden der Daten ====

async function loadInterview(interviewId: string): Promise<InterviewRow> {
  const { data, error } = await sb
    .from('interviews')
    .select(
      'id, user_id, domain_id, brief_id, interview_type, status, created_at, completed_at, scorecard_json',
    )
    .eq('id', interviewId)
    .single();

  if (error) throw error;
  if (!data) {
    throw new Error(`Kein Interview gefunden für id=${interviewId}`);
  }

  return data as unknown as InterviewRow;
}

async function loadBrief(briefId: string): Promise<BriefInfo> {
  const { data, error } = await sb
    .from('briefs')
    .select('id, domain_id, title, version, status, raw_markdown')
    .eq('id', briefId)
    .single();

  if (error) throw error;
  if (!data) {
    throw new Error(`Kein Brief gefunden für id=${briefId}`);
  }

  return data as unknown as BriefInfo;
}

async function loadDomain(domainId: string | null): Promise<DomainInfo | null> {
  if (!domainId) return null;

  const { data, error } = await sb
    .from('domains')
    .select('id, name, description')
    .eq('id', domainId)
    .single();

  if (error) {
    console.warn('Warnung: Konnte Domain nicht laden:', error.message);
    return null;
  }

  if (!data) return null;
  return data as unknown as DomainInfo;
}

async function loadAnswersForInterview(
  interviewId: string,
): Promise<AnswerRecord[]> {
  const { data, error } = await sb
    .from('answers')
    .select('id, answer_json, created_at, question_id')
    .eq('interview_id', interviewId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  if (!data || data.length === 0) return [];

  return data as unknown as AnswerRecord[];
}

// ---- Findings (voll) -------------------------------------------------

async function loadFullFindingsForBrief(
  briefId: string,
): Promise<FindingForInterview[]> {
  const { data, error } = await sb
    .from('brief_sheet_findings')
    .select(
      `
      id,
      brief_id,
      sheet_id,
      question_id,
      finding_json,
      sheet:overleitung_sheets (
        id,
        name,
        theme
      ),
      question:sheet_questions (
        id,
        code,
        question,
        checkpoints
      )
    `,
    )
    .eq('brief_id', briefId);

  if (error) throw error;
  if (!data || data.length === 0) return [];

  const result: FindingForInterview[] = [];

  for (const row of data as any[]) {
    if (!row.sheet || !row.question) {
      console.warn(
        'Warnung: Finding ohne Sheet oder Question, wird übersprungen:',
        row.id,
      );
      continue;
    }

    // Sanity-Check: FK question_id muss zum Join passen
    if (row.question.id !== row.question_id) {
      console.warn(
        'Inkonsistenter FK question_id vs. question.id bei Finding',
        row.id,
        row.question_id,
        row.question.id,
      );
      continue;
    }

    const fj = row.finding_json ?? {};
    const inner = fj.finding ?? fj;

    const status =
      typeof inner.status === 'string' ? inner.status : null;

    const score_1_5 =
      typeof inner.score_1_5 === 'number'
        ? inner.score_1_5
        : typeof inner.score === 'number'
        ? inner.score
        : null;

    const rationale =
      typeof inner.rationale === 'string' ? inner.rationale : null;

    const questionText =
      typeof fj.question === 'string'
        ? fj.question
        : row.question.question;

    const questionCode =
      typeof fj.question_code === 'string'
        ? fj.question_code
        : row.question.code;

    const checkpoints =
      Array.isArray(fj.checkpoints) && fj.checkpoints.length > 0
        ? fj.checkpoints
        : row.question.checkpoints ?? [];

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

    result.push({
      id: row.id,
      sheet_id: row.sheet.id,
      sheet_name: row.sheet.name,
      theme: row.sheet.theme,
      question_id: row.question.id,
      question_code: questionCode,
      question: questionText,
      checkpoints,
      status,
      score_1_5,
      rationale,
      evidence,
      open_questions,
    });
  }

  return result;
}

// ==== Hauptfunktion: Ausführlicher Interview-Kontext ====

export async function loadInterviewContext(
  interviewId: string,
): Promise<InterviewContext> {
  const interview = await loadInterview(interviewId);

  const [brief, domain, findings, answers] = await Promise.all([
    loadBrief(interview.brief_id),
    loadDomain(interview.domain_id),
    loadFullFindingsForBrief(interview.brief_id),
    loadAnswersForInterview(interview.id),
  ]);

  return {
    interview,
    user: { id: interview.user_id },
    domain,
    brief,
    findings,
    answers,
  };
}

// ==== Schlanke Variante für Flowise / LLM ====

export async function loadLeanInterviewContext(
  interviewId: string,
): Promise<LeanInterviewContext> {
  const interview = await loadInterview(interviewId);
  const brief = await loadBrief(interview.brief_id);
  const fullFindings = await loadFullFindingsForBrief(interview.brief_id);

  const leanFindings: LeanFinding[] = fullFindings.map((f) => ({
    question: f.question,
    score_1_5: f.score_1_5,
    evidence: f.evidence,
    open_questions: f.open_questions,
  }));

  return {
    brief: {
      raw_markdown: brief.raw_markdown,
    },
    interview: leanFindings,
  };
}

// ==== Optionaler CLI-Entry zum Testen (Lean-Kontext) ====

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  const interviewId = process.argv[2];

  if (!interviewId) {
    console.error(
      'Usage: pnpm -F @datareus/brief-parser run interview-context <interviewId>',
    );
    process.exit(1);
  }

  loadLeanInterviewContext(interviewId)
    .then((ctx) => {
      console.log(JSON.stringify(ctx, null, 2));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}