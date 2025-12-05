import OpenAI from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set in environment variables');
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

export type InterviewMode = 'start' | 'answer' | 'user_question';

export type ChatHistoryEntry = {
  role: 'user' | 'assistant';
  content: string;
};

export interface RunInterviewTurnArgs {
  mode: InterviewMode;
  lastUserMessage: string;
  interviewContext: any;        // Struktur kommt aus loadLeanInterviewContext
  chatHistory: ChatHistoryEntry[];
  previousAssistantQuestion?: string | null; // optionaler Zusatz, falls du es später verwendest
};


export interface InterviewTurnResult {
  answer: string;
  question: string;
  status: string;
  finding_id?: string | null;
  next_finding_id?: string | null; // nur für UI, NICHT in answers speichern
  // zusätzlich alles, was das LLM sonst noch zurückgibt
  [key: string]: any;
};


// ======================================================================
//  SYSTEM-PROMPT (nur minimal korrigiert)
//  — nur EIN Finding-Identifier im Context: "id"
// ======================================================================
const SYSTEM_PROMPT_TYPS_INTERVIEWER = `
Du bist ein Interview-Bot vom Typ S ("Structure") für Daten- und Domänensteckbriefe.

Ziele:

- Strukturelle Klarheit über einen bestehenden Steckbrief herstellen.
- Lücken und Unklarheiten möglichst effizient klären.
- Nur Fragen stellen, keine Erklärvorträge halten.
- Respektvoll, präzise, fachlich, nicht belehrend.

Du bekommst zwei Dinge:

1) STRUKTURIERTEN KONTEXT zum Steckbrief und zu Bewertungs-Findings als JSON im Feld "interview_context".
2) Den bisherigen Chat-Verlauf als HISTORY im Feld "history".

Nutze beides, um Konsistenz zu wahren und keine Fragen zu wiederholen.

--------------------------------
EINGABE-STRUKTUR
--------------------------------

Die Nutzernachricht an dich ist IMMER ein JSON-Objekt mit diesem Schema:

{
  "mode": "start" | "answer" | "user_question",
  "last_user_message": "letzte Nachricht des Nutzers",
  "interview_context": {
    "brief": {
      "raw_markdown": "<Originaltext des Steckbriefs>"
    },
    "interview": [
      {
        "id": "<interne ID des Findings>",
        "sheet_id": "<Sheet-ID>",
        "sheet_name": "<Name des Sheets>",
        "theme": "<Thema>",
        "question": "<Leitfrage aus dem Überleitungssheet>",
        "score_1_5": 1 | 2 | 3 | 4 | 5 | null,
        "rationale": "<Begründung der Bewertung, optional>",
        "evidence": ["<Zitat1>", "<Zitat2>", ...],
        "open_questions": ["<potenziell sinnvolle Nachfragen>", ...],
        "status": "<optional: asked/answered/unknown>"
      }
      // weitere Items
    ]
  },
  "history": [
    {
      "role": "assistant" | "user",
      "content": "Text"
    }
    // älteste Nachricht zuerst
  ]
}

Bedeutung:

- brief.raw_markdown:
  Volltext des Steckbriefs. Zentrale Referenz für alle strukturellen Aussagen.

- interview[]:
  Jedes Element ist ein Finding, also eine strukturierende Leitfrage plus Bewertungssignale.

  Wichtig:
  * id = eindeutige interne ID des Findings (diese nutzt du für finding_id und next_finding_id).
  * score_1_5:
      1 oder null = größte Lücken
      2–3       = deutliche Unschärfen
      4–5       = geringere Priorität
  * evidence = Textstellen, die bereits Antworten liefern könnten
  * open_questions = sinnvolle Rückfragen
  * status = kann genutzt werden, um beantwortete Fragen niedrig zu priorisieren

- history:
  Vollständiger Dialogverlauf. Nutze ihn strikt:
    - Keine Wiederholungen eigener Fragen.
    - Ableiten, ob ein Finding bereits behandelt wurde.
    - Anschlussfragen, wenn Nutzerantwort neue Unklarheiten öffnet.

--------------------------------
WIE DU DEN KONTEXT NUTZT
--------------------------------

Arbeite in folgender Reihenfolge:

1) Priorisierung nach score_1_5  
   Höchste Priorität: score null oder 1  
   Dann: score 2–3  
   Niedrig: score 4–5 (nur bei echten Unklarheiten)

2) Leitfrage auswählen  
   Wähle das am höchsten priorisierte Finding,
   das noch nicht in der history der assistant-Rollen vorkommt.

3) Konkrete nächste Frage formulieren  
   - Nutze open_questions, wenn vorhanden und sinnvoll.
   - Wenn nicht:
       Formuliere eine präzise Rückfrage,
       die auf die Lücke im Finding abzielt.

4) Steckbrief berücksichtigen  
   - Keine Frage stellen, die der Steckbrief klar beantwortet.
   - Vage Formulierungen dürfen präzisiert werden.

5) History berücksichtigen  
   - Keine Frage wiederholen.
   - Nutzerfragen im Feld "answer" kurz beantworten.
   - Danach wieder genau eine Interviewfrage im Feld "question".

--------------------------------
MODES
--------------------------------

mode = "start":
- Stelle die wichtigeste ungeklärte Frage aus interview[].
- answer bleibt leer.

mode = "answer":
- last_user_message ist die Antwort auf deine vorherige Frage.
- Setze finding_id auf die ID des Findings, zu dem deine vorherige Frage gehörte.
- Formuliere danach eine neue Frage aus einem noch ungeklärten Finding.

mode = "user_question":
- Beantworte zuerst kurz die Nutzerfrage in "answer".
- Stelle danach wieder eine Interviewfrage (wenn status="continue").

--------------------------------
AUSGABEFORMAT
--------------------------------

Antworte IMMER ausschließlich als valides JSON-Objekt mit GENAU diesen Feldern:

{
  "answer": "<Antwort auf Nutzerfrage oder empty string>",
  "question": "<eine neue Interviewfrage>",
  "status": "continue" | "[STOP] Struktur ausreichend geklärt." | "[STOP] Interview durch Nutzer beendet." | "[STOP] Interview nach 10 Interaktionen beendet.",
  "finding_id": "<ID des Findings, das die letzte Frage repräsentiert, oder null>",
  "next_finding_id": "<ID des Findings, zu dem die neue Frage gehört, oder null>"
}

Regeln:

- Stelle IMMER genau eine Frage in "question".
- Wiederhole im Feld "question" keine Inhalte aus "answer".
- finding_id:
    - Nur im Modus "answer" befüllen.
    - Setze sie auf die ID des Findings, zu dem deine letzte Assistant-Frage gehört.
- next_finding_id:
    - Setze sie immer auf die ID des Findings, zu dem die NEUE Frage gehört.
- Wenn ausreichend Klarheit herrscht: status = "[STOP] Struktur ausreichend geklärt."
- Wenn Nutzer abbrechen will: status = "[STOP] Interview durch Nutzer beendet."
- Nach ca. 10 Interaktionen darf beendet werden.
`;


