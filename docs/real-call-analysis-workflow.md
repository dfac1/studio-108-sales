# Анализ реальных звонков

Этот контур нужен, чтобы мы не слушали звонки хаотично, а системно превращали их в правки продукта.

## Что уже подготовлено

- Workspace для файлов звонков: `data/call-analysis`
- Подготовка манифеста: [scripts/prepare-call-analysis.ts](</C:/Users/Андрей/Desktop/Sales/scripts/prepare-call-analysis.ts>)
- Пакетная транскрибация: [scripts/transcribe-call-batch.ts](</C:/Users/Андрей/Desktop/Sales/scripts/transcribe-call-batch.ts>)
- Пакетный review: [scripts/review-call-batch.ts](</C:/Users/Андрей/Desktop/Sales/scripts/review-call-batch.ts>)
- Сервисная логика: [callAnalysis.ts](</C:/Users/Андрей/Desktop/Sales/src/services/callAnalysis.ts>)
- Review brain: [callReviewBrain.ts](</C:/Users/Андрей/Desktop/Sales/src/services/callReviewBrain.ts>)

## Структура папок

```text
data/call-analysis/
  inbox/         <- сюда просто складываем реальные файлы
  work/
    manifests/   <- служебные манифесты
    transcripts/ <- расшифровки
    reviews/     <- review по каждому звонку
  reports/       <- сводные markdown-отчеты
  archive/       <- позже можно переносить обработанные партии
```

## Как лучше класть файлы

Лучше всего одной группой на звонок с одинаковым stem:

```text
call-001.mp3
call-001.meta.json
call-001.transcript.txt
```

или

```text
2026-05-05-anna-01.ogg
2026-05-05-anna-01.meta.json
```

Поддерживаются:

- аудио: `.mp3`, `.wav`, `.ogg`, `.m4a`, `.webm`, `.mp4`
- текстовые транскрипты: `.txt`, `.md`
- metadata: `.json`

## Пример metadata

```json
{
  "externalId": "crm-1042",
  "callStartedAt": "2026-05-05T14:10:00+03:00",
  "channel": "inbound_call",
  "callerPhoneMasked": "+7***1234567",
  "managerName": "Анна",
  "branchHint": "Развилка",
  "directionHint": "Hip-hop",
  "outcomeHint": "not_booked",
  "notes": "Мама ребенка, 5 лет"
}
```

## Команды

Подготовить манифест:

```bash
npm run calls:prepare
```

Распознать аудио в транскрипты:

```bash
npm run calls:transcribe
```

Сделать review по партии:

```bash
npm run calls:review
```

## Что review будет искать

1. Пропуски шагов:
   имя, для кого, потребность, возраст, филиал, предложение, телефон, согласие, подтверждение.

2. Логические ошибки:
   прыжки по шагам, слишком много вопросов в одной реплике, слабое закрытие, слабая работа с возражением.

3. Язык:
   канцелярит, психологические слова, неестественные формулировки, слишком длинные реплики.

4. TTS-риски:
   ломкие слова, неудачные формулировки для ElevenLabs, рискованные слова с неочевидным ударением.

5. Бизнес-правила:
   неправильные цены, филиалы, запретные предложения, кривой подбор.

## Что будет на выходе

### На каждый звонок

JSON review в:

```text
data/call-analysis/work/reviews/<stem>.json
```

### На партию

Markdown-отчет:

```text
data/call-analysis/reports/latest-review-report.md
```

В нем будут:

- частые категории ошибок
- частые правки в prompt
- частые правки в скрипт
- рискованные TTS-фразы
- краткий вердикт по каждому звонку

## Как потом вносить правки

На основе отчета изменения обычно идут в четыре места:

1. [salesDialog.ts](</C:/Users/Андрей/Desktop/Sales/src/services/salesDialog.ts>)  
   если проблема в шаге, бизнес-логике или маршруте диалога.

2. [salesPrompts.ts](</C:/Users/Андрей/Desktop/Sales/src/services/salesPrompts.ts>)  
   если проблема в стиле ответа, естественности речи или ограничениях модели.

3. [russianSpeech.ts](</C:/Users/Андрей/Desktop/Sales/src/services/russianSpeech.ts>)  
   если проблема в TTS, ударениях, цифрах, адресах, времени.

4. [dialog-smoke.ts](</C:/Users/Андрей/Desktop/Sales/scripts/dialog-smoke.ts>)  
   если найденный баг нужно закрепить тестовым сценарием.

## Что лучше принести вместе с звонками

- аудио
- если есть, исходную CRM-пометку по результату
- филиал / направление, если уже известны
- короткую ручную пометку, почему звонок важен

Это сильно ускорит реальную шлифовку менеджера.
