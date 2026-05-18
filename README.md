# Studio 108 Voice Sales

Голосовой sales-агент для Studio 108. Принимает входящие заявки, ведёт по скрипту до записи на пробное и при необходимости передаёт администратору с полным контекстом.

Архитектурный документ: [docs/voice-agent-system-design.md](docs/voice-agent-system-design.md)

## Стек

- Backend: Node.js + TypeScript + Fastify
- Dialog: policy-first FSM + OpenAI brain как humanizer
- TTS: ElevenLabs Flash v2.5 (streaming + emotional presets)
- STT: ElevenLabs Scribe v2
- Pre-cached backchannels: «угу-угу», «понимаю», «так, секунду, гляну»…
- Хранение: JSONL для bookings/conversations/handoffs/reminders/shadow

## Что умеет

**Голос:**
- Streaming TTS через MediaSource API (TTFB ≈300 мс)
- Микрофон с VAD + автоматический STT
- Barge-in (клиент перебивает — TTS останавливается)
- 7+ pre-cached backchannel-семплов с adaptive выбором (по action и сентименту клиента)
- 6 эмоциональных пресетов voice_settings (greeting/business/empathic/joyful/clarification)
- Pronunciation map для русских названий
- Имя-персонаж (по умолчанию «Анна»)

**Диалог (FSM):**
- 14 основных шагов и 13 cross-cutting (handoff trigger, bot question, price/address/teacher question, 6 типов возражений, clarify, silence, loop guard)
- Loop guard: 2 одинаковых action подряд → handoff
- Confidence retry: непонятная реплика → clarify → handoff на 2-м промахе
- Memory of facts: brain не может переспросить уже известное
- Schema validation: цены/факты в reply должны быть в state/tools
- Banned phrases фильтр + shadow-режим для расширенных запретов
- Multi-fact extraction в одной реплике
- Temporal parsing: «завтра», «в эти выходные», «послезавтра»
- Continuity по phone (повторный контакт)

**Защита и observability:**
- Полный JSONL turn-log (`data/conversations.jsonl`)
- Handoff log с роутингом к админу по филиалу (`data/handoffs.jsonl`)
- Variant picks log для A/B (`data/variant-picks.jsonl`)
- Shadow events log (`data/shadow-events.jsonl`)
- Dashboard endpoint и admin UI

**Бизнес-инфраструктура:**
- Reminders pipeline: за день, за 2 часа, post-trial (`data/reminders.jsonl`)
- Handoff routing с round-robin по списку админов
- Feature flags через `FLAGS_JSON`

## Запуск

```bash
npm install
copy .env.example .env
npm run dev
```

- Веб-тест диалога: <http://127.0.0.1:3108/>
- Admin-панель: <http://127.0.0.1:3108/admin.html>

## Скрипты

```bash
npm run typecheck             # TypeScript
npm run test                  # vitest unit-тесты
npm run dialog:pack           # 50 диалоговых сценариев (regression)
npm run test:all              # unit + dialog:pack
npm run dialog:smoke          # ручной smoke по нескольким диалогам
npm run cost:model            # сценарии себестоимости звонка
npm run cost:from-log         # фактическая стоимость по conversations.jsonl
npm run reminders:dispatch    # обход due-reminders (TODO: подключить провайдера)
npm run calls:prepare         # подготовка реальных записей
npm run calls:transcribe      # batch STT
npm run calls:review          # анализ качества
```

## API endpoints

### Голосовой контур

- `POST /api/voice/turn` — основной FSM-step (вход: `message`, `state`, опционально `meta`)
- `POST /api/stt/transcribe` — STT (ElevenLabs / Yandex)
- `POST /api/tts/speak` — sync TTS
- `POST /api/tts/stream` — streaming TTS с `voicePreset`
- `GET /api/providers/voice` — статус провайдеров
- `GET /api/backchannels` — манифест семплов
- `POST /api/backchannels/refresh` — пересоздать семплы

### Бизнес-данные

- `GET /api/slots` — поиск слотов
- `GET /api/prices` — точная цена по направлению/филиалу
- `GET /api/branches` — филиалы
- `POST /api/bookings` — создать бронь (триггерит reminders)
- `GET /api/customer/history?phone=...` — continuity по телефону

### Админ / observability

- `GET /api/dashboard/stats?windowDays=7` — KPI и drop-off
- `GET /api/handoffs` — последние handoff'ы
- `GET /api/reminders` — все запланированные напоминания
- `GET /api/reminders/due` — что должно быть отправлено сейчас
- `POST /api/reminders/mark` — пометить напоминание как sent / cancelled / failed
- `GET /api/flags` — статус feature flags
- `GET /api/shadow/events` — events из shadow-режима

## Структура данных

```
data/
  bookings.jsonl              # фактические бронирования
  conversations.jsonl         # turn-by-turn лог диалогов
  handoffs.jsonl              # лог передач администратору
  reminders.jsonl             # очередь напоминаний
  shadow-events.jsonl         # would-block события из shadow-режима
  variant-picks.jsonl         # выбранные варианты фраз (A/B)
  slot-availability.json      # свободные места по слотам
  dialog-test-pack.json       # regression-сценарии
```

## Документы

- [docs/voice-agent-system-design.md](docs/voice-agent-system-design.md) — целевая FSM, шаги, cross-cutting, дорожная карта
- [docs/mvp-architecture.md](docs/mvp-architecture.md) — общая архитектура
- [docs/system-prompt-and-steps.md](docs/system-prompt-and-steps.md) — промпты
- [docs/voice-failure-modes.md](docs/voice-failure-modes.md) — режимы отказа
- [docs/sales-script-rules.md](docs/sales-script-rules.md) — правила скрипта
- [docs/real-call-analysis-workflow.md](docs/real-call-analysis-workflow.md) — анализ реальных звонков
- [docs/russian-market-compliance.md](docs/russian-market-compliance.md) — 152-ФЗ
- [docs/call-unit-economics.md](docs/call-unit-economics.md) — себестоимость

## Что осталось вне кода (требует внешних сервисов)

- Реальная телефония (SIP-провайдер: Voximplant / Novofon / Mango)
- Двусторонний CRM sync с Google Sheets (нужен service account)
- Реальная отправка reminders (WhatsApp Business API / Wazzup / Telegram)
- Канареечный rollout (production-инфраструктура)
- Pilot прослушка 100% диалогов (UI ревью)
