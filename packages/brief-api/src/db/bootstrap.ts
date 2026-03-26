type SqlDialect = 'postgres' | 'azure_sql';

type QueryFn = (sql: string, params?: any[]) => Promise<void>;

const DEFAULT_DOMAIN_ID = '00000000-0000-0000-0000-000000000000';
const BUSINESS_IMPACT_SHEET_ID = 'sheet-business-impact-v1';

const POSTGRES_SCHEMA_SQL: string[] = [
  `
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
  `
CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  title TEXT NULL,
  status TEXT NULL,
  version INTEGER NULL,
  raw_markdown TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
  `
CREATE INDEX IF NOT EXISTS idx_briefs_domain_id ON briefs(domain_id);
`,
  `
CREATE TABLE IF NOT EXISTS overleitung_sheets (
  id TEXT PRIMARY KEY,
  name TEXT NULL,
  theme TEXT NULL,
  status TEXT NULL,
  version INTEGER NULL,
  theme_target_description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
  `
CREATE TABLE IF NOT EXISTS sheet_questions (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES overleitung_sheets(id),
  code TEXT NULL,
  question TEXT NULL,
  checkpoints JSONB NULL,
  order_index INTEGER NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
  `
CREATE INDEX IF NOT EXISTS idx_sheet_questions_sheet_id_order
  ON sheet_questions(sheet_id, order_index);
`,
  `
CREATE TABLE IF NOT EXISTS brief_sheet_findings (
  id TEXT PRIMARY KEY,
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  sheet_id TEXT NOT NULL REFERENCES overleitung_sheets(id),
  question_id TEXT NOT NULL REFERENCES sheet_questions(id),
  finding_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_brief_sheet_findings_triplet UNIQUE (brief_id, sheet_id, question_id)
);
`,
  `
CREATE TABLE IF NOT EXISTS brief_sheet_evaluations (
  id TEXT PRIMARY KEY,
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  sheet_id TEXT NOT NULL REFERENCES overleitung_sheets(id),
  source TEXT NULL,
  scorecard_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
  `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE
);
`,
  `
CREATE TABLE IF NOT EXISTS user_domain_map (
  user_id TEXT NOT NULL REFERENCES users(id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  PRIMARY KEY (user_id, domain_id)
);
`,
  `
CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  domain_id TEXT NULL REFERENCES domains(id),
  brief_id TEXT NOT NULL REFERENCES briefs(id),
  interview_type TEXT NULL,
  status TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  scorecard_json JSONB NULL
);
`,
  `
CREATE INDEX IF NOT EXISTS idx_interviews_user_status
  ON interviews(user_id, status, created_at DESC);
`,
  `
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id),
  question_id TEXT NULL REFERENCES sheet_questions(id),
  answer_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
  `
CREATE INDEX IF NOT EXISTS idx_answers_interview_created
  ON answers(interview_id, created_at);
`,
];

