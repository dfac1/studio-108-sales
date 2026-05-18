# Себестоимость звонка

Дата фиксации цен и замеров: `2026-05-05`.

## Что уже заложено

В проект добавлен калькулятор переменной себестоимости звонка:

- API: [src/routes.ts](</C:/Users/Андрей/Desktop/Sales/src/routes.ts>) -> `POST /api/cost/call`
- Логика: [src/services/callCostModel.ts](</C:/Users/Андрей/Desktop/Sales/src/services/callCostModel.ts>)
- Сценарии: [scripts/call-cost-scenarios.ts](</C:/Users/Андрей/Desktop/Sales/scripts/call-cost-scenarios.ts>)

Запуск сценариев:

```bash
npm run cost:model
```

Если позже выберем телефонию, можно сразу подставить ее в сценарии:

```bash
$env:TELEPHONY_INBOUND_PER_MINUTE_USD='0.00'
$env:TELEPHONY_BRIDGE_PER_MINUTE_USD='0.00'
npm run cost:model
```

## Важное допущение

Во всех расчетах на каждую внешнюю платную систему добавляется множитель `1.2`, потому что у вас пополнение идет с `+20%`.

## Текущие официальные цены, которые используются в модели

### OpenAI

- `GPT-5.4`:
  - input: `$2.50 / 1M tokens`
  - cached input: `$0.25 / 1M tokens`
  - output: `$15.00 / 1M tokens`
- `GPT-5.4 mini`:
  - input: `$0.75 / 1M tokens`
  - cached input: `$0.075 / 1M tokens`
  - output: `$4.50 / 1M tokens`

Источник: [OpenAI API Pricing](https://openai.com/api/pricing/)

### ElevenLabs

- `Flash / Turbo TTS`: `$0.05 / 1K characters`
- `Multilingual v2/v3 TTS`: `$0.10 / 1K characters`
- `Scribe v1/v2 STT`: `$0.22 / hour`
- `Scribe v2 Realtime STT`: `$0.39 / hour`
- `Entity detection`: `$0.07 / hour`
- `Keyterm prompting`: `$0.05 / hour`

Источник: [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)

## Какие переменные затрат входят в звонок

### Обязательные

1. `callMinutes`
2. `ttsCharacters`
3. `dialogInputTokens`
4. `dialogOutputTokens`
5. `extractionInputTokens`
6. `extractionOutputTokens`

### Почти наверняка будут в проде

1. `telephonyInboundPerMinuteUsd`
2. `telephonyBridgePerMinuteUsd`
3. `recordingStorageUsdPerCall`
4. `mediaStorageUsdPerCall`

### Опциональные

1. `dialogCachedInputTokens`
2. `extractionCachedInputTokens`
3. `postCallSummaryInputTokens`
4. `postCallSummaryCachedInputTokens`
5. `postCallSummaryOutputTokens`
6. `useEntityDetection`
7. `useKeytermPrompting`

## Формула

Итог без фиксированных подписок:

```text
call_cost =
  STT +
  TTS +
  OpenAI dialog +
  OpenAI extraction +
  post-call summary +
  telephony inbound +
  telephony bridge +
  recording/storage
```

Потом на каждую строку применяется:

```text
line_cost_with_topup = line_cost * 1.2
```

## Наши живые замеры по текущему prompt-стеку

Я снял реальные usage с текущих запросов в OpenAI на этом проекте.

### Один `dialog reply` ход

- input tokens: `1418`
- output tokens: `52`

### Один `semantic extraction` ход

- input tokens: `922`
- output tokens: `55`

Это уже заложено как baseline в [src/services/callCostModel.ts](</C:/Users/Андрей/Desktop/Sales/src/services/callCostModel.ts>).

## Что пока не зафиксировано числом

Телефония еще не выбрана, поэтому в калькуляторе она вынесена в отдельные переменные:

- `telephonyInboundPerMinuteUsd`
- `telephonyBridgePerMinuteUsd`

Пока они не заданы, модель считает `AI stack only`.

## Что лучше считать в двух режимах

### 1. Плановая оценка

Когда мы еще не звонили:

- длительность звонка
- число ответов менеджера
- число сложных semantic turns
- общий объем TTS-символов

### 2. Фактическая себестоимость

Когда звонки пойдут:

- реальные `usage` от OpenAI
- реальные символы TTS
- реальные минуты STT
- реальная минутная цена телефонии
- реальная доля звонков с summary / записью / ретраями

## Что еще нужно будет добить для точной экономики

1. Выбрать телефонию.
2. Решить, храним ли записи звонков и сколько.
3. Понять, нужен ли post-call summary на каждый звонок.
4. Завести логирование usage по каждому звонку, чтобы считать фактическую себестоимость, а не только прогноз.
