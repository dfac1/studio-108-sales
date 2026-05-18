# Humanization Plan — Studio 108 Voice Agent

Дата: 2026-05-15
Цель: довести голосового агента до эффекта «неотличимо от живого топ-менеджера» в рамках текущей браузерной MVP — без SIP, без voice clone, без 152-ФЗ слоя.

---

## 1. Что внедряем (10 пунктов)

| # | Фича | Импакт | Сложность | Файлы |
|---|---|---|---|---|
| 9  | Skip-brain на простых шагах (rules-only для ask_name/ask_age/ask_branch/ask_consent/ask_phone) | Latency -800мс, $-30% | S | `salesDialog.ts` |
| 15 | Mid-utterance pauses/breath/disfluency markup | Натуральность | S | `russianSpeech.ts`, `elevenLabsService.ts` |
| 3  | ElevenLabs v3 audio tags в reply (`[мягко]`, `[улыбаясь]`, `[понимающе]`) | Эмоции | M | `salesPrompts.ts`, `russianSpeech.ts`, `elevenLabsService.ts` |
| 7  | Profile classifier (`young_parent`/`teen`/`busy_adult`/`mature`/`unknown`) | Регистр под клиента | M | новый `customerProfile.ts`, `salesDialog.ts` |
| 10 | Long-term memory по phone — передавать prior contacts в brain | Continuity | M | `customerHistory.ts`, `salesDialog.ts`, `openAiSalesBrain.ts` |
| 6  | Success-stories KB + RAG | Жизненные кейсы | M | новый `success-stories.md`, `successStories.ts` |
| 4  | Strategy Supervisor (Claude каждые 3-4 turn'а с extended thinking) | Стратегическое мышление | L | новый `strategySupervisor.ts` |
| 5  | Active listening — backchannel «угу» во время речи клиента | Убивает паузу «думает» | L | `index.html`/`app.js`, новый endpoint |
| 8  | Streaming Claude → инкрементальный TTS (старт TTS на первом предложении) | Latency -400-800мс | L | `openAiSalesBrain.ts`, новый `streamingSynth.ts` |
| 11 | Daily QA loop — скрипт ежедневного дайджеста + UI ревью звонков | Без этого деградация | M | новый `scripts/daily-qa-digest.ts`, `admin.html` |

---

## 2. Архитектурные принципы внедрения

1. **Не ломать FSM.** Все улучшения — поверх policy-first, без сноса салесного потока.
2. **Feature-flag по умолчанию.** Каждая новая фича — за флагом, чтобы можно было быстро откатить.
3. **Backward compatibility.** Существующие тесты (`test:all`, `dialog:pack`) должны продолжать проходить.
4. **Минимум новых зависимостей.** Никаких новых npm-пакетов — всё через fetch и существующий стек.
5. **Логировать всё новое.** Profile, memory hits, supervisor verdicts, audio tags — отдельные поля в turn-log.

---

## 3. План задач (большой TODO)

### Этап A — низкий риск, быстрые улучшения (1-3 дня работы)

1. ✅ Explore project structure deeply
2. ✅ Create HUMANIZATION-PLAN.md
3. **#9 Skip-brain на простых шагах**
   - Добавить `BRAIN_REQUIRED_ACTIONS` в `salesDialog.ts`
   - В `humanizeSalesReply` — если action не в списке → возвращать fallback без вызова Claude
   - Добавить флаг `humanizationSkipSimpleSteps` (default ON)
   - Unit-тест: на ask_name/ask_age brain не вызывается
4. **#15 Mid-utterance pauses/breath/disfluency**
   - Новая функция `injectProsodyBreaks(text, action)` в `russianSpeech.ts`
   - Логика:
     - Reply длиннее 12 слов → вставлять `<break time="200ms"/>` после первой синтагмы
     - На `offer_solution` → добавлять `<break time="350ms"/>` перед временем слота («…во вторник <break/> в 17:30…»)
     - Между двумя длинными предложениями (>8 слов каждое) → `<break time="300ms"/>`
   - Применять только к ElevenLabs v3-ready тексту (под флагом)
5. **#3 ElevenLabs v3 audio tags**
   - Обновить `salesReplyBrainSystemPrompt`: добавить новый блок `<audio_tags>` со списком разрешённых тегов и инструкциями когда использовать
   - Карта: `[мягко]`, `[улыбаясь]`, `[понимающе]`, `[спокойно]`, `[быстрее]`, `[тише]`, `[laughs softly]`, `[breath]`
   - В `cleanHumanReply` сохранять `[...]` теги; в `normalizeForElevenLabsRussianSpeech` оставить теги как есть для v3
   - Добавить флаг `useElevenLabsV3AudioTags` (default OFF — пока voice не v3)
   - Если флаг OFF — strip tags перед TTS

### Этап B — средняя сложность, контекстные улучшения (3-7 дней)

6. **#7 Profile classifier**
   - Новый файл `src/services/customerProfile.ts`
   - Функция `classifyProfile(state, transcript)` — возвращает `young_parent` | `teen` | `busy_adult` | `mature` | `unknown`
   - Логика rule-based: возраст ребёнка + язык клиента + слова-маркеры
   - `young_parent`: learnerType=child, customerName ∈ женские, возраст 4-12
   - `teen`: learnerType=adult, age 14-18, или короткие фразы и сленг
   - `busy_adult`: «у меня после работы», «вечером», «нет времени», age 25-45
   - `mature`: age 45+
   - Профиль сохраняется в `state.customerProfile`
   - Передаётся в brain как `<customer_profile>` блок с рекомендуемым регистром
   - Промпт: для `teen` — короче, проще, без «вы», без «дочка»; для `young_parent` — обстоятельно про педагога; для `busy_adult` — экономия времени, минимум вопросов
7. **#10 Long-term memory по phone**
   - Расширить `lookupPreviousContact` — возвращать также `previousObjections` (из conversations.jsonl `userText` где action=handoff или reason=loop_guard), `previousBookingsCount`, `lastVisitWasTrial`
   - В `mergeExtractedFields` — после получения phone делать `lookupPreviousContact` и сохранять в `state.previousContact`
   - В brain пробрасывать `<previous_contact>` блок с краткой выжимкой
   - Промпт: «если есть previous_contact — используй естественно, не повторяй вопросы которые уже знаешь ответ»
8. **#6 Success-stories KB + RAG**
   - Новый файл `success-stories.md` (создать с 15-20 placeholder-историями, размеченными trigger тегами)
   - Новый сервис `src/services/successStories.ts` — парсит md, индексирует по trigger тегам и направлениям, на каждый turn вызывается `findRelevantStory(state, customerMessage)`
   - Релевантность — простой scoring: совпадение direction, age range, objection type
   - В brain пробрасывать как `<relevant_story>` подсказка (НЕ требование — brain сам решает, использовать ли)
   - Флаг `useSuccessStories` (default ON но KB пустая → no-op)

### Этап C — высокая сложность, стратегические улучшения (7-14 дней)

9. **#11 Daily QA loop**
   - Скрипт `scripts/daily-qa-digest.ts` — анализирует `data/conversations.jsonl` за последние 24ч, выводит:
     - топ-3 «странных» диалога (по эвристике: много retry, handoff на early stage, long replies, low confidence STT)
     - агрегаты: avg latency, avg turns to BOOK, % handoff, ratio brain hits
   - В `admin.html` — новая вкладка «QA» со списком разговоров за день, с рейтингом 1-5 и комментарием
   - Эндпоинт `GET /api/qa/digest` + `POST /api/qa/rate` (сохранение в `data/qa-ratings.jsonl`)
10. **#4 Strategy Supervisor**
    - Новый файл `src/services/strategySupervisor.ts`
    - Вызывается из `voicePipeline.ts` раз в N=3 turn'ов или на критических действиях (offer_solution, objection, handoff candidate)
    - Использует Claude Sonnet 4.6 с extended thinking (`thinking: {type:"enabled", budget_tokens:2000}`)
    - Запрашивает: оценку «теплоты» (0-1), главное возражение клиента (если есть), 1-2 рекомендации тактики на следующие 2 шага
    - Результат — в `state.supervisorVerdict`, передаётся в reply brain как контекст (не как директива)
    - Cache: результат живёт N=3 turn'а, не пересчитывается каждый turn
    - Флаг `useStrategySupervisor` (default OFF — включать только когда есть бюджет)
11. **#5 Active listening — backchannel во время речи клиента**
    - Browser side (`app.js`): при VAD detected start-of-speech — каждые 1500-2500мс случайно проигрывать backchannel из набора `["aga", "ugu", "ponyala"]` с тихой громкостью (0.4)
    - При detected end-of-speech — прекращать
    - На сервере новый endpoint `GET /api/backchannels/listen-sample` — возвращает случайный URL из 3-х
    - Флаг через `?activeListening=1` в URL для тестового включения
12. **#8 Streaming Claude → инкрементальный TTS**
    - Новая функция `generateSalesReplyStreaming` в `openAiSalesBrain.ts` — использует Anthropic Messages API со `stream: true`
    - Накапливает текст, на первом `.` или `?` или после 40 символов — фиксирует «первое предложение» и резолвит promise
    - В `voicePipeline.ts` — если флаг `streamingBrain` включён → стартует TTS first sentence сразу, не ждёт полный reply
    - Флаг `streamingBrain` (default OFF — требует браузерных изменений)

### Этап D — валидация

13. Прогнать `npm run typecheck`
14. Прогнать `npm run test` (vitest)
15. Прогнать `npm run dialog:pack` (50 regression сценариев) — должны все пройти
16. Прогнать `npm run dialog:smoke` — sanity check

---

## 4. Стратегия тестирования

1. **Unit-тесты**: каждый новый сервис (`customerProfile.ts`, `successStories.ts`, `strategySupervisor.ts`) получает свой `*.test.ts` рядом.
2. **Integration** (`dialog:pack`): 50 существующих сценариев должны продолжать проходить.
3. **Manual smoke**: запуск `dialog:smoke` на 3-5 ключевых диалогах, проверка вывода.

---

## 5. Feature flags для новых фич

Все добавляются в `featureFlags.ts`:

| Flag | Default | Что делает |
|---|---|---|
| `humanizationSkipSimpleSteps` | ON  | #9 — skip brain на простых шагах |
| `humanizationProsodyBreaks` | ON  | #15 — pauses/breath markup |
| `useElevenLabsV3AudioTags` | OFF | #3 — пока voice не v3-совместим |
| `useCustomerProfile` | ON  | #7 — profile classifier |
| `useLongTermMemory` | ON  | #10 — load prior contacts |
| `useSuccessStories` | ON  | #6 — но KB пустая |
| `useStrategySupervisor` | OFF | #4 — extended thinking дорогой |
| `useActiveListening` | OFF | #5 — браузерная фича, нужны тесты |
| `useStreamingBrain` | OFF | #8 — требует браузерных изменений |
| `useDailyQADigest` | ON  | #11 — UI скрипт |

---

## 6. Backward compatibility / откат

Любая фича отключается одним флагом в `.env`:
```
FLAGS_JSON={"useCustomerProfile":false,"useLongTermMemory":false,...}
```

Все добавления в state — опциональные поля. Старые conversations.jsonl читаются без миграции.
