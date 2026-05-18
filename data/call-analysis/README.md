Сюда кладем реальные звонки для разбора.

Минимальная структура:

- `inbox/` — сырые файлы
- `work/` — служебные результаты
- `reports/` — сводки

Пример одной записи в `inbox/`:

```text
call-001.mp3
call-001.meta.json
call-001.transcript.txt
```

Дальше используем команды:

```bash
npm run calls:prepare
npm run calls:transcribe
npm run calls:review
```
