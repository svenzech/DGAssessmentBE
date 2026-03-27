# Azure OpenAI Shim im selben Render-Service

Dieses Setup erlaubt Tests des `LLM_PROVIDER=azure_openai`-Pfads ohne echten Azure-Zugang.
Der Shim läuft als Route im gleichen `brief-api`-Service.

## ENV-Konfiguration (Render Web Service)

### Für den App-Code (Azure-Provider aktiv)

- `LLM_PROVIDER=azure_openai`
- `AZURE_OPENAI_ENDPOINT=https://<dein-brief-api-service>.onrender.com`
- `AZURE_OPENAI_API_KEY=<shared-secret>`
- `AZURE_OPENAI_DEPLOYMENT=oss-test`
- `AZURE_OPENAI_API_VERSION=2024-10-21`

### Für den integrierten Shim (Upstream öffentliches LLM)

- `AZURE_SHIM_ENABLED=true`
- `AZURE_SHIM_UPSTREAM_BASE_URL=https://openrouter.ai/api`
- `AZURE_SHIM_UPSTREAM_API_KEY=<openrouter-api-key>`
- `AZURE_SHIM_UPSTREAM_MODEL=meta-llama/llama-3.1-8b-instruct` (oder anderes Modell)

## Funktionsweise

1. Deine App ruft wie bei Azure auf:
   - `POST /openai/deployments/:deployment/chat/completions?api-version=...`
2. Die neue Shim-Route nimmt den Request an.
3. Der Shim leitet an `${AZURE_SHIM_UPSTREAM_BASE_URL}/v1/chat/completions` weiter.
4. Die Response wird 1:1 zurückgegeben.

## Hinweise

- Kein zweiter Render-Service nötig.
- `AZURE_OPENAI_API_KEY` dient hier als Shared Secret zwischen App-Code und Shim-Route.
- Für echte Produktionsvalidierung gegen Azure bitte später einen finalen Smoke-Test mit echtem Azure OpenAI durchführen.
