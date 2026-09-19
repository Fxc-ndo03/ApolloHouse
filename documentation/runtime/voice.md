# Voice

Apollo is voice-first. Replies are written to be spoken: short, natural sentences rather than long markdown essays. Anything headed for TTS also passes through `sanitizeTextForSpeech` (`apps/agent/src/voice/sanitize.ts`) so stray markdown never gets read out loud ("asterisco asterisco…").

## Pipeline

1. **STT** — device audio is transcribed (Gemini 2.0 Flash by default)
2. **Reasoning** — the model sees soul + mode prompts, session context, and tool results
3. **TTS** — the reply is synthesized by ElevenLabs or Gemini and streamed to the device as raw 24 kHz s16le mono PCM (`output_format=pcm_24000`, no decoder on the ESP32)

Long replies are spoken in sentence-sized segments (`apps/agent/src/voice/segment.ts`, ≤280 chars each): the turn only waits for the first segment, and each following segment is synthesized while the previous one plays. The paced stream (`apps/agent/src/voice/stream.ts`) additionally caps the device backlog at 4 s — the firmware queues ~6.8 s of frames and silently drops overflow, which used to clip the tail of replies longer than ~30 s.

Two more latency/cost layers sit on that path:

- **LLM streaming + speculative TTS** — the reasoning call streams over SSE (`onTextDelta` in `apps/agent/src/voice/llm.ts`); as soon as the first sentence segment closes, `apps/agent/src/turn/run.ts` starts synthesizing it while the model is still writing. If the round turns out to be a tool call, the speculation is discarded; it is only reused when its text is byte-identical to the final first segment.
- **TTS cache** — every production synthesis goes through `apps/agent/src/voice/synthesize.ts`, which wraps ElevenLabs in the cache from `apps/agent/src/voice/ttscache.ts`: R2 objects under `tts-cache/` keyed by SHA-256 of voice+model+text. Repeated utterances (acks, daily reminders) cost zero ElevenLabs credits. Cache failures degrade to direct synthesis; entries never expire (change voice/model → new keys, old ones become garbage that can be bulk-deleted by prefix).

Configuration knobs:

- `ELEVENLABS_API_KEY` — secret (`.dev.vars` locally, `bunx wrangler secret put ELEVENLABS_API_KEY` in prod)
- `ELEVENLABS_TTS_MODEL` — `apps/agent/wrangler.jsonc` var, default `eleven_multilingual_v2` (best accent fidelity; `eleven_flash_v2_5` is half the credits if quota bites)
- `APOLLO_TTS_VOICE` — voice id constant in `apps/agent/src/configuration/identity.ts` (the owner seam). The model takes no `language_code`, so the Rioplatense accent lives in the voice: pick one from the ElevenLabs Voice Library (Spanish / Argentina), add it to My Voices, paste the id
- STT/LLM use Gemini: `GEMINI_STT_MODEL`, `GEMINI_MODEL`, `GEMINI_LIVE_MODEL`

Quota math (Starter ≈ 30k credits/mo): `eleven_multilingual_v2` burns ~1 credit per character, `eleven_flash_v2_5` ~0.5. A typical spoken reply (~200 chars) is ~200 credits.

Implementation details sit under `apps/agent/src/voice/`.

## Fallbacks (degradación, nunca reemplazo del Live)

El pipeline principal es la Live API de Gemini (audio bidireccional en tiempo real). Nada de lo
siguiente lo toca: todo vive en la rama clásica STT → LLM → TTS (`apps/agent/src/agents/runtime.ts`,
adapters no-Live) y solo se activa cuando Gemini falla o se acerca a su cuota.

- **LLM por proveedor** (`apps/agent/src/voice/provider.ts`): si Gemini devuelve 429 tras los
  reintentos, el turno se resuelve una vez contra un endpoint OpenAI-compatible configurado
  (  `LLM_FALLBACK_API_KEY/BASE_URL/MODEL`, hoy Groq). El turno siguiente vuelve a Gemini solo: no
  hay estado pegajoso. El fallback mapea tool calls igual que Gemini, así que un turno que
  necesitaba una tool (ej. prender una luz) sigue ejecutándola. Test: `LLM_FALLBACK_FORCE=1`
  (secret) salta Gemini y fuerza la rama para probar el circuito sin quemar cuota real.
  Anti-quema: tras un 429 de cuota se registra el fallo en SQLite del DO (`voice/provider.ts`);
  durante el cooldown (10 min, `LLM_QUOTA_COOLDOWN_MS`) los turnos van directo al fallback sin
  reintentar Gemini en vano; el primer éxito de Gemini lo limpia.
