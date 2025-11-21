import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import { fileURLToPath, pathToFileURL } from 'url'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// Aggregator wiederverwenden
import { aggregateBriefSheetEvidence } from './aggregate_brief_sheet'


// === Pfade & ENV wie in parse_brief ===
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(PKG_ROOT, rel), 'utf8')

dotenv.config({ path: path.join(PKG_ROOT, '.env') })

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});


const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini-2025-04-14'

if (!OPENAI_API_KEY) {
  console.error('Missing env var: OPENAI_API_KEY')
  process.exit(1)
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// Optional eigenes Prompt-Template für Scorecards
const SCORECARD_PROMPT = read('prompts/brief_scorecard.de.txt')

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/**
 * Zentrales LLM für die Scorecard:
 * - nimmt das Aggregat (Steckbrief + Findings + Interviews)
 * - gibt eine Scorecard im definierten JSON-Format zurück
 */
async function callScorecardLLM(aggregateJson: any) {
  const promptHash = sha256(SCORECARD_PROMPT).slice(0, 16)

  const resp = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: SCORECARD_PROMPT
      },
      {
        role: 'user',
        content:
          '<<AGGREGATE_EVIDENCE_JSON>>\n' +
          JSON.stringify(aggregateJson, null, 2) +
          '\n\n' +
          'Erzeuge ausschließlich die beschriebene SCORECARD als valides JSON-Objekt.'
      }
    ]
  })

  const out = resp.choices[0]?.message?.content ?? ''
  let json: any
  try {
    json = JSON.parse(out)
  } catch (e) {
    throw new Error('LLM lieferte kein valides JSON (Scorecard):\n' + out)
  }

  console.log('Scorecard LLM meta:', { model: MODEL, prompt_hash: promptHash })
  return json
}

/**
 * High-Level API:
 *  - nimmt briefId + sheetId
 *  - aggregiert alle Evidenzen
 *  - lässt das LLM eine Scorecard berechnen
 *  - gibt die Scorecard zurück (Persistenz kann später ergänzt werden)
 */
export async function evaluateBriefSheet(briefId: string, sheetId: string) {
    // 1) Evidenz aggregieren (Steckbrief + findings + Interviews + Antworten)
    const aggregate = await aggregateBriefSheetEvidence(briefId, sheetId)

    // 2) Scorecard berechnen
    const scorecard = await callScorecardLLM(aggregate)

    // 3) Scorecard in brief_sheet_evaluations speichern
    const { data: insertedEval, error: evalErr } = await sb
    .from('brief_sheet_evaluations')
    .insert({
        brief_id: briefId,
        sheet_id: sheetId,
        source: 'scorecard_v1',      // ggf. später versionieren (z.B. mit Modell/PROMPT-Hash)
        scorecard_json: scorecard
    })
    .select('id, created_at')
    .single();

    if (evalErr || !insertedEval) {
    console.error('Fehler beim Speichern der Scorecard in brief_sheet_evaluations:', evalErr);
    // Du kannst hier entweder werfen oder "nur" loggen – ich würde hart failen:
    throw new Error('Scorecard konnte nicht persistiert werden');
    }

    // Optional: kleine Log-Zeile
    console.log(
    `Scorecard gespeichert in brief_sheet_evaluations mit id=${insertedEval.id}, created_at=${insertedEval.created_at}`
    );

    // Und wie bisher: Scorecard nach außen zurückgeben / ausgeben
    return scorecard;

}

// === CLI-Entry, nur wenn direkt ausgeführt ===
const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  const briefId = process.argv[2]
  const sheetId = process.argv[3]

  if (!briefId || !sheetId) {
    console.error(
      'Usage: pnpm -F @datareus/brief-parser run evaluate-brief-sheet <briefId> <sheetId>'
    )
    process.exit(1)
  }

  evaluateBriefSheet(briefId, sheetId)
    .then((scorecard) => {
      console.log(JSON.stringify(scorecard, null, 2))
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}