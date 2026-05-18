# Deploy to Fly.io

Цель: поднять Studio 108 voice-sales на бесплатном Fly.io VM с HTTPS, 24/7 без сна,
persistent disk для логов и mp3-кэша.

## Одноразовая подготовка

### 1. Установить flyctl

PowerShell (Windows):
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

После установки откройте новый терминал и проверьте:
```
fly version
```

### 2. Зарегистрироваться / залогиниться

```
fly auth signup
```
или, если аккаунт уже есть:
```
fly auth login
```

> Fly.io требует привязать карту даже для free tier (защита от абуза). 3 small VM и 3 GB
> volume бесплатны. Платить не будет, если не выходить за лимиты.

## Первый деплой

Из корня проекта `c:\Users\Андрей\Desktop\Sales`:

### 3. Создать приложение (имя зафиксировано в fly.toml)

```
fly apps create studio-108-sales
```

Если имя занято — поменяйте `app = "..."` в `fly.toml` на свободное.

### 4. Создать persistent volume для данных (1 GB бесплатно)

```
fly volumes create sales_data --region fra --size 1
```

> Регион должен совпадать с `primary_region` в `fly.toml` (fra).

### 5. Загрузить секреты из локального .env

В PowerShell (берёт все строки `KEY=VALUE` из `.env`, отправляет в Fly):
```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.+)$') {
    fly secrets set --stage "$($Matches[1])=$($Matches[2])"
  }
}
fly secrets deploy
```

> `--stage` копит изменения, чтобы все секреты применились одним рестартом.

Проверить что секреты загрузились:
```
fly secrets list
```

### 6. Деплой

```
fly deploy
```

Сборка идёт в облаке Fly: они получают наш Dockerfile, билдят образ, заливают в свой
registry, запускают VM с volume. Первый деплой ~3-5 минут.

### 7. Открыть в браузере

```
fly open
```

Получите URL вида `https://studio-108-sales.fly.dev`. По нему клиент может зайти.
HTTPS уже есть — getUserMedia (микрофон) будет работать.

## Повседневная работа

### Посмотреть логи
```
fly logs
```

### Обновить код после правок
```
fly deploy
```

### Перезапустить без сборки
```
fly machine restart
```

### Обновить один секрет
```
fly secrets set ELEVENLABS_API_KEY=новый_ключ
```

### Зайти на VM по SSH
```
fly ssh console
```

### Скачать файлы с persistent volume (логи разговоров)
```
fly ssh sftp get /app/data/conversations.jsonl
```

## Что лежит в persistent volume

`/app/data/` — монтируется как `sales_data` volume. Содержит:
- `conversations.jsonl` — лог всех ходов диалога
- `bookings.jsonl` — созданные брони
- `handoffs.jsonl` — переключения на администратора
- `reminders.jsonl` — очередь напоминаний
- `tts-cache/*.mp3` — кэш синтезированных ответов
- `slot-availability.json` — текущее наличие мест в слотах

Это всё переживёт рестарты и деплои.

## Что НЕ лежит в volume и регенерируется на старте

- `public/audio/backchannels/*.mp3` — короткие сэмплы «угу/понимаю/секундочку».
- `public/audio/pregenerated/*.mp3` — pregenerated приветствия и шаблонные реплики.

Они в Docker-образе (из текущего локального состояния), поэтому **перед deploy убедись
что локально все mp3 на месте** (свежие, не старые). Если каких-то нет — сервер
синтезирует на старте через ElevenLabs (5–30 сек на холодный старт).

## Проблемы

### `Address already in use`
Один VM держит порт. `fly machine restart` обычно решает.

### Cloudflare 403 от ElevenLabs
Известное ограничение — IP-based rate limit от их CDN. У нас есть retry+keep-alive
(см. `elevenLabsKeepAlive.ts`). Если повторяется регулярно — Fly IPs могут быть в чёрном
списке CF. Альтернатива — добавить fallback на Yandex SpeechKit (сейчас отключён).

### Холодный старт после `auto_stop_machines = "off"` но всё равно VM спит
Проверь что `min_machines_running = 1` в fly.toml. Без этого Fly может остановить VM
после длительного простоя даже с `auto_stop = off`.

### Микрофон не работает у клиента
- Браузер не отдал permission — кнопка с замочком в URL.
- Не HTTPS — но у нас Fly даёт HTTPS автоматически.
- iOS Safari требует пользовательского click перед getUserMedia — это уже учтено
  в коде (`elements.liveButton.addEventListener`).
