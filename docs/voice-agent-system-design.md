# Voice Sales Agent — System Design

Документ фиксирует целевую архитектуру голосового менеджера Studio 108.
Цель: клиент звонит, разговаривает с ассистентом и **не понимает, что это не живой человек**.
Ассистент уверенно ведёт по скрипту до записи на пробное занятие или корректно передаёт лид администратору.

---

## 1. Архитектура

```
[ Клиент ]
   ↓ голос
[ Телефония / Браузер mic ]
   ↓ audio chunks
[ STT (ElevenLabs Scribe v2) ] → транскрипт + confidence
   ↓ текст реплики
[ NLU rules + OpenAI extractor ] → факты (name, age, direction, branch, …)
   ↓ обновление state
[ Sales FSM / policy ] → решение: какой шаг, какой ответ
   ↓ tool calls
[ Tools: slots, prices, bookings, CRM ] → факты
   ↓ финальный текст
[ humanize brain (опц.) ] → живой текст
   ↓
[ Backchannel mp3 ] (мгновенно) → [ pause ] → [ TTS streaming ] → клиент
```

Логика **policy-first**: каждый ответ детерминирован шагом FSM, а brain только переписывает фразу по-человечески, не меняя смысл и факты.

---

## 2. Шаги (Finite State Machine)

| # | Шаг | Что делает | Что должно появиться в state | Куда переходит |
|---|---|---|---|---|
| 0 | `GREETING` | Приветствие, представление ассистента и студии | — | `ASK_NAME` |
| 1 | `ASK_NAME` | «Как обращаться?» | `customerName` | `ASK_LEARNER` |
| 2 | `ASK_LEARNER` | «Для себя или ребёнка?» | `learnerType ∈ {adult,child}` | `ASK_NEED` |
| 3 | `ASK_NEED` | Цель / направление | `direction` или `need` с явной семантикой | `ASK_AGE` если нужен возраст; иначе `ASK_BRANCH` |
| 4 | `ASK_AGE` | Возраст | `age` | `ASK_BRANCH`; `UNDERAGE_HANDOFF` если `age<4` |
| 5 | `ASK_BRANCH` | Филиал | `branch` | `OFFER` |
| 6 | `OFFER` | Один лучший слот | `selectedSlotId` | `ASK_PHONE` если согласие; `OFFER_NEXT`; `OBJECTION` |
| 7 | `OFFER_NEXT` | Следующий слот | `offeredSlotIndex+1` | `OFFER` или `SWITCH_BRANCH` |
| 8 | `SWITCH_BRANCH` | Переключиться на другой филиал | `branch=другой` | `OFFER` |
| 9 | `ASK_PHONE` | Номер телефона | `phone` (валидный формат) | `ASK_CONSENT` |
| 10 | `ASK_CONSENT` | Согласие на обработку данных | `personalDataConsent=true` | `BOOK` |
| 11 | `BOOK` | Создание брони + decrement availability | `bookingId` | `CONFIRM` |
| 12 | `CONFIRM` | Подтверждение факта записи | — | `WRAPUP` |
| 13 | `WRAPUP` | Прощание | — | END |
| 14 | `HANDOFF` | Передача админу | `handoffReason`, `handoffSummary` | END |

### 2.1. Критерии перехода (gating)

```ts
type Gate = {
  required: (keyof State)[];           // обязательные поля
  validators: ((s: State) => boolean)[];// дополнительные проверки
  retries: number;                      // сколько раз можно переспросить
  onMaxRetries: "handoff" | "skip";
};
```

| Шаг | required | validators | retries | onMaxRetries |
|---|---|---|---|---|
| ASK_NAME | `customerName` | length≥2, не приветствие, не generic noun | 2 | handoff |
| ASK_LEARNER | `learnerType` | ∈ {adult,child} | 2 | skip → ASK_NEED (default adult) |
| ASK_NEED | `direction` ∨ `hasClearNeed(need)` | direction в whitelist | 2 | handoff |
| ASK_AGE | `age` | 2≤age≤99 | 2 | handoff |
| ASK_BRANCH | `branch` | ∈ {Развилка,Озеро,Школьная} | 2 | handoff |
| OFFER | `selectedSlotId` | `freePlaces>0`, clientVisible, ageMatch | 3 | switch_branch → handoff |
| ASK_PHONE | `phone` | matches `^(\+7|8)\d{10}$` | 2 | handoff |
| ASK_CONSENT | `personalDataConsent` | explicit positive | 1 | handoff |
| BOOK | booking succeeds | freePlaces>0 на момент BOOK | 1 (no double-charge) | handoff |

---

## 3. Боковые / cross-cutting шаги

Могут вызваться **с любого основного шага** — приоритет выше основного потока.

