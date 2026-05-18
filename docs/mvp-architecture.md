# Hybrid Voice Architecture

## Target

Fast inbound sales manager for Studio 108:

- understands Russian speech
- qualifies the lead
- offers one best slot at a time
- books a trial lesson
- stays resilient when the speech provider or semantic layer is weak

## Main Principle

Not `LLM-first`, but `policy-first`.

Flow:

1. STT provider transcribes audio
2. local rules parse the message first
3. semantic layer is called only when rule coverage is weak or the phrase is ambiguous
4. dialog policy decides the next step
5. backend tools return slots, price, and booking result
6. TTS provider voices a short reply

## Why This Architecture

- faster replies
- fewer hallucinations
- easier A/B test between providers
- safer business logic
- simpler path from web MVP to telephony

## Providers

### STT

- ElevenLabs Scribe
  - main candidate for the target voice-first stack
  - good realtime potential
- Yandex SpeechKit
  - fallback branch for A/B and continuity
  - useful as a reserve provider

### TTS

- ElevenLabs
  - main voice provider for this product direction
  - strongest fit when the goal is a human-like sales manager
- Yandex SpeechKit
  - reserve branch
  - useful if external access to ElevenLabs is unstable

## Low-Latency Rules

- one main question per reply
- short replies only
- no full free-form generation on every turn
- OpenAI semantic assist only on weak/ambiguous turns
- semantic extraction timeout with fallback
- tool-based truth for slots and price

## Public Runtime Endpoints

- `POST /api/voice/turn`
- `POST /api/stt/transcribe`
- `POST /api/tts/speak`
- `POST /api/semantic/extract` (internal debug)
- `GET /api/providers/voice`
