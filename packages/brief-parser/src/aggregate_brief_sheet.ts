import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'url'
import { db as sb } from './db/provider';

// === Setup wie in parse_brief.ts ==============================

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, '..')

dotenv.config({ path: path.join(PKG_ROOT, '.env') })




// === Typen für das Aggregat ===================================

export interface AggregatedBriefSheetEvidence {
  brief_id: string
  sheet_id: string

  brief: {
    id: string
    title: string | null
    domain_id: string | null
    raw_markdown: string
    status: string | null
  }

  sheet: {
    id: string
    name: string
    theme: string
    status: string
    version: string | null
  }

  // Zeitbereich über alle Antworten
  answer_range: {
    min_ts: string | null
    max_ts: string | null
  }

  // Eine Zeile pro Leitfrage
  questions: AggregatedQuestionEvidence[]

  // Alle Interviews, die in dieses Aggregat eingeflossen sind
  interviews: AggregatedInterviewMeta[]
}

export interface AggregatedQuestionEvidence {
  question_id: string
  question_code: string
  question: string
  checkpoints: string[]

  // Baseline-Finding aus brief_sheet_findings.finding_json (Parser-Ergebnis aus dem Steckbrief)
  baseline_finding: any | null

  // Alle Interview-Antworten, die zu dieser Leitfrage gehören
  interview_answers: AggregatedAnswer[]
}

export interface AggregatedInterviewMeta {
  id: string
  user_id: string
  interview_type: string
  status: string
  created_at: string | null
  completed_at: string | null
}

export interface AggregatedAnswer {
  answer_id: string
  interview_id: string
  created_at: string
  // Rohdaten – das LLM kann später daraus Question-Mapping, Relevanz, etc. ableiten
  answer_json: any
}

// === Hilfsfunktionen für Queries ===============================

async function loadBrief(briefId: string) {
  const { data, error } = await sb
    .from('briefs')
    .select('id, title, domain_id, raw_markdown, status')
    .eq('id', briefId)
    .single()

  if (error || !data) {
    throw new Error(`Brief ${briefId} not found: ${error?.message}`)
  }

  if (!data.raw_markdown) {
    throw new Error(`Brief ${briefId} hat kein raw_markdown`)
  }

  return data as {
    id: string
    title: string | null
    domain_id: string | null
    raw_markdown: string
    status: string | null
  }
}

async function loadSheet(sheetId: string) {
  const { data, error } = await sb
    .from('overleitung_sheets')
    .select('id, name, theme, status, version')
    .eq('id', sheetId)
    .single()

  if (error || !data) {
    throw new Error(`Sheet ${sheetId} not found: ${error?.message}`)
  }

  return data as {
    id: string
    name: string
    theme: string
    status: string
    version: string | null
  }
}

async function loadQuestions(sheetId: string) {
  const { data, error } = await sb
    .from('sheet_questions')
    .select('id, code, question, checkpoints, order_index, active')
    .eq('sheet_id', sheetId)
    .eq('active', true)
    .order('order_index', { ascending: true })

  if (error) {
    throw new Error(`Fehler beim Laden der sheet_questions für Sheet ${sheetId}: ${error.message}`)
  }

  return (
    (data as {
      id: string
      code: string
      question: string
      checkpoints: string[] | null
      order_index: number
      active: boolean
    }[]) ?? []
  )
}

async function loadBaselineFindings(briefId: string, sheetId: string) {
  const { data, error } = await sb
    .from('brief_sheet_findings')
    .select('question_id, finding_json')
    .eq('brief_id', briefId)
    .eq('sheet_id', sheetId)

  if (error) {
    throw new Error(
      `Fehler beim Laden von brief_sheet_findings für Brief ${briefId}, Sheet ${sheetId}: ${error.message}`
    )
  }

  const map = new Map<string, any>()
  for (const row of (data as any[]) ?? []) {
    if (row.question_id) {
      map.set(row.question_id as string, row.finding_json)
    }
  }
  return map
}

async function loadInterviewsForBrief(briefId: string) {
  const { data, error } = await sb
    .from('interviews')
    .select('id, user_id, interview_type, status, created_at, completed_at')
    .eq('brief_id', briefId)

  if (error) {
    throw new Error(`Fehler beim Laden der Interviews für Brief ${briefId}: ${error.message}`)
  }

  return (
    (data as {
      id: string
      user_id: string
      interview_type: string
      status: string
      created_at: string | null
      completed_at: string | null
    }[]) ?? []
  )
}

