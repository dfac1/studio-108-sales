# Cloudflare Tunnel — клиент тестирует голосом без хостинга

Идея: сервер крутится у тебя на ПК (`npm run dev` или `npm start`), а Cloudflare
бесплатно делает наружу HTTPS-адрес вида `https://xxx.trycloudflare.com`.
Карта не нужна, регистрация тоже (для quick-tunnel).

Минусы:
- ПК должен быть включён и не уходить в сон.
- Quick tunnel: URL меняется на каждый перезапуск `cloudflared`. Для постоянного — нужен CF-аккаунт (всё ещё бесплатно, см. ниже).

## Быстрый старт (5 минут, для разового теста)

### 1. Установить cloudflared

PowerShell от имени админа (winget есть в Windows 11):
```powershell
winget install --id Cloudflare.cloudflared
```

Или скачать exe напрямую: https://github.com/cloudflare/cloudflared/releases/latest
(файл `cloudflared-windows-amd64.exe`, переименовать в `cloudflared.exe`, положить в PATH).

Проверить:
```powershell
cloudflared --version
```

### 2. Запустить сервер локально

В одном окне терминала из `c:\Users\Андрей\Desktop\Sales`:
```powershell
npm run build
npm start
```

Сервер слушает `http://localhost:3108`. Должен быть доступен `/health`:
```powershell
curl http://localhost:3108/health
```

### 3. Запустить туннель (в другом окне)

```powershell
cloudflared tunnel --url http://localhost:3108
```

Через 5-10 секунд в логах появится строка:
```
Your quick Tunnel has been created! Visit it at:
https://какие-то-слова-через-дефис.trycloudflare.com
```

Это и есть публичный URL. HTTPS уже есть — микрофон в браузере у клиента будет работать.

### 4. Отдать клиенту

Скинь ссылку. Пока окно с `cloudflared` открыто — клиент может зайти.

> Закроешь окно или выключишь ПК — URL умрёт.

## Постоянный URL (если разовый теста мало)

Quick tunnel удобен, но URL меняется. Если хочется стабильную ссылку
(`studio-108.твой-домен.com` или `studio-108.cloudflareaccess.com`):

### Вариант A: с собственным доменом

Нужен домен на Cloudflare DNS (можно бесплатный с регистратора типа freenom,
но они почти все мертвы). Если есть купленный домен — переведи NS на CF (бесплатно).

```powershell
cloudflared tunnel login
# откроется браузер → залогинься в CF → выбери домен

cloudflared tunnel create studio-108
# создаст tunnel с UUID, сохранит креды в %USERPROFILE%\.cloudflared\

cloudflared tunnel route dns studio-108 sales.твой-домен.com
```

Создать `%USERPROFILE%\.cloudflared\config.yml`:
```yaml
tunnel: studio-108
credentials-file: C:\Users\Андрей\.cloudflared\<UUID>.json

ingress:
  - hostname: sales.твой-домен.com
    service: http://localhost:3108
  - service: http_status:404
```

Запуск:
```powershell
cloudflared tunnel run studio-108
```

URL `https://sales.твой-домен.com` — стабильный, переживает рестарт.

### Вариант B: без своего домена

Cloudflare даёт бесплатные субдомены через Cloudflare Access (Zero Trust),
но это сложнее настраивать. Для текущих задач — quick tunnel + перешли клиенту
свежую ссылку при каждом запуске. Проще не придумаешь.

## Автозапуск, чтобы не держать терминал

Если хочется чтобы сервер + туннель сами поднимались после ребута:

### Сервер через NSSM (Windows service)

```powershell
# Установить NSSM
winget install nssm.nssm

# Создать сервис
nssm install Studio108Sales "C:\Program Files\nodejs\node.exe" "C:\Users\Андрей\Desktop\Sales\dist\server.js"
nssm set Studio108Sales AppDirectory "C:\Users\Андрей\Desktop\Sales"
nssm set Studio108Sales AppEnvironmentExtra "NODE_ENV=production" "HOST=0.0.0.0" "PORT=3108"
nssm start Studio108Sales
```

### Туннель как сервис

```powershell
cloudflared service install
```

После этого `cloudflared` стартует с Windows, использует `config.yml` из
`%USERPROFILE%\.cloudflared\` (вариант A выше).

## Что проверить после деплоя

1. Открой `https://xxx.trycloudflare.com/health` — должен ответить `OK`.
2. Открой главную в инкогнито (чтобы не было кэша), нажми «Поговорить» —
   браузер должен спросить разрешение на микрофон, потом услышишь приветствие.
3. На стороне сервера в `data/conversations.jsonl` появится запись turn 0.

## Проблемы

### `cloudflared` не находится
Закрой и открой PowerShell после установки — путь обновится. Или укажи
полный путь: `C:\Program Files (x86)\cloudflared\cloudflared.exe`.

### Microphone permission denied
Браузер блокирует микрофон если сайт не HTTPS. Quick tunnel уже HTTPS,
проверь что URL начинается с `https://`, а не `http://`.

### Звук рваный / лаги
Cloudflare Tunnel добавляет задержку (~50-100 мс через Франкфурт). Для voice-чата
это терпимо, но если интернет у тебя слабый — TTS-стриминг может заикаться.
Проверь `ping 1.1.1.1` — должно быть < 50 мс.

### Окно `cloudflared` закрылось — клиент жалуется
Quick tunnel умирает с процессом. Перезапусти, дай новую ссылку. Или поставь
постоянный туннель (вариант A).

### URL `trycloudflare.com` заблокирован Роскомнадзором
Если клиент в РФ не может зайти — попроси открыть через VPN или поставь
постоянный туннель на своём домене (вариант A).