| Шаг | Триггер | Действие | Возврат |
|---|---|---|---|
| `HANDOFF_REQUEST` | «оператор», «менеджер», «человек», «переключи», «руководитель» | Немедленно HANDOFF | END |
| `BOT_QUESTION` | «вы бот?», «ии?», «не бот?» | Честный ответ + продолжить с current step | back to current |
| `PRICE_QUESTION` | «сколько стоит?», «цена?» | Назвать цену + продолжить | back to current |
| `ADDRESS_QUESTION` | «где вы?», «адрес?» | Назвать адрес выбранного филиала или предложить выбрать | back to current |
| `TEACHER_QUESTION` | «кто ведёт?», «педагог?» | Назвать педагога предложенного слота | back to current |
| `OBJECTION_THINKING` | «подумаю», «надо посоветоваться» | «Пробное как раз для этого, могу подержать место» | back to OFFER |
| `OBJECTION_FAR` | «далеко» | SWITCH_BRANCH | OFFER |
| `OBJECTION_NO_TIME` | «нет времени», «занят» | Предложить др. день/время | back to OFFER |
| `OBJECTION_SHY` | «стесняюсь», «не умею» | «Многие приходят с нуля» + повторить slot | back to OFFER |
| `CLARIFY` | STT empty, confidence<0.7, или extraction пустое | «Не расслышала, повторите?» | back to current; на 2-й раз → HANDOFF |
| `BARGE_IN` | клиент заговорил во время TTS | Stop TTS, restart listen | back to current |
| `SILENCE` | >5 сек тишины | «Алло, вы тут?» | back to current; >15 сек → HANDOFF |
| `LOOP_GUARD` | один и тот же step 2 раза подряд | HANDOFF | END |

---

## 4. Слой «человечности» (без клонирования голоса)

Чтобы клиент не понял, что говорит с ботом.

### 4.1. Имитация задержки и backchannels

Между распознаванием реплики клиента и началом основного TTS:
1. **Backchannel (≈400-1500 мс)** — короткий пре-сгенерированный аудиосемпл подтверждения. Ставится только когда клиент дал содержательный ответ.
2. **Thinking delay (150-1000 мс)** — короткая тишина «читает CRM».
3. **Streaming TTS** — основной ответ.

Backchannel mapping (используется только когда клиент дал содержательный ответ):

| Action | Backchannel | Thinking delay |
|---|---|---|
| `ask_name` | — | 150 мс |
| `ask_learner` | — | 150 мс |
| `ask_need` | «Так, поняла.» | 400-650 мс |
| `ask_age` | «Угу-угу,» | 350-600 мс |
| `ask_branch` | «Так, поняла.» | 350-600 мс |
| `offer_solution` | «Так, секунду, гляну.» | 700-1100 мс |
| `ask_phone` | «Хорошо, удобно.» | 300-500 мс |
| `ask_consent` | — | 200 мс |
| `booked` | — | 200 мс |
| `handoff` | — | 200 мс |

### 4.2. Voice settings (одна персона: «Анна», ElevenLabs Flash v2.5)

Базовый пресет:
- `stability=0.45`, `similarity_boost=0.85`, `style=0.35`, `speed=0.96`, `use_speaker_boost=true`
- модель `eleven_flash_v2_5`
- output_format `mp3_44100_128` для веба, `ulaw_8000` для телефонии

Эмоциональные пресеты (TODO):
- greeting (теплее): style=0.5
- offer (деловой): style=0.3
- empathic (сочувствие): stability=0.55, style=0.45
- joyful (радость booked): style=0.55

### 4.3. Pronunciation map

«Studio 108», «Hip-hop», «K-pop», «Salsa/Bachata», «Псекупская», «Развилка» и др. → корректное русское произношение перед TTS.

### 4.4. Гуманизация скрипта

- Каждый fallback — 3-7 вариантов (см. `services/replyVariants.ts`).
- Brain переписывает fallback по-человечески, не меняя факты.
- Постфильтр (`cleanHumanReply`):
  - убирает звуки-филлеры в начале реплики («А-а-а», «М-м-м», «Эээ»),
  - заменяет мужской род 1sg на женский для ассистента-женщины,
  - убирает канцелярит.
- Промпт явно требует «не начинай ответ с междометий, не передразнивай клиента».

### 4.5. Запрещённые признаки бота

- Ровный, мгновенный ответ без задержки.
- Идеальная грамматика и одинаковая структура каждого ответа.
- Никогда не делает паузы, не «соображает», не комментирует.
- Никогда не переспрашивает, не корректируется.

---

## 5. Защиты репутации