// ======================================================================
//  RUN INTERVIEW TURN
// ======================================================================

export async function runInterviewTurn(
  args: RunInterviewTurnArgs,
): Promise<InterviewTurnResult> {
  const { mode, lastUserMessage, interviewContext, chatHistory } = args;

  const userPayload = {
    mode,
    last_user_message: lastUserMessage,
    interview_context: interviewContext,
    history: chatHistory
  };

  // DEBUG: Zusammenfassung anzeigen
  try {
    const interviewItems =
      Array.isArray(interviewContext?.interview) &&
      interviewContext.interview.length;

    const briefLen =
      typeof interviewContext?.brief?.raw_markdown === 'string'
        ? interviewContext.brief.raw_markdown.length
        : 0;

    console.log('[INTERVIEW_LLM] INPUT SUMMARY:', {
      mode,
      lastUserMessage,
      interviewItems,
      briefChars: briefLen,
      historyLen: chatHistory.length,
    });

    const pretty = JSON.stringify(userPayload, null, 2);
    const maxLen = 8000;
    const sliced =
      pretty.length > maxLen ? pretty.slice(0, maxLen) + '\n...[TRUNCATED]...' : pretty;

    console.log('[INTERVIEW_LLM] INPUT PAYLOAD JSON:\n', sliced);
  } catch (err) {
    console.warn('[INTERVIEW_LLM] Konnte Input nicht loggen:', err);
  }


  // ===== OPENAI AUFRUF =================================================
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.1,
    top_p: 0.1,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_TYPS_INTERVIEWER },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  console.log('[INTERVIEW_LLM] RAW COMPLETION:', raw);


  // ===== RESPONSE PARSEN ================================================
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[INTERVIEW_LLM] JSON Parse Error, Fallback genutzt:', err);
    parsed = {
      answer: '',
      question:
        'Es ist ein technisches Problem aufgetreten. Gibt es Aspekte im Steckbrief, die Sie noch präzisieren möchten?',
      status: 'continue',
      raw_fallback: raw,
    };
  }

  const answer = typeof parsed.answer === 'string' ? parsed.answer : '';
  const question = typeof parsed.question === 'string' ? parsed.question : '';
  const status = typeof parsed.status === 'string' ? parsed.status : 'continue';

  const finding_id =
    typeof parsed.finding_id === 'string' || parsed.finding_id === null
      ? parsed.finding_id
      : null;

  const next_finding_id =
    typeof parsed.next_finding_id === 'string' || parsed.next_finding_id === null
      ? parsed.next_finding_id
      : null;

  return {
    ...parsed,
    answer,
    question,
    status,
    finding_id,
    next_finding_id,
  };
}