import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import { fileURLToPath, pathToFileURL } from 'url'
import { db as sb } from './db/provider';
import { createChatCompletion, defaultLlmModel } from './llm/provider';

// Aggregator wiederverwenden
import { aggregateBriefSheetEvidence } from './aggregate_brief_sheet'
import { parseBriefForSheet } from './parse_brief'


// === Pfade & ENV wie in parse_brief ===
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(PKG_ROOT, rel), 'utf8')

dotenv.config({ path: path.join(PKG_ROOT, '.env') })


const MODEL = defaultLlmModel;



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

  const resp = await createChatCompletion({
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
    // 1) Baseline-Findings aus dem aktuellen Steckbrief erzeugen/aktualisieren.
    // Die Scorecard baut auf brief_sheet_findings auf; ohne diesen Schritt
    // hätte eine erste Auswertung keine Baseline.
    await parseBriefForSheet(briefId, sheetId)

    // 2) Evidenz aggregieren (Steckbrief + findings + Interviews + Antworten)
    const aggregate = await aggregateBriefSheetEvidence(briefId, sheetId)

    // 3) Scorecard berechnen
    const scorecard = await callScorecardLLM(aggregate)

    // 4) Scorecard in brief_sheet_evaluations speichern
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
