# DB Bootstrap (Always-On for SQL Providers)

## Verhalten

- `DB_PROVIDER=azure_postgres`: Das Schema wird beim ersten DB-Zugriff automatisch angelegt, falls Tabellen fehlen.
- `DB_PROVIDER=azure_sql`: Das Schema wird beim ersten DB-Zugriff automatisch angelegt, falls Tabellen fehlen.
- `DB_PROVIDER=supabase`: Kein automatisches Schema-Bootstrap (unverändertes Verhalten).
- Zusätzlich werden bei SQL-Providern Default-Daten idempotent installiert.

## Ziel

Für leere SQL-Datenbanken ist kein separates manuelles Voranlegen der Tabellen mehr erforderlich.

## Abgedeckte Tabellen

- `domains`
- `briefs`
- `overleitung_sheets`
- `sheet_questions`
- `brief_sheet_findings`
- `brief_sheet_evaluations`
- `users`
- `user_domain_map`
- `interviews`
- `answers`

## Automatisch mitgelieferte Default-Daten

- Fallback-Domain:
  - `domains.id = 00000000-0000-0000-0000-000000000000`
  - `name = Default Domain`
- Default-User:
  - `users.id = user-datareusx`, `username = datareusx`
  - `users.id = user-mtu`, `username = mtu`
  - beide mit `user_domain_map` auf die Fallback-Domain gemappt
- Überleitungssheet:
  - `overleitung_sheets.id = sheet-business-impact-v1`
  - `name = Business Impact v1`
- Leitfragen für Business Impact v1:
  - `BI-Q1` bis `BI-Q5` in `sheet_questions` (mit `order_index` 0..4)

## Was weiterhin fachlich anzulegen ist

- Weitere `users`/`user_domain_map` über die beiden Default-User hinaus
- Fachliche Steckbriefe (`briefs`) entstehen dann z. B. per Upload-Flow.
