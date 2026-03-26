import OpenAI from 'openai';

export type LlmProvider = 'openai' | 'azure_openai';

const provider = (process.env.LLM_PROVIDER?.trim().toLowerCase() ||
  'openai') as LlmProvider;

const defaultOpenAiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini-2025-04-14';

function createOpenAiClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in environment variables');
  }

  return {
    client: new OpenAI({ apiKey }),
    model: defaultOpenAiModel,
    provider: 'openai' as const,
  };
}

function createAzureOpenAiClient() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';

  if (!endpoint || !apiKey || !deployment) {
    throw new Error(
      'AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT must be set when LLM_PROVIDER=azure_openai',
    );
  }

  const normalizedEndpoint = endpoint.replace(/\/$/, '');
  const baseURL = `${normalizedEndpoint}/openai/deployments/${deployment}`;

  return {
    client: new OpenAI({
      apiKey,
      baseURL,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': apiKey },
    }),
    model: deployment,
    provider: 'azure_openai' as const,
  };
}

function createProviderRuntime() {
  if (provider === 'azure_openai') {
    return createAzureOpenAiClient();
  }
  if (provider === 'openai') {
    return createOpenAiClient();
  }

  throw new Error(
    `Unsupported LLM_PROVIDER="${provider}". Supported values: openai, azure_openai`,
  );
}

const runtime = createProviderRuntime();

export const llmClient = runtime.client;
export const llmProvider = runtime.provider;
export const defaultLlmModel = runtime.model;

export async function createChatCompletion(
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'model'> & {
    model?: string;
  },
) {
  return llmClient.chat.completions.create({
    ...params,
    model: params.model || defaultLlmModel,
  });
}