const POSTGRES_SEED_SQL: string[] = [
  `
INSERT INTO domains (id, name, description)
VALUES (
  '${DEFAULT_DOMAIN_ID}',
  'Default Domain',
  'Automatically created fallback domain'
)
ON CONFLICT (id) DO NOTHING;
`,
  `
INSERT INTO users (id, username)
VALUES
  ('user-datareusx', 'datareusx'),
  ('user-mtu', 'mtu')
ON CONFLICT (id) DO NOTHING;
`,
  `
INSERT INTO user_domain_map (user_id, domain_id)
VALUES
  ('user-datareusx', '${DEFAULT_DOMAIN_ID}'),
  ('user-mtu', '${DEFAULT_DOMAIN_ID}')
ON CONFLICT (user_id, domain_id) DO NOTHING;
`,
  `
INSERT INTO overleitung_sheets (id, name, theme, status, version, theme_target_description)
VALUES (
  '${BUSINESS_IMPACT_SHEET_ID}',
  'Business Impact v1',
  'Business Impact',
  'active',
  1,
  'Baseline sheet installed by bootstrap'
)
ON CONFLICT (id) DO NOTHING;
`,
  `
INSERT INTO sheet_questions (id, sheet_id, code, question, checkpoints, order_index, active)
VALUES
  (
    'bi-v1-q1',
    '${BUSINESS_IMPACT_SHEET_ID}',
    'BI-Q1',
    'Welches konkrete Business-Problem wird durch bessere Datenqualität gelöst?',
    '["Business Outcome klar benennen","Betroffene Stakeholder identifizieren","Erwartete Wirkung beschreiben"]'::jsonb,
    0,
    TRUE
  ),
  (
    'bi-v1-q2',
    '${BUSINESS_IMPACT_SHEET_ID}',
    'BI-Q2',
    'Welche Prozesse oder Entscheidungen werden durch dieses Datenprodukt verbessert?',
    '["Kritische Prozesse nennen","Entscheidungspunkte benennen","Abhängigkeiten sichtbar machen"]'::jsonb,
    1,
    TRUE
  ),
  (
    'bi-v1-q3',
    '${BUSINESS_IMPACT_SHEET_ID}',
    'BI-Q3',
    'Welche KPIs messen den Erfolg der Verbesserung?',
    '["Messbare KPI definieren","Baseline dokumentieren","Zielwert und Zeitbezug festlegen"]'::jsonb,
    2,
    TRUE
  ),
  (
    'bi-v1-q4',
    '${BUSINESS_IMPACT_SHEET_ID}',
    'BI-Q4',
    'Welche Risiken entstehen bei schlechter Datenqualität?',
    '["Risikofelder benennen","Auswirkungen quantifizieren","Priorisierung der Risiken"]'::jsonb,
    3,
    TRUE
  ),
  (
    'bi-v1-q5',
    '${BUSINESS_IMPACT_SHEET_ID}',
    'BI-Q5',
    'Wer trägt fachlich die Verantwortung für Nutzen und Qualität der Daten?',
    '["Verantwortliche Rolle definieren","Governance-Verankerung prüfen","Entscheidungsrechte klären"]'::jsonb,
    4,
    TRUE
  )
ON CONFLICT (id) DO NOTHING;
`,
];

