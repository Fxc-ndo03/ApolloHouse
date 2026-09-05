// Deployments without the Containers block in wrangler.jsonc (Workers Free
// plan, coding opt-out) have no Sandbox binding at all, so it is declared
// optional here and every consumer degrades when it is absent.
interface Env {
  Sandbox?: DurableObjectNamespace<import('@cloudflare/sandbox').Sandbox>;
  DEVICE_SHARED_SECRET: string;
  DASHBOARD_SHARED_SECRET: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GEMINI_STT_MODEL?: string;
  GEMINI_LIVE_MODEL: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_EMBEDDING_MODEL: string;
  TAVILY_API_KEY: string;
  RESEND_API_KEY: string;
  APOLLO_OWNER_EMAIL?: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  MOCK_VOICE?: string;
  CODING_PROXY_ORIGIN?: string;
  CODING_ENGINE?: string;
  FIRMWARE_PUSH_DISABLED?: string;
  PC_BRIDGE_SECRET: string;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  SPOTIFY_REDIRECT_URI: string;
}

declare namespace Cloudflare {
  interface Env {
    Sandbox?: DurableObjectNamespace<import('@cloudflare/sandbox').Sandbox>;
    DEVICE_SHARED_SECRET: string;
    DASHBOARD_SHARED_SECRET: string;
    GEMINI_API_KEY: string;
    GEMINI_MODEL: string;
    GEMINI_STT_MODEL?: string;
    GEMINI_LIVE_MODEL: string;
    GEMINI_TTS_MODEL?: string;
    GEMINI_EMBEDDING_MODEL: string;
    TAVILY_API_KEY: string;
    RESEND_API_KEY: string;
    APOLLO_OWNER_EMAIL?: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;
    MOCK_VOICE?: string;
    CODING_PROXY_ORIGIN?: string;
    CODING_ENGINE?: string;
    FIRMWARE_PUSH_DISABLED?: string;
    PC_BRIDGE_SECRET: string;
    SPOTIFY_CLIENT_ID: string;
    SPOTIFY_CLIENT_SECRET: string;
    SPOTIFY_REDIRECT_URI: string;
  }
}
