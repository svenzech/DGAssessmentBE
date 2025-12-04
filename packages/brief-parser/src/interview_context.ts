import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ==== Pfade & .env laden (wie bei den anderen Skripten) ====

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

// ==== Typen für den Interview-Kontext ====

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

export interface FindingForInterview {
  id: string;
  sheet_id: string;
  sheet_name: string;
  theme: string;
  question_id: string;
  question_code: string;
  question: string;
  checkpoints: string[];
  //finding: any;
}

export interface AnswerRecord {
  id: string;
  question_id: string | null;
  answer_json: any;
  created_at: string;
}

export interface InterviewContext {
  interview: InterviewRow;
  user: {
    id: string;
  };
  domain: DomainInfo | null;
  brief: BriefInfo;
  findings: FindingForInterview[];
  answers: AnswerRecord[];
}

// ==== "Lean" Typen für Flowise / LLM-Kontext ====

export interface LeanFinding {
  id: string;
  sheet_id: string;
  sheet_name: string;
  theme: string;
  question_id: string;
  question_code: string;
  question: string;

  status: string | null;
  score_1_5: number | null;
  rationale: string | null;
  evidence: string[];        // nur die Zitate / Belege
  open_questions: string[];  // Nachfragen an den Interviewpartner
}

export interface LeanInterviewContext {
  brief: {
    id: string;
    title: string | null;
    raw_markdown: string;
    version: number | null;
  };
  findings: LeanFinding[];
}

export interface LeanAnswer {
  ts: string | null;
  user_answer: string | null;
  llm_status: string | null;
  question_hint: string | null;
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

  if (error) {
    throw error;
  }
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

  if (error) {
    throw error;
  }
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

async function loadFindingsForBrief(
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

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return [];
  }

  const result: FindingForInterview[] = [];

  for (const row of data as any[]) {
    if (!row.sheet || !row.question) {
      console.warn(
        'Warnung: Finding ohne Sheet oder Question, wird übersprungen:',
        row.id,
      );
      continue;
    }

    result.push({
      id: row.id,
      sheet_id: row.sheet.id,
      sheet_name: row.sheet.name,
      theme: row.sheet.theme,
      question_id: row.question.id,
      question_code: row.question.code,
      question: row.question.question,
      checkpoints: row.question.checkpoints || [],
      // finding: row.finding_json,
    });
  }

  return result;
}

async function loadAnswersForInterview(
  interviewId: string,
): Promise<AnswerRecord[]> {
  const { data, error } = await sb
    .from('answers')
    .select('id, answer_json, created_at')
    .eq('interview_id', interviewId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return [];
  }

  return data as unknown as AnswerRecord[];
}

// ==== Hauptfunktion: Voller InterviewContext ====

export async function loadInterviewContext(
  interviewId: string,
): Promise<InterviewContext> {
  const interview = await loadInterview(interviewId);

  const [brief, domain, findings, answers] = await Promise.all([
    loadBrief(interview.brief_id),
    loadDomain(interview.domain_id),
    loadFindingsForBrief(interview.brief_id),
    loadAnswersForInterview(interview.id),
  ]);

  const context: InterviewContext = {
    interview,
    user: {
      id: interview.user_id,
    },
    domain,
    brief,
    findings,
    answers,
  };

  return context;
}

// ==== Schlanke Variante für Flowise / LLM ====

async function loadLeanFindingsForBrief(briefId: string): Promise<LeanFinding[]> {
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
        question
      )
    `,
    )
    .eq('brief_id', briefId);

  if (error) throw error;
  if (!data || data.length === 0) return [];

  const result: LeanFinding[] = [];

  for (const row of data as any[]) {
    if (!row.sheet || !row.question) {
      console.warn(
        'Warnung: Finding ohne Sheet oder Question, wird übersprungen:',
        row.id,
      );
      continue;
    }

    const fj = row.finding_json ?? {};

    result.push({
      id: row.id,
      sheet_id: row.sheet.id,
      sheet_name: row.sheet.name,
      theme: row.sheet.theme,
      question_id: row.question.id,
      question_code: row.question.code,
      question: row.question.question,

      status: typeof fj.status === 'string' ? fj.status : null,
      score_1_5:
        typeof fj.score_1_5 === 'number' ? fj.score_1_5 : null,
      rationale:
        typeof fj.rationale === 'string' ? fj.rationale : null,
      evidence: Array.isArray(fj.evidence)
        ? fj.evidence.map((e: any) =>
            typeof e === 'string'
              ? e
              : typeof e.quote === 'string'
              ? e.quote
              : JSON.stringify(e),
          )
        : [],
      open_questions: Array.isArray(fj.open_questions)
        ? fj.open_questions.map((q: any) => String(q))
        : [],
    });
  }

  return result;
}


export async function loadLeanInterviewContext(
  interviewId: string,
): Promise<LeanInterviewContext> {
  // 1) Interview nur, um brief_id zu bekommen
  const interview = await loadInterview(interviewId);

  // 2) Steckbrief + Findings parallel laden
  const [brief, findings] = await Promise.all([
    loadBrief(interview.brief_id),
    loadLeanFindingsForBrief(interview.brief_id),
  ]);

  return {
    brief: {
      id: brief.id,
      title: brief.title,
      raw_markdown: brief.raw_markdown,
      version: brief.version ?? null,
    },
    findings,
  };
}

// ==== Optionaler CLI-Entry zum Testen ====

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