const AZURE_SQL_SCHEMA_SQL: string[] = [
  `
IF OBJECT_ID(N'dbo.domains', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.domains (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    name NVARCHAR(255) NOT NULL UNIQUE,
    description NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
`,
  `
IF OBJECT_ID(N'dbo.briefs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.briefs (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    domain_id NVARCHAR(128) NOT NULL,
    title NVARCHAR(512) NULL,
    status NVARCHAR(64) NULL,
    version INT NULL,
    raw_markdown NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_briefs_domain FOREIGN KEY (domain_id) REFERENCES dbo.domains(id)
  );
END
`,
  `
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'idx_briefs_domain_id' AND object_id = OBJECT_ID(N'dbo.briefs')
)
BEGIN
  CREATE INDEX idx_briefs_domain_id ON dbo.briefs(domain_id);
END
`,
  `
IF OBJECT_ID(N'dbo.overleitung_sheets', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.overleitung_sheets (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    name NVARCHAR(512) NULL,
    theme NVARCHAR(512) NULL,
    status NVARCHAR(64) NULL,
    version INT NULL,
    theme_target_description NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
`,
  `
IF OBJECT_ID(N'dbo.sheet_questions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sheet_questions (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    sheet_id NVARCHAR(128) NOT NULL,
    code NVARCHAR(128) NULL,
    question NVARCHAR(MAX) NULL,
    checkpoints NVARCHAR(MAX) NULL,
    order_index INT NULL,
    active BIT NOT NULL DEFAULT 1,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_sheet_questions_sheet FOREIGN KEY (sheet_id) REFERENCES dbo.overleitung_sheets(id)
  );
END
`,
  `
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'idx_sheet_questions_sheet_id_order' AND object_id = OBJECT_ID(N'dbo.sheet_questions')
)
BEGIN
  CREATE INDEX idx_sheet_questions_sheet_id_order ON dbo.sheet_questions(sheet_id, order_index);
END
`,
  `
IF OBJECT_ID(N'dbo.brief_sheet_findings', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.brief_sheet_findings (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    brief_id NVARCHAR(128) NOT NULL,
    sheet_id NVARCHAR(128) NOT NULL,
    question_id NVARCHAR(128) NOT NULL,
    finding_json NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_bsf_brief FOREIGN KEY (brief_id) REFERENCES dbo.briefs(id),
    CONSTRAINT FK_bsf_sheet FOREIGN KEY (sheet_id) REFERENCES dbo.overleitung_sheets(id),
    CONSTRAINT FK_bsf_question FOREIGN KEY (question_id) REFERENCES dbo.sheet_questions(id),
    CONSTRAINT UQ_bsf_triplet UNIQUE (brief_id, sheet_id, question_id)
  );
END
`,
  `
IF OBJECT_ID(N'dbo.brief_sheet_evaluations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.brief_sheet_evaluations (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    brief_id NVARCHAR(128) NOT NULL,
    sheet_id NVARCHAR(128) NOT NULL,
    source NVARCHAR(128) NULL,
    scorecard_json NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_bse_brief FOREIGN KEY (brief_id) REFERENCES dbo.briefs(id),
    CONSTRAINT FK_bse_sheet FOREIGN KEY (sheet_id) REFERENCES dbo.overleitung_sheets(id)
  );
END
`,
  `
IF OBJECT_ID(N'dbo.users', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.users (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    username NVARCHAR(255) NOT NULL UNIQUE
  );
END
`,
  `
IF OBJECT_ID(N'dbo.user_domain_map', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.user_domain_map (
    user_id NVARCHAR(128) NOT NULL,
    domain_id NVARCHAR(128) NOT NULL,
    CONSTRAINT PK_user_domain_map PRIMARY KEY (user_id, domain_id),
    CONSTRAINT FK_udm_user FOREIGN KEY (user_id) REFERENCES dbo.users(id),
    CONSTRAINT FK_udm_domain FOREIGN KEY (domain_id) REFERENCES dbo.domains(id)
  );
END
`,
  `
IF OBJECT_ID(N'dbo.interviews', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.interviews (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    user_id NVARCHAR(128) NOT NULL,
    domain_id NVARCHAR(128) NULL,
    brief_id NVARCHAR(128) NOT NULL,
    interview_type NVARCHAR(64) NULL,
    status NVARCHAR(64) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    completed_at DATETIME2 NULL,
    scorecard_json NVARCHAR(MAX) NULL,
    CONSTRAINT FK_interviews_user FOREIGN KEY (user_id) REFERENCES dbo.users(id),
    CONSTRAINT FK_interviews_domain FOREIGN KEY (domain_id) REFERENCES dbo.domains(id),
    CONSTRAINT FK_interviews_brief FOREIGN KEY (brief_id) REFERENCES dbo.briefs(id)
  );
END
`,
  `
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'idx_interviews_user_status' AND object_id = OBJECT_ID(N'dbo.interviews')
)
BEGIN
  CREATE INDEX idx_interviews_user_status ON dbo.interviews(user_id, status, created_at DESC);
END
`,
  `
IF OBJECT_ID(N'dbo.answers', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.answers (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    interview_id NVARCHAR(128) NOT NULL,
    question_id NVARCHAR(128) NULL,
    answer_json NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_answers_interview FOREIGN KEY (interview_id) REFERENCES dbo.interviews(id),
    CONSTRAINT FK_answers_question FOREIGN KEY (question_id) REFERENCES dbo.sheet_questions(id)
  );
END
`,
  `
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'idx_answers_interview_created' AND object_id = OBJECT_ID(N'dbo.answers')
)
BEGIN
  CREATE INDEX idx_answers_interview_created ON dbo.answers(interview_id, created_at);
END
`,
];

