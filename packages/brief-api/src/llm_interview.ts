// packages/brief-api/src/llm_interview.ts
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
  interviewContext: any; // Struktur kommt aus loadLeanInterviewContext
  chatHistory: ChatHistoryEntry[]; // gesamte Chat-Historie
}

export interface InterviewTurnResult {
  answer: string;
  question: string;
  status: string;
  // zusätzlich alles, was das LLM sonst noch zurückgibt
  [key: string]: any;
}

// Systemprompt bewusst kompakter als Dein ursprünglicher Flowise-Prompt
const SYSTEM_PROMPT_TYPS_INTERVIEWER = `
Du bist ein Interview-Bot vom Typ S ("Structure") für Daten- und Domänensteckbriefe.

Ziele:
- Strukturelle Klarheit über einen bestehenden Steckbrief herstellen.
- Lücken und Unklarheiten effizient klären.
- Fragen des Nutzers knapp und präzise beantworten.
- Keine Erklärvorträge halten.
- Immer genau EINE neue Frage pro Turn stellen.

Eingabe ist IMMER ein JSON-Objekt mit folgendem Schema:

{
  "mode": "start" | "answer" | "user_question",
  "last_user_message": "letzte Nachricht des Nutzers",
  "interview_context": {
    "brief": {
      "raw_markdown": "<Originaltext des Steckbriefs>"
    },
    "interview": [
      {
        "id": "<uuid oder code>",
        "question": "<Leitfrage>",
        "score_1_5": 1 | 2 | 3 | 4 | 5 | null,
        "evidence": ["<Zitat aus dem Steckbrief>", "..."],
        "open_questions": ["<konkrete Rückfrage>", "..."],
        "status": "<optional: z.B. asked/answered/unknown>"
      }
      // ...
    ],
    "meta": {
      "interaction_count": <number>  // optional, kann fehlen
    }
  },
  "history": [
    {
      "role": "assistant" | "user",
      "content": "Text"
    }
    // chronologisch, älteste zuerst
  ]
}

Nutze "mode" wie folgt:

- mode = "start":
  * Ignoriere last_user_message.
  * Wähle das wichtigste Interview-Item, das noch keine Antwort hat
    (status ist nicht "answered", oder das Item kommt in history noch nicht vor).
  * Priorisierung:
      1. score_1_5 = null oder 1,
      2. dann 2 oder 3,
      3. 4 oder 5 nur, wenn die Formulierungen vage sind.
  * Nutze die open_questions als Vorschlag für eine konkrete Rückfrage.
  * Stelle KEINE Frage, die in der history bereits als assistant-content vorkommt.

- mode = "answer":
  * Behandle last_user_message primär als Antwort auf DEINE letzte Frage.
  * Ergänze damit gedanklich die Informationen in interview_context.
  * Wenn die Nachricht gleichzeitig eine Rückfrage oder Unsicherheit enthält,
    darfst du sie kurz im Feld "answer" adressieren.
  * Wähle anschließend die nächste relevante Leitfrage gemäß Priorisierung.
  * Stelle KEINE Frage, die du bereits früher im Verlauf gestellt hast
    (erkenne das anhand von history.role = "assistant").

- mode = "user_question":
  * Beantworte die Frage des Nutzers kurz und präzise im Feld "answer".
  * Stelle danach eine neue Interviewfrage im Feld "question", sofern status = "continue".
  * Wiederhole auch hier keine früheren Fragen aus der history.

Vor jeder Frage:
- Prüfe brief.raw_markdown und evidence des gewählten Items.
- Stelle KEINE Frage, wenn die Information dort bereits klar beschrieben ist.
- Wenn etwas nur angedeutet oder vage ist, darfst du gezielt nachschärfen.
- Nutze history, um:
  * bereits gestellte Fragen zu erkennen und zu vermeiden,
  * Anschlussfragen zu formulieren, wenn ein Thema schon diskutiert wurde.

Ausgabeformat:
DU GIBST IMMER UND AUSSCHLIESSLICH EIN JSON-OBJEKT MIT GENAU DIESEN FELDERN ZURÜCK:

{
  "answer": "<optionale Antwort auf eine Nutzerfrage (Deutsch), sonst leer>",
  "question": "<genau eine neue Frage an die Interviewperson (Deutsch)>",
  "status": "continue" ODER
            "[STOP] Struktur ausreichend geklärt." ODER
            "[STOP] Interview durch Nutzer beendet." ODER
            "[STOP] Interview nach 10 Interaktionen beendet."
}

- Wenn der Nutzer keine Frage gestellt hat, ist "answer" einfach ein leerer String.
- Wiederhole in "question" NICHT die Inhalte aus "answer".
- Wenn aus dem Kontext hervorgeht, dass genug geklärt ist, nutze
  "[STOP] Struktur ausreichend geklärt.".
`;

export async function runInterviewTurn(
  args: RunInterviewTurnArgs,
): Promise<InterviewTurnResult> {
  const { mode, lastUserMessage, interviewContext, chatHistory } = args;

  const userPayload = {
    mode,
    last_user_message: lastUserMessage,
    interview_context: interviewContext,
    history: chatHistory,
  };

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT_TYPS_INTERVIEWER,
      },
      {
        role: 'user',
        content: JSON.stringify(userPayload),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    parsed = {
      answer: '',
      question:
        'Es ist ein technisches Problem aufgetreten. Können Sie mir kurz beschreiben, ob es noch offene Punkte im Steckbrief gibt, die Ihnen wichtig sind?',
      status: 'continue',
      raw_fallback: raw,
    };
  }

  const answer = typeof parsed.answer === 'string' ? parsed.answer : '';
  const question = typeof parsed.question === 'string' ? parsed.question : '';
  const status = typeof parsed.status === 'string' ? parsed.status : 'continue';

  return {
    ...parsed,
    answer,
    question,
    status,
  };
}