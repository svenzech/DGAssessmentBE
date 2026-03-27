import { Router } from 'express';

export function createAzureOpenAiShimRouter() {
  const router = Router();

  const enabled = (process.env.AZURE_SHIM_ENABLED ?? 'false').toLowerCase() === 'true';
  const upstreamBaseUrl = (process.env.AZURE_SHIM_UPSTREAM_BASE_URL ?? '').trim();
  const upstreamApiKey = (process.env.AZURE_SHIM_UPSTREAM_API_KEY ?? '').trim();
  const forcedModel = (process.env.AZURE_SHIM_UPSTREAM_MODEL ?? '').trim();
  const sharedApiKey = (process.env.AZURE_OPENAI_API_KEY ?? '').trim();

  if (!enabled) {
    console.info('[azure-shim] disabled');
    return router;
  }

  if (!upstreamBaseUrl || !upstreamApiKey) {
    console.warn(
      '[azure-shim] enabled but missing AZURE_SHIM_UPSTREAM_BASE_URL or AZURE_SHIM_UPSTREAM_API_KEY',
    );
    return router;
  }

  const normalizedBase = upstreamBaseUrl.replace(/\/$/, '');
  const upstreamUrl = `${normalizedBase}/v1/chat/completions`;

  router.post(
    '/openai/deployments/:deployment/chat/completions',
    async (req, res) => {
      try {
        const apiKeyHeader = req.header('api-key') ?? '';
        if (sharedApiKey && apiKeyHeader !== sharedApiKey) {
          return res.status(401).json({
            error: {
              message: 'Invalid api-key',
              type: 'unauthorized',
            },
          });
        }

        const deployment = (req.params.deployment ?? '').trim();
        const input = req.body ?? {};

        const payload = {
          ...input,
          model: forcedModel || deployment || input.model,
        };

        const upstreamRes = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${upstreamApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const text = await upstreamRes.text();
        const contentType = upstreamRes.headers.get('content-type') || 'application/json';

        res.status(upstreamRes.status);
        res.setHeader('content-type', contentType);
        return res.send(text);
      } catch (error: any) {
        console.error('[azure-shim] request failed:', error);
        return res.status(502).json({
          error: {
            message: error?.message ?? 'Upstream call failed',
            type: 'bad_gateway',
          },
        });
      }
    },
  );

  console.info('[azure-shim] enabled, forwarding to', upstreamUrl);
  return router;
}