const AZURE_SQL_SEED_SQL: string[] = [
  `
IF NOT EXISTS (SELECT 1 FROM dbo.domains WHERE id = '${DEFAULT_DOMAIN_ID}')
BEGIN
  INSERT INTO dbo.domains (id, name, description)
  VALUES (
    '${DEFAULT_DOMAIN_ID}',
    'Default Domain',
    'Automatically created fallback domain'
  );
END
`,
  `
IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE id = 'user-datareusx')
BEGIN
  INSERT INTO dbo.users (id, username)
  VALUES ('user-datareusx', 'datareusx');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE id = 'user-mtu')
BEGIN
  INSERT INTO dbo.users (id, username)
  VALUES ('user-mtu', 'mtu');
END;
`,
  `
IF NOT EXISTS (
  SELECT 1 FROM dbo.user_domain_map
  WHERE user_id = 'user-datareusx' AND domain_id = '${DEFAULT_DOMAIN_ID}'
)
BEGIN
  INSERT INTO dbo.user_domain_map (user_id, domain_id)
  VALUES ('user-datareusx', '${DEFAULT_DOMAIN_ID}');
END;

IF NOT EXISTS (
  SELECT 1 FROM dbo.user_domain_map
  WHERE user_id = 'user-mtu' AND domain_id = '${DEFAULT_DOMAIN_ID}'
)
BEGIN
  INSERT INTO dbo.user_domain_map (user_id, domain_id)
  VALUES ('user-mtu', '${DEFAULT_DOMAIN_ID}');
END;
`,
  `
IF NOT EXISTS (SELECT 1 FROM dbo.overleitung_sheets WHERE id = '${BUSINESS_IMPACT_SHEET_ID}')
BEGIN
  INSERT INTO dbo.overleitung_sheets (id, name, theme, status, version, theme_target_description)
  VALUES (
    '${BUSINESS_IMPACT_SHEET_ID}',
    'Business Impact v1',
    'Business Impact',
    'active',
    1,
    'Baseline sheet installed by bootstrap'
  );
END
`,
  `
IF NOT EXISTS (SELECT 1 FROM dbo.sheet_questions WHERE id = 'bi-v1-q1')
BEGIN
  INSERT INTO dbo.sheet_questions (id, sheet_id, code, question, checkpoints, order_index, active)
  VALUES
    (
      'bi-v1-q1',
      '${BUSINESS_IMPACT_SHEET_ID}',
      'BI-Q1',
      'Welches konkrete Business-Problem wird durch bessere Datenqualität gelöst?',
      '["Business Outcome klar benennen","Betroffene Stakeholder identifizieren","Erwartete Wirkung beschreiben"]',
      0,
      1
    ),
    (
      'bi-v1-q2',
      '${BUSINESS_IMPACT_SHEET_ID}',
      'BI-Q2',
      'Welche Prozesse oder Entscheidungen werden durch dieses Datenprodukt verbessert?',
      '["Kritische Prozesse nennen","Entscheidungspunkte benennen","Abhängigkeiten sichtbar machen"]',
      1,
      1
    ),
    (
      'bi-v1-q3',
      '${BUSINESS_IMPACT_SHEET_ID}',
      'BI-Q3',
      'Welche KPIs messen den Erfolg der Verbesserung?',
      '["Messbare KPI definieren","Baseline dokumentieren","Zielwert und Zeitbezug festlegen"]',
      2,
      1
    ),
    (
      'bi-v1-q4',
      '${BUSINESS_IMPACT_SHEET_ID}',
      'BI-Q4',
      'Welche Risiken entstehen bei schlechter Datenqualität?',
      '["Risikofelder benennen","Auswirkungen quantifizieren","Priorisierung der Risiken"]',
      3,
      1
    ),
    (
      'bi-v1-q5',
      '${BUSINESS_IMPACT_SHEET_ID}',
      'BI-Q5',
      'Wer trägt fachlich die Verantwortung für Nutzen und Qualität der Daten?',
      '["Verantwortliche Rolle definieren","Governance-Verankerung prüfen","Entscheidungsrechte klären"]',
      4,
      1
    );
END
`,
];

function schemaSqlForDialect(dialect: SqlDialect): string[] {
  return dialect === 'postgres' ? POSTGRES_SCHEMA_SQL : AZURE_SQL_SCHEMA_SQL;
}

function seedSqlForDialect(dialect: SqlDialect): string[] {
  return dialect === 'postgres' ? POSTGRES_SEED_SQL : AZURE_SQL_SEED_SQL;
}

export async function ensureSchema(
  dialect: SqlDialect,
  query: QueryFn,
): Promise<void> {
  const statements = schemaSqlForDialect(dialect);
  for (const sql of statements) {
    await query(sql);
  }
}

export async function ensureSeedData(
  dialect: SqlDialect,
  query: QueryFn,
): Promise<void> {
  const statements = seedSqlForDialect(dialect);
  for (const sql of statements) {
    await query(sql);
  }
}
