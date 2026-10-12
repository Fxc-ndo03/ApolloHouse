import { routeAgentRequest } from 'agents';
import { Sandbox } from '@cloudflare/sandbox';

import { authorizeApolloConnection, Apollo, PcBridge } from '@/agents/apollo';
import { MobileBridge } from '@/agents/mobile-bridge';
import { authorizeApolloHttpRequest } from '@/auth/http';
import { CODING_PROXY_PATH_PREFIX, handleCodingLlmProxyRequest } from '@/coding/proxy';
import { handleOtaRequest } from '@/ota/routes';
import { consumeApolloQueueBatch } from '@/queues/consume';
import { ApolloBackground } from '@/workflows/background';
import { ApolloCoding } from '@/workflows/coding';
import {
  authorizeMobileDeviceRequest,
  isMobileBridgeRequestPath,
  resolveEnrollmentRouteKind,
  resolveMobileBridgeStub,
} from '@/devices/route';
import {
  isDeviceSharedSecretValid,
  isInternalCoreTokenValid,
  readDeviceTokenFromRequestUrl,
} from '@/auth/token';
import { listPcToolDefinitionList } from '@/tools/pc';
import { buildToolDefinitionMap } from '@/tools/router';
import type { ToolDefinition } from '@/tools/types';
import { chatWithGemini } from '@/voice/llm';
import { chatWithFallbackLlm } from '@/voice/provider';

export { Apollo, ApolloBackground, ApolloCoding, Sandbox, PcBridge, MobileBridge };

// The hosted management console probes /health cross-origin before opening
// the agent WebSocket; auth is the query token, never a cookie, so a wildcard
// origin does not widen what the token already gates.
const CONSOLE_CORS_HEADER_MAP = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
} as const;

function requireInternalToken(request: Request, env: Env): boolean {
  return isInternalCoreTokenValid(
    request.headers.get('X-Internal-Token'),
    env.INTERNAL_CORE_TOKEN,
  );
}