async function loadAnswersForInterviews(interviewIds: string[]) {
  if (interviewIds.length === 0) return []

  const { data, error } = await sb
    .from('answers')
    .select('id, interview_id, created_at, answer_json')
    .in('interview_id', interviewIds)

  if (error) {
    throw new Error(`Fehler beim Laden der answers: ${error.message}`)
  }

  return (
    (data as {
      id: string
      interview_id: string
      created_at: string
      answer_json: any
    }[]) ?? []
  )
}

// === zentrale Aggregationsfunktion =============================

export async function aggregateBriefSheetEvidence(
  briefId: string,
  sheetId: string
): Promise<AggregatedBriefSheetEvidence> {
  // 1) Grunddaten
  const brief = await loadBrief(briefId)
  const sheet = await loadSheet(sheetId)
  const questions = await loadQuestions(sheetId)
  const baselineMap = await loadBaselineFindings(briefId, sheetId)

  // 2) Interviews + Antworten
  const interviews = await loadInterviewsForBrief(briefId)
  const interviewIds = interviews.map((i) => i.id)
  const answers = await loadAnswersForInterviews(interviewIds)

  // 3) Answer-Range bestimmen
  let minTs: string | null = null
  let maxTs: string | null = null
  for (const a of answers) {
    const ts = a.created_at
    if (!ts) continue
    if (!minTs || ts < minTs) minTs = ts
    if (!maxTs || ts > maxTs) maxTs = ts
  }

  // 4) Interview-Antworten grob nach Frage-Codes gruppieren (falls answer_json.question_code existiert)
  //    Wenn eine Antwort keinen question_code hat, hängen wir sie später an alle Fragen dran (oder ignorieren sie – vorerst: ignorieren)
  const answersByQuestionCode = new Map<string, AggregatedAnswer[]>()

  for (const a of answers) {
    // Annahme: der Chat speichert in answer_json ein Feld question_code,
    // das mit sheet_questions.code übereinstimmt.
    const code = (a.answer_json && a.answer_json.question_code) as string | undefined

    const base: AggregatedAnswer = {
      answer_id: a.id,
      interview_id: a.interview_id,
      created_at: a.created_at,
      answer_json: a.answer_json
    }

    if (code) {
      const list = answersByQuestionCode.get(code) ?? []
      list.push(base)
      answersByQuestionCode.set(code, list)
    } else {
      // Für den Moment ignorieren wir Antworten ohne question_code;
      // später könnten wir sie separat in die LLM-Eingabe hängen.
      // console.warn('Antwort ohne question_code, wird nicht einer konkreten Leitfrage zugeordnet:', a.id)
    }
  }

  // 5) Aufbau der Aggregationsstruktur pro Leitfrage
  const questionAggregates: AggregatedQuestionEvidence[] = questions.map((q) => {
    const baseline = baselineMap.get(q.id) ?? null
    const answersForQuestion = answersByQuestionCode.get(q.code) ?? []

    return {
      question_id: q.id,
      question_code: q.code,
      question: q.question,
      checkpoints: (q.checkpoints as string[] | null) ?? [],
      baseline_finding: baseline,
      interview_answers: answersForQuestion
    }
  })

  // 6) Interview-Meta für das Ergebnis
  const interviewsMeta: AggregatedInterviewMeta[] = interviews.map((i) => ({
    id: i.id,
    user_id: i.user_id,
    interview_type: i.interview_type,
    status: i.status,
    created_at: i.created_at,
    completed_at: i.completed_at
  }))

  // 7) finales Aggregat zurückgeben
  return {
    brief_id: briefId,
    sheet_id: sheetId,
    brief,
    sheet,
    answer_range: {
      min_ts: minTs,
      max_ts: maxTs
    },
    questions: questionAggregates,
    interviews: interviewsMeta
  }
}

// === CLI-Entry zum Testen ======================================

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  const briefId = process.argv[2]
  const sheetId = process.argv[3]

  if (!briefId || !sheetId) {
    console.error('Usage: pnpm -F @datareus/brief-parser run aggregate-brief-sheet <briefId> <sheetId>')
    process.exit(1)
  }

  aggregateBriefSheetEvidence(briefId, sheetId)
    .then((agg) => {
      console.log(JSON.stringify(agg, null, 2))
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}