| Защита | Что делает |
|---|---|
| **Loop guard** | 2 одинаковых action подряд → HANDOFF |
| **Handoff triggers** | Список слов сразу выводит на админа |
| **Bot-question disclosure** | Честный ответ, не врать о природе |
| **Underage handoff** | `age<4` → HANDOFF без booking |
| **Confidence retry** | STT/NLU confidence низкий → CLARIFY → HANDOFF после 2-го раза |
| **Banned phrases** | «обязательно подойдёт», «100% запишем», «бесплатно» — фильтр |
| **Tool-only truth** | Расписание/цена/адрес — только из tool, brain не выдумывает |
| **Re-check at BOOK** | freePlaces проверяется ещё раз на момент записи |

---

## 6. Слои поверх (для «идеально работает»)

### A. Слой понимания (NLU)
1. Confidence scoring на каждом turn.
2. Multi-fact extraction за 1 turn.
3. Coreference / память: «уже сказал X» — не переспрашивать.
4. Temporal parsing: «завтра», «после школы», «в выходные».
5. Sentiment tracking: устал/раздражён → switch tone.

### B. Слой данных и tools
6. Tool-only truth (см. 5).
7. Real-time availability с пере-проверкой на BOOK.
8. CRM sync: каждый booking + transcript + outcome.
9. Persistence на reconnect: state по phone+timestamp.

### C. Слой доверия (factual safety)
10. Schema validation на reply: упомянутые цифры/даты/имена должны быть в state/tools.
11. Banned phrase list.
12. Consent disclosure (152-ФЗ).
13. Honest disclosure если спросили.

### D. Reliability и observability
14. Structured logs every turn (JSONL): `{turnId, userText, sttConfidence, extractedFacts, action, replyText, ttsLatency, totalLatency}`.
15. Daily admin review: 10 диалогов/день → rating + комментарий.
16. Test pack: 50-100 голосовых записей с ground truth → regression check перед релизом.
17. Drop-off метрика per step.
18. Latency SLO: P95 first-byte TTS < 800 мс.
19. Conversion funnel dashboard.

### E. Качество речи
20. Эмоциональные пресеты voice_settings (4-5).
21. Контекстуальный темп: после «подумаю» — медленнее.
22. Расширенный набор backchannels (15-20 семплов).
23. Adaptive backchannel: «понимаю» в эмоциональных моментах.

### F. Бизнес-эскалации
24. Continuity: повторный контакт того же phone → «Анна, я с вами вчера разговаривала».
25. Reminders pipeline: за день / за 2 часа / после пробного.
26. Post-trial follow-up: «Понравилось? Хотите абонемент?».
27. Handoff routing к свободному админу с контекстом.

### G. Управление изменениями
28. Feature flags на каждое поведение.
29. Канареечный rollout (5% → 25% → 100%).
30. Shadow mode для новых правил.

---

## 7. Метрики качества

Daily KPI:
- доля дозвонов > 20 сек
- конверсия в OFFER
- конверсия в BOOK
- конверсия BOOK → пришёл на пробное
- конверсия пробное → абонемент
- handoff rate (доля переключений на админа)
- mean latency end-to-end
- «спросил бот?» rate
- ошибок по расписанию/цене (= 0 — критическая метрика)

---

## 8. Roadmap по фазам

### Фаза 0 (готово)
- ✅ Streaming TTS с MediaSource
- ✅ STT через ElevenLabs Scribe v2
- ✅ Микрофон + VAD + barge-in в браузере
- ✅ Loop guard
- ✅ Handoff triggers + bot-question disclosure
- ✅ Backchannel сервис + thinking delay
- ✅ Имя-персонаж «Анна»
- ✅ Pronunciation map для русского
- ✅ Постфильтр гендера и филлеров
- ✅ Вариативность fallback-фраз

### Фаза 1 — надёжность (ближайшая)
- Confidence scoring + CLARIFY → HANDOFF
- Memory of known facts (не переспрашивать уже известное)
- Schema validation reply (никаких выдуманных фактов)
- Structured turn-log JSONL
- Handoff с полным контекстом для админа
- Drop-off dashboard

### Фаза 2 — реалистичность
- Эмоциональные пресеты voice_settings
- Расширение backchannel-ов до 15-20
- Adaptive backchannel по контексту
- Multi-fact extraction расширить
- Temporal parsing
- Test pack с 50 записями

### Фаза 3 — бизнес-инфраструктура
- Реальная телефония (SIP)
- CRM sync двусторонний
- Reminders pipeline
- Post-trial flow
- Continuity по повторному контакту
- Conversion funnel dashboard

### Фаза 4 — масштабирование
- Feature flags
- Канареечный rollout
- Shadow mode
- A/B по voice_settings и фразам
- Pilot с прослушкой 100% диалогов

---

## 9. Что **точно не делаем** (анти-цели)

- Холодный обзвон без согласия.
- Лгать клиенту, что бот — это человек.
- Обещать скидки/исключения, не зафиксированные правилами.
- Двойное бронирование (race condition без re-check).
- Отключать запись/прослушку диалогов.
- Расширять список направлений / филиалов без обновления knowledge base.
