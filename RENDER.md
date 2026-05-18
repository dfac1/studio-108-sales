# Deploy на Render.com (без карты)

Бот будет крутиться в US/EU, доступен по `https://studio-108-sales.onrender.com`.
VPN не нужен — сервер из облака ходит к ElevenLabs/Anthropic напрямую.

## Что есть и чего нет

**Плюсы Render free:**
- Не нужна карта
- HTTPS бесплатно
- Автодеплой из GitHub при push
- Docker-сборка в облаке

**Минусы Render free:**
- Засыпает после **15 мин простоя**. Первый запрос после сна = 30-60 сек холодный старт. Клиента надо предупредить: «при первом заходе подожди минуту».
- **Нет persistent disk** — `data/conversations.jsonl`, `bookings.jsonl`, `tts-cache/*.mp3` живут пока сервис работает, теряются на рестарте/деплое.
- 512 MB RAM, 0.1 CPU — нагружать не стоит.
- 750 ч/мес — хватает на ~24/7 один сервис.

Для разовых демонстраций клиенту — норм. Если станет основным проде — переходим
на платный план Render ($7/мес) с persistent disk и без сна.

## Подготовка

### 1. GitHub аккаунт и репозиторий

Render тянет код из git. Самый простой путь — **GitHub** (бесплатно, без карты).

1. Зарегистрируйся на https://github.com (если ещё нет аккаунта)
2. Создай новый **приватный** репозиторий: https://github.com/new
   - Repository name: `studio-108-sales`
   - Visibility: **Private**
   - НЕ ставь галку «Add README/license» — мы пушим свой код

После создания GitHub покажет URL вида `https://github.com/<твой-логин>/studio-108-sales.git`.

### 2. Инициализировать git и запушить

В PowerShell из `c:\Users\Андрей\Desktop\Sales`:

```powershell
# Установить git если ещё нет:
winget install --id Git.Git

# Открой новый терминал чтобы git появился в PATH, потом:
git init
git branch -M main
git add .
git commit -m "Initial commit: Studio 108 voice sales bot"
git remote add origin https://github.com/<твой-логин>/studio-108-sales.git
git push -u origin main
```

При первом push GitHub попросит авторизоваться через браузер — соглашайся.

> `.env` НЕ попадёт в репозиторий (исключён в `.gitignore`). Секреты передадим через UI Render.

### 3. Регистрация на Render

1. https://render.com/register
2. Sign up with **GitHub** (одной кнопкой, без карты)
3. Подтверди email

### 4. Подключить репозиторий

1. В дашборде Render: **New +** → **Web Service**
2. Connect **GitHub** account → разреши доступ к репозиторию `studio-108-sales`
3. Выбери репозиторий из списка → **Connect**

### 5. Настройки сервиса

Render автоматически прочитает `render.yaml` (Blueprint) и предзаполнит большинство полей.
Проверь:

| Поле | Значение |
|------|----------|
| Name | `studio-108-sales` (или твоё) |
| Region | `Frankfurt` |
| Branch | `main` |
| Runtime | `Docker` |
| Dockerfile Path | `./Dockerfile` |
| Plan | **Free** |

### 6. Секреты (Environment Variables)

В разделе **Environment** добавь все ключи из локального `.env`. Минимум:

```
ELEVENLABS_API_KEY = sk_xxx...
ELEVENLABS_VOICE_ID = xxx
ANTHROPIC_API_KEY  = sk-ant-xxx...
```

И опциональные, если в `.env` они есть:
```
ELEVENLABS_MODEL_ID
ELEVENLABS_STT_MODEL_ID
ELEVENLABS_OUTPUT_FORMAT
ANTHROPIC_DIALOG_MODEL
ANTHROPIC_EXTRACTION_MODEL
ADMINS_JSON
ASSISTANT_NAME
```

> `PORT` и `HOST` НЕ задавай вручную — Render сам выставит PORT, а HOST в Dockerfile.

### 7. Деплой

Жми **Create Web Service**. Render начнёт собирать Docker-образ (4-7 минут на первый
билд), потом запустит. Логи стримятся в дашборде.

Когда увидишь в логах строку `server listening at http://0.0.0.0:NNNN` и статус
**Live** — открой URL вида `https://studio-108-sales.onrender.com`. Это и есть
ссылка для клиента.

## Повседневная работа

### Обновить код
```powershell
git add -A
git commit -m "Что поменялось"
git push
```
Render сам подхватит push и передеплоит (3-5 мин).

### Посмотреть логи
В дашборде Render → твой сервис → **Logs**. Стримятся в реальном времени.

### Обновить секрет
Дашборд → **Environment** → измени значение → **Save Changes**. Render рестартанёт сервис.

### Зайти на сервер shell-ом
Free план shell не даёт. На paid есть `Shell` в дашборде.

## Что делать со «сном»

Render-free засыпает после 15 мин без HTTP-запросов. Это плохо для голосового бота —
клиент откроет ссылку и будет ждать 30 сек пока контейнер просыпается.

Workarounds:
1. **Cron-ping снаружи** — UptimeRobot.com (free) пингует `/health` каждые 5 мин,
   контейнер не засыпает. Render это не запрещает на free.
   - Зарегистрируйся на https://uptimerobot.com (без карты)
   - New Monitor → HTTPS → URL `https://studio-108-sales.onrender.com/health` → Interval **5 minutes**
2. **Предупреди клиента** — «нажми ссылку, подожди минуту до приветствия». Без UptimeRobot подойдёт.
3. **Платный план** — $7/мес, не засыпает + persistent disk.

## Проблемы

### Build fails: «no space left on device»
Возможно, в репо попало много мусора. Проверь `.gitignore` — должны быть исключены
`node_modules/`, `dist/`, `data/tts-cache/`, `data/*.jsonl`, `*.log`.

### Bot отвечает 503/504
Контейнер ещё просыпается. Подожди 30-60 сек, обнови страницу.

### ElevenLabs 401 / 403 на проде
Проверь что `ELEVENLABS_API_KEY` правильно скопирован в Environment (без пробелов).
Дашборд Render → Environment → значения видны только при «Reveal».

### Микрофон у клиента не работает
Render даёт HTTPS — должен работать. Проверь что URL начинается с `https://`,
а не `http://`. Если клиент на iOS Safari — нужно нажать кнопку «Поговорить»
сначала, потом разрешение на микрофон выскочит.

### Логи разговоров «пропадают»
Это норма для free плана (нет persistent disk). На каждый деплой/рестарт `data/`
обнуляется (кроме того что внутри образа). Если важно сохранять `conversations.jsonl`
между перезапусками — переходи на paid + добавь Disk в Render UI.