- **STT por cuota** (misma rama clásica): si el STT de Gemini agota reintentos con 429, el turno
  transcribe con Whisper del proveedor fallback (`whisper-large-v3-turbo`, `voice/provider.ts`,
  misma cuenta/secret que el LLM fallback, sin costo extra). Si el cooldown de cuota LLM está
  activo (misma cuenta agotada), ni lo intenta: va directo a Whisper. Sin fallback configurado,
  el turno falla como antes.
- **TTS reactivo al 429** (además del contador proactivo): si el TTS de Gemini agota reintentos
  con 429, el turno sintetiza con Workers AI en vez de morir. Sin binding `AI`, relanza el error.
- **TTS por cuota** (`apps/agent/src/voice/quota.ts`, `apps/agent/src/voice/fallback.ts`): contador
  diario de caracteres sintetizados con Gemini en SQLite del Durable Object (tabla `tts_usage`,
  clave por día UTC, reset a medianoche). Al llegar al 80 % del límite
  (`TTS_FALLBACK_DAILY_CHAR_LIMIT`, default 150000, ajustable: es un guardarraíl propio, no la
  cuota publicada de Google) el adapter TTS cambia a Workers AI MeloTTS
  (`@cf/myshell-ai/melotts`, `lang: 'ES'` en mayúsculas — minúsculas da 8002, verificado en prod):
  el Worker pide MP3 y lo decodifica a PCM 24 kHz mono **en el servidor** vía WASM
  (`@audio/decode-mp3` mpg123 + `voice/resample.ts` mix a mono + resample lineal) antes del streamer,
  así el cliente/ESP32 siguen recibiendo PCM crudo sin cambios ni decoder extra. Timeout 15 s;
  si cuelga, el turno falla ruidoso. Aura eliminado como fallback: cobra $0.03/1k y rompía el $0.
  Sin binding `AI`, degrada a intentar Gemini igual. Límite conocido: los
  turnos Live no pasan por el contador (la API no reporta uso por turno), así que la contabilidad
  cubre la rama clásica.
- **Plan B (documentado, no implementado): ElevenLabs** vía `fetch` funciona desde Workers y el
  free tier (~10k chars/mes) alcanzaría para uso solo-emergencia, pero suma vendor + secret y tope
  mensual duro. **edge-tts descartado como base**: endpoint interno de Microsoft reverse-engineered,
  sin SLA, con historial de bloqueos que tardaron semanas en sortearse; como mucho último eslabón.
- **Skip de Live con memoria**: si el setup de Live falla 3 veces seguidas (ej. key sin acceso,
  verificado: ListModels lo lista pero el endpoint cierra 1008), los turnos de voz van directo a
  la rama clásica por 30 min (`LIVE_SKIP_COOLDOWN_MS`, tabla `live_health`). Un éxito lo limpia.

## Interruption

Speech is cancellable mid-reply. The device sends `abort`; the agent sets a flag that the
paced loop checks between chunks (`shouldStop` in `apps/agent/src/voice/stream.ts`), so sending stops
within one chunk instead of at the end of the clip. The server then sends `tts_aborted`,
because `tts_start` promised a byte count the device is counting against — without it the
device waits forever for audio that was cancelled.

Two consequences worth knowing: an abort ends the *whole* reply, not just the current
segment (remaining segments are never synthesized, which also saves the credits), and a
new turn always clears the flag, so an abort can never leak into the next reply.

## Captions

The server can attach a caption to `ui_state` so the ESP32 can show what is being said even when audio is hard to hear.

## Latency mindset

The loop favors quick spoken answers. Deep research and heavy sandbox jobs should leave the interactive path and return later instead of blocking the desk in `thinking` indefinitely.

## Navigation

Prev: [Protocol](protocol.md) · Next: [Persona](persona.md)