export default {
  async fetch(request: Request, environment: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === '/health') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CONSOLE_CORS_HEADER_MAP });
      }
      return Response.json(
        {
          ok: true,
          name: 'apollo',
          features: [
            'session',
            'vectorize',
            'r2',
            'queues',
            'workflows',
            ...(environment.Sandbox !== undefined ? ['coding'] : []),
          ],
        },
        { headers: CONSOLE_CORS_HEADER_MAP },
      );
    }

    // TEMP-DIAG: listar modelos con bidiGenerateContent para esta key. Borrar.
    if (requestUrl.pathname === '/debug/live-models') {
      const presentedToken = readDeviceTokenFromRequestUrl(requestUrl);
      const tokenOk = await isDeviceSharedSecretValid(
        presentedToken,
        environment.DEVICE_SHARED_SECRET,
      );
      if (!tokenOk) {
        return new Response('Unauthorized', { status: 401 });
      }
      const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(environment.GEMINI_API_KEY ?? '')}&pageSize=100`;
      const listResponse = await fetch(listUrl);
      if (!listResponse.ok) {
        return Response.json(
          { error: `ListModels falló ${listResponse.status}` },
          { status: 502 },
        );
      }
      const listPayload = (await listResponse.json()) as {
        models?: {
          name?: string;
          displayName?: string;
          supportedGenerationMethods?: string[];
        }[];
      };
      const liveModelList = (listPayload.models ?? [])
        .filter((model) =>
          (model.supportedGenerationMethods ?? []).includes('bidiGenerateContent'),
        )
        .map((model) => model.name ?? '?');
      return Response.json({ liveModels: liveModelList });
    }

    if (requestUrl.pathname.startsWith('/ota/')) {
      return handleOtaRequest(request, requestUrl, environment);
    }

    if (requestUrl.pathname.startsWith(`${CODING_PROXY_PATH_PREFIX}/`)) {
      return handleCodingLlmProxyRequest(request, requestUrl, environment);
    }

    // Debug endpoint: list TTS models
    if (requestUrl.pathname === '/debug/tts-models') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CONSOLE_CORS_HEADER_MAP });
      }
      try {
        const apollo = environment.Apollo.get(environment.Apollo.idFromName('default'));
        const models = await apollo.debugListTtsModels();
        return Response.json({ models }, { headers: CONSOLE_CORS_HEADER_MAP });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500, headers: CONSOLE_CORS_HEADER_MAP },
        );
      }
    }

    if (requestUrl.pathname.startsWith('/ota/')) {
      return handleOtaRequest(request, requestUrl, environment);
    }

    if (requestUrl.pathname.startsWith(`${CODING_PROXY_PATH_PREFIX}/`)) {
      return handleCodingLlmProxyRequest(request, requestUrl, environment);
    }

    // Internal endpoint: PcBridge commands from Apollo Core
    if (requestUrl.pathname === '/api/internal/pc-bridge') {
      if (!(await requireInternalToken(request, environment))) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      try {
        const body = (await request.json()) as {
          command: string;
          args: Record<string, unknown>;
        };
        const pcBridge = environment.PcBridge.get(
          environment.PcBridge.idFromName('pc-bridge'),
        );
        const result = await pcBridge.sendCommand(body.command as any, body.args);
        return Response.json({ ok: true, result });
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }

    // Internal endpoint: Gemini chat from Apollo Core
    if (requestUrl.pathname === '/api/internal/gemini-chat') {
      if (!(await requireInternalToken(request, environment))) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      try {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string | null }>;
          tools?: Array<{ name: string; description: string; parameters: unknown }>;
        };

        // Build tool definition map from available PC tools
        const toolDefs = listPcToolDefinitionList();
        const toolMap = buildToolDefinitionMap(toolDefs);
        const toolDefList = (
          body.tools?.length
            ? body.tools
            : Array.from(toolMap.values()).map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters as ToolDefinition['parameters'],
              }))
        ) as Array<{
          name: string;
          description: string;
          parameters: ToolDefinition['parameters'];
        }>;

        // Try Gemini first, fallback if configured
        let result: {
          text: string;
          toolCallList: Array<{ name: string; args: unknown }>;
        };
        try {
          const geminiResult = await chatWithGemini({
            geminiApiKey: environment.GEMINI_API_KEY ?? '',
            modelId: environment.GEMINI_MODEL ?? 'gemini-2.5-flash',
            messageList: body.messages as any,
            toolDefinitionList: toolDefList,
          });
          result = {
            text: geminiResult.text,
            toolCallList: geminiResult.toolCallList.map((tc) => ({
              name: tc.name,
              args: tc.args,
            })),
          };
        } catch (e) {
          if (
            environment.LLM_FALLBACK_API_KEY &&
            environment.LLM_FALLBACK_BASE_URL &&
            environment.LLM_FALLBACK_MODEL
          ) {
            const fallbackResult = await chatWithFallbackLlm({
              environment,
              messageList: body.messages as any,
              toolDefinitionList: toolDefList,
            });
            result = {
              text: fallbackResult.text,
              toolCallList: fallbackResult.toolCallList.map((tc) => ({
                name: tc.name,
                args: tc.args,
              })),
            };
          } else {
            throw e;
          }
        }

        return Response.json({
          text: result.text,
          toolCalls: result.toolCallList.map((tc) => ({ name: tc.name, args: tc.args })),
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }

    // Mobile devices only: explicit route + 'device' role, then the bridge.
    // PcBridge and Apollo keep going through routeAgentRequest untouched.
    if (isMobileBridgeRequestPath(requestUrl.pathname)) {
      const mobileBridge = resolveMobileBridgeStub(environment);
      if (mobileBridge === undefined) {
        return new Response('Not found', { status: 404 });
      }
      // BLOCK 12: enrollment y revocación son HTTP y las atiende el propio DO,
      // que es dueño del store y de los sockets. El borde no las autoriza: el
      // challenge lo pide el dueño (rol dashboard) y el claim lo autoriza el
      // desafío mismo, que el teléfono todavía no tiene con qué autenticar.
      if (resolveEnrollmentRouteKind(requestUrl.pathname) !== null) {
        return mobileBridge.fetch(request);
      }
      const mobileAuthorization = await authorizeMobileDeviceRequest({
        request,
        environment,
      });
      if (!mobileAuthorization.isAuthorized) {
        return mobileAuthorization.response;
      }
      return mobileBridge.fetch(request);
    }

    const agentResponse = await routeAgentRequest(request, environment, {
      cors: true,
      onBeforeConnect: async (connectRequest) =>
        authorizeApolloConnection(connectRequest, environment),
      onBeforeRequest: async (httpRequest) =>
        authorizeApolloHttpRequest(httpRequest, environment),
    });

    if (agentResponse !== undefined && agentResponse !== null) {
      return agentResponse;
    }

    return new Response('Not found', { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, environment: Env): Promise<void> {
    await consumeApolloQueueBatch(batch, environment);
  },
} satisfies ExportedHandler<Env>;
