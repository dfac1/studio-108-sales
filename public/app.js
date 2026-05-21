const state = {
  dialog: {},
  slots: [],
  selectedSlotId: null,
  lastAssistantReply: ""
};

// Streaming pipeline: при ?streaming=1 в URL клиент использует /api/voice/turn-stream
// вместо /api/voice/turn. Сервер шлёт NDJSON: start → sentence(s) → final.
// TTS для каждого предложения запускается сразу как только сервер его прислал —
// первый аудио-байт пользователя достигает на ~1 сек раньше при длинных репликах.
// По умолчанию off, чтобы основной поток оставался стабильным.
const STREAMING_TURN_ENABLED = new URLSearchParams(location.search).get("streaming") === "1";

const elements = {
  serverStatus: document.querySelector("#serverStatus"),
  leadForm: document.querySelector("#leadForm"),
  messages: document.querySelector("#messages"),
  promptForm: document.querySelector("#promptForm"),
  transcriptInput: document.querySelector("#transcriptInput"),
  slotList: document.querySelector("#slotList"),
  bookingBox: document.querySelector("#bookingBox"),
  speakButton: document.querySelector("#speakButton"),
  audioPlayer: document.querySelector("#audioPlayer"),
  resetButton: document.querySelector("#resetButton"),
  liveButton: document.querySelector("#liveButton"),
  liveStatus: document.querySelector("#liveStatus"),
  liveDot: document.querySelector("#liveDot"),
  liveText: document.querySelector("#liveText"),
  levelFill: document.querySelector("#levelFill")
};

function getLeadData() {
  const data = new FormData(elements.leadForm);
  const ageText = String(data.get("age") || "").trim();
  return {
    sttProvider: String(data.get("sttProvider") || "").trim() || "elevenlabs",
    ttsProvider: String(data.get("ttsProvider") || "").trim() || "elevenlabs",
    customerName: String(data.get("customerName") || "").trim(),
    phone: String(data.get("phone") || "").trim(),
    age: ageText ? Number(ageText) : undefined,
    direction: String(data.get("direction") || "").trim() || undefined,
    branch: String(data.get("branch") || "").trim() || undefined,
    consent: {
      personalData: data.get("personalData") === "on",
      aiVoiceDisclosure: data.get("aiVoiceDisclosure") === "on",
      crossBorderTransfer: data.get("crossBorderTransfer") === "on",
      callRecording: false
    }
  };
}

function appendMessage(role, text) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = text;
  elements.messages.append(node);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  if (role === "assistant") {
    state.lastAssistantReply = text;
  }
  return node;
}

function renderSlots(slots) {
  elements.slotList.innerHTML = "";
  state.slots = slots || [];

  if (!state.slots.length) {
    elements.slotList.innerHTML = '<div class="slot-meta">Подходящие слоты появятся после ответа ассистента.</div>';
    return;
  }

  for (const slot of state.slots) {
    const item = document.createElement("article");
    item.className = "slot-item";
    item.innerHTML = `
      <div class="slot-title">${slot.weekday}, ${slot.time} · ${slot.branch}</div>
      <div>${slot.direction}${slot.level ? `, ${slot.level}` : ""}</div>
      <div class="slot-meta">Педагог: ${slot.teacher}</div>
      <div class="slot-meta">Свободно: ${slot.freePlaces} из ${slot.capacity}</div>
      <button type="button" data-slot-id="${slot.id}">Подставить ответ</button>
    `;
    elements.slotList.append(item);
  }
}

async function requestAssistant(message, signal) {
  const lead = getLeadData();
  state.dialog = {
    ...state.dialog,
    customerName: lead.customerName || state.dialog.customerName,
    phone: lead.phone || state.dialog.phone,
    age: Number.isFinite(lead.age) ? lead.age : state.dialog.age,
    direction: lead.direction || state.dialog.direction,
    branch: lead.branch || state.dialog.branch,
    personalDataConsent: lead.consent.personalData || state.dialog.personalDataConsent,
    aiVoiceDisclosure: lead.consent.aiVoiceDisclosure,
    crossBorderTransfer: lead.consent.crossBorderTransfer
  };

  const response = await fetch("/api/voice/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      state: { ...state.dialog, lastInterruption: state.lastInterruption ?? undefined },
      providers: {
        stt: lead.sttProvider,
        tts: lead.ttsProvider
      }
    }),
    signal
  });
  // Прерывание учитывается один раз — сбрасываем после отправки.
  state.lastInterruption = null;

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

// Маппинг текущего шага диалога → voice preset для TTS. В streaming-режиме
// preset нужен ДО прихода final-события, поэтому полагаемся на known step.
function presetFromStep(step) {
  switch (step) {
    case "ask_name": return "greeting";
    case "offer_slot": return "business";
    case "ask_phone":
    case "ask_consent": return "business";
    case "handoff": return "empathic";
    case "booked": return "joyful";
    default: return "default";
  }
}

// Streaming-вариант диалогового turn'а. Открывает NDJSON-стрим к /api/voice/turn-stream,
// для каждого пришедшего предложения немедленно начинает TTS-стрим в общий MediaSource.
// Возвращает финальный VoiceTurnResult (для обновления state/slots/booking).
async function runStreamingTurn(message, signal) {
  const lead = getLeadData();
  const dialogPayload = {
    ...state.dialog,
    customerName: lead.customerName || state.dialog.customerName,
    phone: lead.phone || state.dialog.phone,
    age: Number.isFinite(lead.age) ? lead.age : state.dialog.age,
    direction: lead.direction || state.dialog.direction,
    branch: lead.branch || state.dialog.branch,
    personalDataConsent: lead.consent.personalData || state.dialog.personalDataConsent,
    aiVoiceDisclosure: lead.consent.aiVoiceDisclosure,
    crossBorderTransfer: lead.consent.crossBorderTransfer,
    lastInterruption: state.lastInterruption ?? undefined
  };

  const response = await fetch("/api/voice/turn-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, state: dialogPayload, providers: { stt: lead.sttProvider, tts: lead.ttsProvider } }),
    signal
  });
  state.lastInterruption = null;
  if (!response.ok || !response.body) {
    throw new Error(await response.text().catch(() => "stream open failed"));
  }

  // Готовим один MediaSource на весь turn — все предложения добавляются в ту же очередь.
  stopActiveStream();
  const supportsMse = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported && MediaSource.isTypeSupported("audio/mpeg");

  const controller = new AbortController();
  activeStreamAbort = controller;
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let mediaSource = null;
  let sourceBuffer = null;
  const queue = [];
  let ended = false;
  let pumping = false;
  let playbackStarted = false;
  let currentStep = "ask_name";

  function pump() {
    if (!sourceBuffer || pumping) return;
    if (sourceBuffer.updating) return;
    if (queue.length === 0) {
      if (ended && mediaSource && mediaSource.readyState === "open") {
        try { mediaSource.endOfStream(); } catch {}
      }
      return;
    }
    pumping = true;
    const chunk = queue.shift();
    try { sourceBuffer.appendBuffer(chunk); } catch (err) {
      console.error("appendBuffer failed", err);
      pumping = false;
    }
  }

  async function ensureMediaSource() {
    if (mediaSource || !supportsMse) return;
    mediaSource = new MediaSource();
    activeMediaSource = mediaSource;
    const previous = elements.audioPlayer.src;
    elements.audioPlayer.src = URL.createObjectURL(mediaSource);
    elements.audioPlayer.hidden = false;
    if (previous && previous.startsWith("blob:")) URL.revokeObjectURL(previous);
    await new Promise((resolve) => mediaSource.addEventListener("sourceopen", resolve, { once: true }));
    sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
    sourceBuffer.addEventListener("updateend", () => { pumping = false; pump(); });
  }

  // ПАРАЛЛЕЛЬНЫЕ TTS-запросы с in-order drain.
  // Раньше fetch для sentence #2 ждал пока #1 полностью догрузится — это давало
  // слышимый шов 400-600мс между предложениями (latency первого байта ElevenLabs).
  // Теперь: каждое предложение получает свой fetch немедленно, чанки копятся
  // в pendingSentences[i].chunks, а drain() сливает их в MediaSource queue
  // СТРОГО В ПОРЯДКЕ ПРИХОДА ПРЕДЛОЖЕНИЙ. Пока #1 играет, #2 уже грузится в фон —
  // шов между ними обычно исчезает.
  const pendingSentences = [];       // [{ chunks: [], done: bool }]
  let playingIndex = 0;
  const sentencePromises = [];        // для финального await перед закрытием

  function drain() {
    while (playingIndex < pendingSentences.length) {
      const current = pendingSentences[playingIndex];
      while (current.chunks.length > 0) {
        queue.push(current.chunks.shift());
        pump();
        if (!playbackStarted) {
          playbackStarted = true;
          elements.audioPlayer.play().catch(() => {});
        }
      }
      if (!current.done) return;     // ждём ещё чанков этого предложения
      playingIndex++;                 // переходим к следующему
    }
  }

  function dispatchSentenceTts(sentenceText) {
    const entry = { chunks: [], done: false };
    pendingSentences.push(entry);
    const p = (async () => {
      if (!supportsMse) {
        try { await speakViaSimpleEndpoint(sentenceText); } catch (err) { console.warn("fallback tts failed", err); }
        entry.done = true;
        return;
      }
      await ensureMediaSource();
      try {
        const resp = await fetch("/api/tts/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: sentenceText,
            outputFormat: "mp3_44100_128",
            voicePreset: presetFromStep(currentStep)
          }),
          signal: controller.signal
        });
        if (!resp.ok || !resp.body) {
          console.error("tts/stream non-ok", await resp.text().catch(() => ""));
          entry.done = true;
          drain();
          return;
        }
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.chunks.push(value);
          drain();
        }
        entry.done = true;
        drain();
      } catch (err) {
        if (err?.name !== "AbortError") console.error("sentence tts failed", err);
        entry.done = true;
        drain();
      }
    })();
    sentencePromises.push(p);
  }

  // Читаем NDJSON: одна JSON-строка на строку.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === "start") {
        currentStep = evt.currentStep || currentStep;
      } else if (evt.type === "sentence" && typeof evt.text === "string") {
        dispatchSentenceTts(evt.text);
      } else if (evt.type === "final") {
        finalResult = evt;
        // Обновим currentStep по action для корректного preset на ещё-не-стартовавших TTS.
        if (evt.action) currentStep = evt.state?.stage || currentStep;
      } else if (evt.type === "error") {
        throw new Error(evt.message || "stream error");
      }
    }
  }

  if (!finalResult) throw new Error("stream closed without final event");

  // Fallback для детерминированных путей: consent finalize / phone accumulator / handoff
  // НЕ зовут LLM, поэтому onSentence не срабатывает — sentence-events не приходят.
  // ВАЖНО: проверяем именно `pendingSentences.length`, а не `playbackStarted`.
  // Sentence-event'ы могли уже прийти и зарегистрировать TTS-fetch'и, но fetch ещё
  // не успел до первого байта дойти к моменту прихода final. По playbackStarted
  // мы бы повторно сыграли весь reply поверх уже идущего стрима — дубль.
  if (pendingSentences.length === 0 && finalResult.reply) {
    if (finalResult.pregeneratedAudioUrl) {
      try {
        const previous = elements.audioPlayer.src;
        elements.audioPlayer.src = finalResult.pregeneratedAudioUrl;
        elements.audioPlayer.hidden = false;
        await elements.audioPlayer.play().catch(() => {});
        if (previous && previous.startsWith("blob:")) URL.revokeObjectURL(previous);
      } catch (err) {
        console.warn("pregenerated fallback failed", err);
        dispatchSentenceTts(finalResult.reply);
      }
    } else {
      dispatchSentenceTts(finalResult.reply);
    }
  }

  // Ждём пока ВСЕ параллельные TTS-запросы дойдут до конца, затем закрываем MediaSource.
  await Promise.all(sentencePromises).catch(() => {});
  ended = true;
  pump();

  return finalResult;
}

async function createBooking(slotId) {
  const lead = getLeadData();
  const slot = state.slots.find((candidate) => candidate.id === slotId);

  if (!slot) {
    throw new Error("Слот не найден.");
  }

  if (!lead.customerName || !lead.phone) {
    throw new Error("Укажите имя и телефон клиента.");
  }

  if (!lead.consent.personalData || !lead.consent.aiVoiceDisclosure) {
    throw new Error("Для записи нужны служебный флаг сценария и согласие на обработку данных.");
  }

  const response = await fetch("/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: lead.customerName,
      phone: lead.phone,
      age: lead.age,
      direction: lead.direction || slot.direction,
      branch: slot.branch,
      slotId,
      source: "inbound_form",
      notes: "Создано через веб-тест",
      consent: lead.consent
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

async function checkHealth() {
  try {
    const response = await fetch("/health");
    if (!response.ok) throw new Error("bad status");
    elements.serverStatus.textContent = "Онлайн";
    elements.serverStatus.className = "status-pill ok";
  } catch {
    elements.serverStatus.textContent = "Нет связи";
    elements.serverStatus.className = "status-pill bad";
  }
}

elements.promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const transcript = elements.transcriptInput.value.trim();
  if (!transcript) return;

  appendMessage("user", transcript);
  elements.transcriptInput.value = "";

  try {
    if (STREAMING_TURN_ENABLED) {
      // Streaming-режим: runStreamingTurn сам пушит TTS по предложению.
      // Текст финальной реплики и slots/booking приходят в final-событии в конце.
      const result = await runStreamingTurn(transcript);
      state.dialog = result.state || {};
      appendMessage("assistant", result.reply);
      renderSlots(result.slots);
      elements.bookingBox.className = "booking-box";
      elements.bookingBox.textContent = result.booking ? `Запись создана: ${result.booking.customerName}, ${result.booking.phone}.` : "";
      if (result.booking) elements.bookingBox.className = "booking-box success";
      // TTS уже отыграл sentence-by-sentence — streamAssistantSpeech не вызываем.
      return;
    }
    const result = await requestAssistant(transcript);
    state.dialog = result.state || {};
    appendMessage("assistant", result.reply);
    renderSlots(result.slots);
    elements.bookingBox.className = "booking-box";
    elements.bookingBox.textContent = result.booking ? `Запись создана: ${result.booking.customerName}, ${result.booking.phone}.` : "";
    if (result.booking) {
      elements.bookingBox.className = "booking-box success";
    }
    streamAssistantSpeech(result.reply, result.voicePreset, result.pregeneratedAudioUrl, result.action).catch((error) => console.error("auto speak failed", error));
  } catch (error) {
    appendMessage("assistant", "Не получилось обработать заявку. Проверьте сервер и данные.");
    console.error(error);
  }
});

elements.slotList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-slot-id]");
  if (!button) return;

  const index = state.slots.findIndex((slot) => slot.id === button.dataset.slotId);
  if (index >= 0) {
    elements.transcriptInput.value = `${weekdayFull(state.slots[index].weekday)} в ${state.slots[index].time} подходит`;
    elements.transcriptInput.focus();
  }
});

// Запись создает диалоговый сценарий после выбора, телефона и согласия.

elements.resetButton.addEventListener("click", () => {
  state.dialog = {};
  state.slots = [];
  state.selectedSlotId = null;
  state.lastAssistantReply = "";
  elements.messages.innerHTML = "";
  elements.bookingBox.textContent = "";
  elements.bookingBox.className = "booking-box";
  elements.audioPlayer.hidden = true;
  elements.audioPlayer.removeAttribute("src");
  renderSlots([]);
  appendMessage("assistant", "Здравствуйте! Это Studio 108. Как к вам можно обращаться?");
});

let activeStreamAbort = null;
let activeMediaSource = null;

function stopActiveStream() {
  if (activeStreamAbort) {
    try { activeStreamAbort.abort(); } catch {}
    activeStreamAbort = null;
  }
  if (activeMediaSource && activeMediaSource.readyState === "open") {
    try { activeMediaSource.endOfStream(); } catch {}
  }
  activeMediaSource = null;
  try { elements.audioPlayer.pause(); } catch {}
  stopBackchannel();
}

// Разбивает reply на части для chunked TTS-streaming:
// - первая часть = первое предложение (до первого .!?), чтобы TTS стартовал быстрее
// - вторая часть = остальное (для бесшовного продолжения)
// Возвращает [firstChunk, restChunk?]. Если reply короткий — одну часть.
function splitReplyForChunkedTts(text) {
  if (!text) return [""];
  const trimmed = text.trim();
  // Берём как short если длина < 80 — не разбиваем.
  if (trimmed.length < 80) return [trimmed];
  // Ищем границу первого предложения: . или ! или ? (не внутри числа/сокращения),
  // потом пробел. До 80 символов.
  const match = trimmed.match(/^([\s\S]{20,120}?[.!?])\s+(\S[\s\S]+)$/);
  if (match) return [match[1].trim(), match[2].trim()];
  return [trimmed];
}

async function streamAssistantSpeech(text, voicePreset, pregeneratedUrl, action) {
  if (!text) return;

  // Если есть готовое mp3 для этой фразы — играем его мгновенно, без TTS-запроса.
  if (pregeneratedUrl) {
    try {
      stopActiveStream();
      const previous = elements.audioPlayer.src;
      elements.audioPlayer.src = pregeneratedUrl;
      elements.audioPlayer.hidden = false;
      await elements.audioPlayer.play().catch(() => {});
      if (previous && previous.startsWith("blob:")) URL.revokeObjectURL(previous);
      return;
    } catch (err) {
      console.warn("pregenerated playback failed, falling back to streaming", err);
    }
  }

  if (getLeadData().ttsProvider !== "elevenlabs") {
    return speakViaSimpleEndpoint(text);
  }

  stopActiveStream();
  const supportsMse = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported && MediaSource.isTypeSupported("audio/mpeg");
  if (!supportsMse) {
    return speakViaSimpleEndpoint(text);
  }

  const controller = new AbortController();
  activeStreamAbort = controller;

  // Streaming в две части: первое предложение → TTS немедленно, остальное — следом.
  // Это сокращает воспринимаемую latency на 30-50% на длинных репликах.
  const [firstChunk, restChunk] = splitReplyForChunkedTts(text);

  const mediaSource = new MediaSource();
  activeMediaSource = mediaSource;
  const previous = elements.audioPlayer.src;
  elements.audioPlayer.src = URL.createObjectURL(mediaSource);
  elements.audioPlayer.hidden = false;
  if (previous && previous.startsWith("blob:")) URL.revokeObjectURL(previous);

  await new Promise((resolve) => mediaSource.addEventListener("sourceopen", resolve, { once: true }));
  const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
  const queue = [];
  let ended = false;
  let pumping = false;

  function pump() {
    if (pumping) return;
    if (sourceBuffer.updating) return;
    if (queue.length === 0) {
      if (ended && mediaSource.readyState === "open") {
        try { mediaSource.endOfStream(); } catch {}
      }
      return;
    }
    pumping = true;
    const chunk = queue.shift();
    try { sourceBuffer.appendBuffer(chunk); } catch (err) {
      console.error("appendBuffer failed", err);
      pumping = false;
    }
  }

  sourceBuffer.addEventListener("updateend", () => { pumping = false; pump(); });

  let started = false;

  // Стримим chunk: запускаем fetch, читаем поток, кладём в queue.
  async function streamOne(textPart) {
    const resp = await fetch("/api/tts/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: textPart,
        outputFormat: "mp3_44100_128",
        voicePreset: voicePreset || "default",
        action: action || undefined
      }),
      signal: controller.signal
    });
    if (!resp.ok || !resp.body) {
      throw new Error(await resp.text());
    }
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      queue.push(value);
      pump();
      if (!started) {
        started = true;
        elements.audioPlayer.play().catch(() => {});
      }
    }
  }

  (async () => {
    try {
      await streamOne(firstChunk);
      // Запускаем второй chunk сразу — он подтянется к концу первого без gap.
      if (restChunk) {
        await streamOne(restChunk);
      }
      ended = true;
      pump();
    } catch (err) {
      if (err?.name !== "AbortError") console.error("stream read failed", err);
      ended = true;
      pump();
    }
  })();
}

async function speakViaSimpleEndpoint(text) {
  const response = await fetch("/api/tts/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: getLeadData().ttsProvider,
      text,
      outputFormat: getLeadData().ttsProvider === "yandex" ? "oggopus" : "mp3_44100_128"
    })
  });
  if (!response.ok) throw new Error(await response.text());
  const blob = await response.blob();
  const previous = elements.audioPlayer.src;
  elements.audioPlayer.src = URL.createObjectURL(blob);
  elements.audioPlayer.hidden = false;
  await elements.audioPlayer.play();
  if (previous && previous.startsWith("blob:")) URL.revokeObjectURL(previous);
}

elements.speakButton.addEventListener("click", async () => {
  const text = state.lastAssistantReply;
  if (!text) return;

  elements.speakButton.disabled = true;
  elements.speakButton.textContent = "Озвучивание";

  try {
    await streamAssistantSpeech(text);
  } catch (error) {
    appendMessage("assistant", "Не получилось озвучить ответ через выбранный голосовой сервис. Проверьте настройки провайдера.");
    console.error(error);
  } finally {
    elements.speakButton.disabled = false;
    elements.speakButton.textContent = "Озвучить";
  }
});

renderSlots([]);
appendMessage("assistant", "Здравствуйте! Это Studio 108. Как к вам можно обращаться?");
checkHealth();

function weekdayFull(value) {
  const map = {
    "Пн": "в понедельник",
    "Вт": "во вторник",
    "Ср": "в среду",
    "Чт": "в четверг",
    "Пт": "в пятницу",
    "Сб": "в субботу",
    "Вс": "в воскресенье"
  };
  return map[value] || value;
}

const voice = {
  active: false,
  mediaStream: null,
  recorder: null,
  recorderMime: "",
  chunks: [],
  audioCtx: null,
  analyser: null,
  vadHandle: 0,
  isSpeaking: false,
  speechStartedAt: 0,
  silenceStartedAt: 0,
  ttsPlaying: false,
  ttsStartedAt: 0,
  bargein: false,
  bargeinFrames: 0,
  pendingTurn: false,
  placeholderNode: null,
  recordingStartedAt: 0,
  continuousSpeechStartedAt: 0,
  lastNudgeAt: 0,
  nudgeCountInSession: 0,
  lastUserSpokeAt: 0,
  // Сколько раундов диалога УЖЕ прошло (клиент сказал → бот ответил).
  // Active listening не запускается на самой первой реплике, пока бот ещё ничего не услышал.
  completedTurns: 0,
  // AbortController текущей in-flight цепочки STT→brain→TTS. Если клиент после паузы
  // продолжает мысль, мы отменяем этот запрос и склеиваем «хвост» с продолжением.
  pendingTurnAbort: null,
  // Накопленный «префикс» от предыдущего отменённого turn'а. На следующем STT-результате
  // приклеивается в начало, чтобы brain получил полную мысль клиента, а не половину.
  pendingTextPrefix: "",
  // Watchdog таймер — следит, не возобновил ли клиент речь во время pendingTurn.
  resumeWatchdog: 0,
  // Timestamp, когда STT вернул transcript. После этого момента abort не имеет смысла —
  // дешевле получить ответ brain'а и продолжить, иначе каскад прерываний создаёт хаос.
  sttDoneAt: 0
};

const VAD = {
  speechRms: 0.035,             // порог запуска записи в режиме «слушаю» — выше тихого фона
  // 1800мс — даём клиенту достаточно времени думать.
  // Раньше 1400 — клиенты успевали договорить «А-а-а... ну...» и продолжить мысль,
  // но VAD уже отправлял партиальное на STT и нейронка генерила ответ на половину контекста.
  silenceMs: 1800,
  minSpeechMs: 350,
  // Barge-in: строгие пороги — реагируем только на громкую речь, направленную в микрофон.
  // Требуем (а) высокую амплитуду, (б) непрерывность ~600 мс, (в) защитная тишина 1.5 сек от старта TTS.
  bargeinRms: 0.14,             // высокий: только громкая речь близко к микрофону
  bargeinFrames: 36,            // ~600 мс непрерывной речи (был 400 мс)
  bargeinGraceMs: 1500,         // первые 1.5 сек TTS не прерывать
  bargeinSustainedRms: 0.085,   // средний RMS — выше, чтобы фон/далёкие голоса не считались
  silenceNudgeMs: 15000,
  silenceHangupMs: 35000,
  minNudgeIntervalMs: 22000,
  maxNudgesPerSession: 2,
  maxRecordingMs: 12000,
  ambientThresholdMs: 9000,
  ambientMaxChars: 220
};

function setLiveState(stateName, text) {
  if (!elements.liveStatus) return;
  elements.liveStatus.classList.remove("listening", "speaking", "thinking");
  if (stateName) elements.liveStatus.classList.add(stateName);
  if (text) elements.liveText.textContent = text;
}

function updateLevelMeter(rms) {
  if (!elements.levelFill) return;
  const value = Math.min(1, rms / 0.15);
  elements.levelFill.style.width = `${value * 100}%`;
}

function pickRecorderMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4"
  ];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const backchannelCache = new Map();
let activeBackchannelAudio = null;

function stopBackchannel() {
  if (activeBackchannelAudio) {
    try { activeBackchannelAudio.pause(); activeBackchannelAudio.currentTime = 0; } catch {}
    activeBackchannelAudio = null;
  }
  stopActiveListening();
}

// ──────────────────────────────────────────────────────────────────────────────
// Active listening — нейтральные "угу" пока клиент говорит.
// Используются ТОЛЬКО сэмплы, которые не претендуют на понимание (просто «я с тобой»),
// чтобы не звучать фальшиво до того, как STT даст транскрипцию.
// Включено по умолчанию; отключить можно ?activeListening=0.
// Запускается только начиная со 2-го раунда диалога (см. completedTurns в startActiveListeningLoop).
// ──────────────────────────────────────────────────────────────────────────────
const ACTIVE_LISTENING_ENABLED = (() => {
  try {
    return new URLSearchParams(location.search).get("activeListening") !== "0";
  } catch {
    return true;
  }
})();
// 3 нейтральных варианта «угу» с разной интонацией — короткий / мягкий / задумчивый.
const ACTIVE_BCS = ["ugu_short", "ugu_soft", "ugu_low"];
let lastActiveBc = "";
let activeListeningTimer = 0;
let activeListeningAudio = null;

function stopActiveListening() {
  if (activeListeningTimer) {
    clearTimeout(activeListeningTimer);
    activeListeningTimer = 0;
  }
  if (activeListeningAudio) {
    try { activeListeningAudio.pause(); activeListeningAudio.currentTime = 0; } catch {}
    activeListeningAudio = null;
  }
  // НЕ сбрасываем activeListeningFiredThisUtterance здесь — клиент может сделать короткую
  // паузу и продолжить говорить (та же реплика). Раньше флаг сбрасывался на каждой паузе,
  // и при долгой речи играло «угу-короткое...пауза...угу-низкое» — 2 сэмпла за один turn.
  // Сброс делает resetForNewTurn после ответа бота.
}

function startActiveListeningLoop() {
  if (!ACTIVE_LISTENING_ENABLED) return;
  if (activeListeningTimer) return;
  // На самой первой реплике клиента (бот ещё ничего не услышал) активное
  // слушание не запускаем — иначе «ясно, поняла» играет ДО приветствия и звучит абсурдно.
  if ((voice.completedTurns ?? 0) < 1) return;
  // Если уже сработали на этом turn'е — больше не пытаемся (даже если речь продолжается).
  if (activeListeningFiredThisUtterance) return;
  scheduleActiveListeningTick();
}

// Сбрасываем «один-раз-за-turn» флаг ТОЛЬКО когда начинается новый turn клиента
// (после того как бот ответил). Это убирает каскад angle 2-3 «угу» за одну реплику.
function resetActiveListeningForNewTurn() {
  activeListeningFiredThisUtterance = false;
  lastActiveBc = "";
}

let activeListeningFiredThisUtterance = false;

function scheduleActiveListeningTick() {
  // Срабатываем ОДИН раз через 3.5–5 сек после начала непрерывной речи.
  // Раньше 5-7сек — короткие реплики (10-15 сек) никогда не получали угу.
  // Теперь триггер раньше: на реплике 4-5 сек уже сработает.
  const delay = 3500 + Math.random() * 1500;
  activeListeningTimer = setTimeout(() => {
    activeListeningTimer = 0;
    if (!voice.isSpeaking) return;
    if (voice.ttsPlaying) return;
    if (activeListeningFiredThisUtterance) return;
    // Не вставляем, если клиент только что начал говорить (меньше 3 сек).
    if (voice.speechStartedAt && performance.now() - voice.speechStartedAt < 3000) {
      // Перепланируем — следующий тик попробует позже.
      scheduleActiveListeningTick();
      return;
    }
    // Не повторяем тот же ключ два раза подряд (между разными утtterance'ами).
    let key = ACTIVE_BCS[Math.floor(Math.random() * ACTIVE_BCS.length)];
    if (ACTIVE_BCS.length > 1 && key === lastActiveBc) {
      const alts = ACTIVE_BCS.filter((k) => k !== lastActiveBc);
      key = alts[Math.floor(Math.random() * alts.length)];
    }
    lastActiveBc = key;
    try {
      let audio = backchannelCache.get(`al-${key}`);
      if (!audio) {
        audio = new Audio(`/audio/backchannels/${key}.mp3`);
        audio.preload = "auto";
        backchannelCache.set(`al-${key}`, audio);
      }
      audio.volume = 0.32;
      audio.currentTime = 0;
      activeListeningAudio = audio;
      audio.play().catch(() => {});
      activeListeningFiredThisUtterance = true; // помечаем, чтобы в этой непрерывной речи больше не тикало
    } catch {}
    // НЕ перепланируем — один «угу» на одну речь. Следующий запуск только когда воз-обновится isSpeaking.
  }, delay);
}

// ──────────────────────────────────────────────────────────────────────────────
// Resume-watchdog: пока активен pendingTurn (STT работает / brain думает),
// следим за микрофоном. Если клиент СНОВА разговорился РАНО (STT ещё не вернул)
// — это сильный сигнал, что он не закончил мысль. Отменяем in-flight, копим префикс,
// и шлём всё одним сообщением.
// КОНСЕРВАТИВНО:
//   - триггер только пока STT не вернулся (sttDoneAt = 0)
//   - 30 кадров (~500мс) непрерывной речи (не короткие щелчки/шум)
//   - максимум 1 abort за turn — иначе каскад «А-A-B-B» и брейн получает кашу
// ──────────────────────────────────────────────────────────────────────────────
let resumeWatchdogActive = false;
let resumeAboveCount = 0;

function startResumeWatchdog() {
  if (resumeWatchdogActive) return;
  if (!voice.analyser) return;
  // Если уже мерджили один раз — больше не прерываем, ждём ответ.
  if ((voice.pendingTextPrefix || "").length > 0) return;
  resumeWatchdogActive = true;
  resumeAboveCount = 0;
  const buffer = new Float32Array(voice.analyser.fftSize);
  const startedAt = performance.now();
  function check() {
    if (!resumeWatchdogActive) return;
    if (!voice.pendingTurn) {
      resumeWatchdogActive = false;
      return;
    }
    // Не прерываем, если STT уже вернулся и brain обрабатывает — поздно мерджить,
    // дешевле получить ответ и продолжить нормальный turn.
    if (voice.sttDoneAt > 0) {
      resumeWatchdogActive = false;
      return;
    }
    // Жёсткий тайм-аут: если за 4 сек не сработали — отключаемся (бессмысленно).
    if (performance.now() - startedAt > 4000) {
      resumeWatchdogActive = false;
      return;
    }
    try {
      voice.analyser.getFloatTimeDomainData(buffer);
    } catch {
      resumeWatchdogActive = false;
      return;
    }
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    if (rms > VAD.speechRms) {
      resumeAboveCount++;
      // ~30 кадров подряд ≈ 500 мс осмысленной речи (не одиночный щелчок/шум)
      if (resumeAboveCount >= 30) {
        resumeWatchdogActive = false;
        onClientResumedSpeech();
        return;
      }
    } else {
      resumeAboveCount = Math.max(0, resumeAboveCount - 2);
    }
    requestAnimationFrame(check);
  }
  requestAnimationFrame(check);
}

function stopResumeWatchdog() {
  resumeWatchdogActive = false;
}

function onClientResumedSpeech() {
  if (!voice.pendingTurn) return;
  // Сохраняем то, что клиент успел сказать до паузы — приклеим в начало новой реплики.
  // На момент срабатывания placeholderNode может уже содержать частичный текст из STT.
  const partial = voice.placeholderNode && voice.placeholderNode.textContent !== "..."
    ? voice.placeholderNode.textContent.trim()
    : "";
  if (partial) {
    voice.pendingTextPrefix = voice.pendingTextPrefix
      ? `${voice.pendingTextPrefix} ${partial}`.trim()
      : partial;
  }
  if (voice.placeholderNode) {
    voice.placeholderNode.remove();
    voice.placeholderNode = null;
  }
  // Отменяем in-flight STT/brain.
  if (voice.pendingTurnAbort) {
    try { voice.pendingTurnAbort.abort(); } catch {}
    voice.pendingTurnAbort = null;
  }
  voice.pendingTurn = false;
  // Лёгкое акустическое подтверждение, что мы услышали продолжение речи.
  // Тихий «угу» вместо тишины — клиент не думает, что бот завис.
  try {
    let audio = backchannelCache.get("al-ugu_short");
    if (!audio) {
      audio = new Audio("/audio/backchannels/ugu_short.mp3");
      audio.preload = "auto";
      backchannelCache.set("al-ugu_short", audio);
    }
    audio.volume = 0.4;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch {}
  if (voice.active) {
    setLiveState("listening", "Слушаю");
    startListenTurn();
  }
}

async function playBackchannel(key) {
  try {
    let audio = backchannelCache.get(key);
    if (!audio) {
      audio = new Audio(`/audio/backchannels/${key}.mp3`);
      audio.preload = "auto";
      backchannelCache.set(key, audio);
    }
    audio.currentTime = 0;
    activeBackchannelAudio = audio;
    await audio.play().catch(() => {});
    await new Promise((resolve) => {
      const onEnd = () => { audio.removeEventListener("ended", onEnd); audio.removeEventListener("pause", onEnd); resolve(); };
      audio.addEventListener("ended", onEnd, { once: true });
      audio.addEventListener("pause", onEnd, { once: true });
      setTimeout(resolve, 1500);
    });
    if (activeBackchannelAudio === audio) activeBackchannelAudio = null;
  } catch (err) {
    console.warn("backchannel playback failed", err);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function startVoiceLoop() {
  if (voice.active) return;
  try {
    voice.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
  } catch (error) {
    appendMessage("assistant", "Не удалось получить доступ к микрофону. Разрешите доступ и попробуйте снова.");
    console.error(error);
    return;
  }

  voice.active = true;
  voice.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = voice.audioCtx.createMediaStreamSource(voice.mediaStream);
  voice.analyser = voice.audioCtx.createAnalyser();
  voice.analyser.fftSize = 1024;
  voice.analyser.smoothingTimeConstant = 0.5;
  source.connect(voice.analyser);
  voice.recorderMime = pickRecorderMime();

  elements.liveButton.classList.add("active");
  elements.liveButton.textContent = "⏹ Завершить";
  elements.liveStatus.hidden = false;
  setLiveState("listening", "Слушаю");

  // Точное время начала TTS — момент когда audio реально заиграл.
  // bargeinGraceMs отсчитывается от этого момента, не от вызова setLiveState("speaking").
  if (!elements.audioPlayer.dataset.bargeinPlayHook) {
    elements.audioPlayer.addEventListener("playing", () => {
      if (voice.ttsPlaying) voice.ttsStartedAt = performance.now();
    });
    elements.audioPlayer.dataset.bargeinPlayHook = "1";
  }

  startListenTurn();
  startBargeinMonitor();
}

function stopVoiceLoop() {
  voice.active = false;
  if (voice.recorder && voice.recorder.state === "recording") {
    try { voice.recorder.stop(); } catch {}
  }
  if (voice.vadHandle) {
    cancelAnimationFrame(voice.vadHandle);
    voice.vadHandle = 0;
  }
  if (voice.mediaStream) {
    voice.mediaStream.getTracks().forEach((track) => track.stop());
    voice.mediaStream = null;
  }
  if (voice.audioCtx) {
    try { voice.audioCtx.close(); } catch {}
    voice.audioCtx = null;
  }
  voice.analyser = null;
  voice.recorder = null;
  voice.chunks = [];
  voice.isSpeaking = false;
  voice.ttsPlaying = false;
  voice.bargein = false;
  voice.bargeinFrames = 0;
  voice.pendingTurn = false;

  elements.liveButton.classList.remove("active");
  elements.liveButton.textContent = "🎙 Начать разговор";
  elements.liveStatus.hidden = true;
  setLiveState("", "Готов слушать");
  updateLevelMeter(0);

  stopActiveStream();
}

function startListenTurn() {
  if (!voice.active) return;
  voice.chunks = [];
  voice.isSpeaking = false;
  voice.speechStartedAt = 0;
  voice.silenceStartedAt = 0;
  voice.recordingStartedAt = performance.now();
  voice.continuousSpeechStartedAt = 0;

  const options = voice.recorderMime ? { mimeType: voice.recorderMime } : {};
  try {
    voice.recorder = new MediaRecorder(voice.mediaStream, options);
  } catch (error) {
    console.error("MediaRecorder failed", error);
    appendMessage("assistant", "Браузер не смог запустить запись. Попробуйте Chrome или Edge.");
    stopVoiceLoop();
    return;
  }
  voice.recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) voice.chunks.push(event.data);
  };
  voice.recorder.onstop = handleSpeechCaptured;
  voice.recorder.start(120);
  setLiveState("listening", "Слушаю");
  monitorRecordingVad();
}

function monitorRecordingVad() {
  if (!voice.active || !voice.analyser) return;
  const buffer = new Float32Array(voice.analyser.fftSize);
  const listenStartedAt = performance.now();

  function tick() {
    if (!voice.active || !voice.recorder || voice.recorder.state !== "recording") return;
    voice.analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    updateLevelMeter(rms);
    const now = performance.now();

    // Принудительный стоп записи если она тянется слишком долго (защита от фоновых звуков ТВ/радио).
    // На шаге ask_phone клиент может медленно диктовать с долгими паузами — даём больше.
    const stageForCap = state.dialog?.stage;
    const maxRec = stageForCap === "ask_phone" ? 25000 : VAD.maxRecordingMs;
    if (voice.recordingStartedAt && now - voice.recordingStartedAt > maxRec) {
      try { voice.recorder.stop(); } catch {}
      return;
    }

    if (rms > VAD.speechRms) {
      if (!voice.isSpeaking) {
        voice.isSpeaking = true;
        voice.speechStartedAt = now;
        voice.continuousSpeechStartedAt = voice.continuousSpeechStartedAt || now;
        voice.lastUserSpokeAt = now;
        voice.nudgeCountInSession = 0;
        startActiveListeningLoop();
      }
      voice.silenceStartedAt = 0;
    } else if (voice.isSpeaking) {
      if (voice.silenceStartedAt === 0) {
        voice.silenceStartedAt = now;
      } else {
        // На шаге ask_phone клиент диктует цифры с паузами (8... 922... 653...) —
        // обычный 1800мс silence отрезает на полу-фразе. Расширяем до 5000мс.
        // 3500мс было мало — клиент задумывается между группами цифр на ~4 сек.
        const stage = state.dialog?.stage;
        const effectiveSilenceMs = stage === "ask_phone" ? 5000 : VAD.silenceMs;
        if (now - voice.silenceStartedAt > effectiveSilenceMs && now - voice.speechStartedAt > VAD.minSpeechMs) {
          voice.continuousSpeechStartedAt = 0;
          stopActiveListening();
          try { voice.recorder.stop(); } catch {}
          return;
        }
      }
    } else {
      const idle = now - listenStartedAt;
      const sinceLastNudge = voice.lastNudgeAt > 0 ? now - voice.lastNudgeAt : Infinity;
      const reachedHangup = idle > VAD.silenceHangupMs || voice.nudgeCountInSession >= VAD.maxNudgesPerSession && sinceLastNudge > VAD.silenceNudgeMs;
      if (reachedHangup) {
        try { voice.recorder.stop(); } catch {}
        appendMessage("assistant", "Похоже, связь прервалась. Я перезвоню позже.");
        stopVoiceLoop();
        return;
      }
      if (idle > VAD.silenceNudgeMs && sinceLastNudge > VAD.minNudgeIntervalMs && voice.nudgeCountInSession < VAD.maxNudgesPerSession) {
        voice.lastNudgeAt = now;
        voice.nudgeCountInSession += 1;
        const phrases = ["Алло, вы здесь?", "Слышите меня?", "Связь не пропала?"];
        speakNudge(phrases[Math.min(voice.nudgeCountInSession - 1, phrases.length - 1)]);
      }
    }
    voice.vadHandle = requestAnimationFrame(tick);
  }
  voice.vadHandle = requestAnimationFrame(tick);
}

async function speakNudge(text) {
  try {
    appendMessage("assistant", text);
    await streamAssistantSpeech(text);
  } catch (err) {
    console.warn("nudge failed", err);
  }
}

function startBargeinMonitor() {
  if (!voice.active || !voice.analyser) return;
  const buffer = new Float32Array(voice.analyser.fftSize);
  const rmsHistory = [];           // последние ~30 фреймов RMS, для усреднения
  const HISTORY_LEN = 30;

  function tick() {
    if (!voice.active) return;
    if (voice.ttsPlaying) {
      const sinceStart = voice.ttsStartedAt ? performance.now() - voice.ttsStartedAt : 0;
      if (sinceStart < VAD.bargeinGraceMs) {
        voice.bargeinFrames = 0;
        rmsHistory.length = 0;
        requestAnimationFrame(tick);
        return;
      }
      voice.analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);

      rmsHistory.push(rms);
      if (rmsHistory.length > HISTORY_LEN) rmsHistory.shift();
      const avgRms = rmsHistory.reduce((s, v) => s + v, 0) / rmsHistory.length;

      // Условие срабатывания: и пиковый RMS высокий, и среднее по окну тоже высокое.
      // Это отличает речь (стабильно громкая) от хлопка/кашля/звука посуды (короткий пик).
      if (rms > VAD.bargeinRms && avgRms > VAD.bargeinSustainedRms) {
        voice.bargeinFrames += 1;
        if (voice.bargeinFrames >= VAD.bargeinFrames) {
          voice.bargein = true;
          voice.bargeinFrames = 0;
          const replyText = state.lastAssistantReply || "";
          const elapsedMs = voice.ttsStartedAt ? performance.now() - voice.ttsStartedAt : 0;
          const estimatedCharsSpoken = Math.min(replyText.length, Math.floor(elapsedMs / 1000 * 13));
          state.lastInterruption = {
            previousReply: replyText,
            spokenSoFar: replyText.slice(0, estimatedCharsSpoken),
            unsaidPart: replyText.slice(estimatedCharsSpoken),
            elapsedMs: Math.round(elapsedMs)
          };
          stopActiveStream();
          voice.ttsPlaying = false;
          if (voice.active && (!voice.recorder || voice.recorder.state !== "recording") && !voice.pendingTurn) {
            startListenTurn();
          }
        }
      } else {
        voice.bargeinFrames = Math.max(0, voice.bargeinFrames - 2);
      }
    } else {
      voice.bargeinFrames = 0;
      rmsHistory.length = 0;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function handleSpeechCaptured() {
  if (!voice.active) return;
  const blob = new Blob(voice.chunks, { type: voice.recorderMime || "audio/webm" });
  if (blob.size < 1500) {
    if (voice.active) startListenTurn();
    return;
  }

  const recordingDurationMs = voice.recordingStartedAt ? performance.now() - voice.recordingStartedAt : 0;
  const looksLikeAmbient = voice.continuousSpeechStartedAt > 0 &&
    (performance.now() - voice.continuousSpeechStartedAt) > VAD.ambientThresholdMs;

  setLiveState("thinking", "Распознаю");
  voice.pendingTurn = true;
  voice.pendingTurnAbort = new AbortController();
  voice.sttDoneAt = 0;
  voice.placeholderNode = appendMessage("user", "...");

  // Запускаем «сторожа»: если клиент во время этого pendingTurn продолжает говорить
  // (т.е. сделал короткую паузу и докручивает мысль) — отменяем in-flight запрос
  // и сольём оба куска речи в один полный turn. Только пока STT не вернулся.
  startResumeWatchdog();

  let transcript = "";
  try {
    const audioBase64 = await blobToBase64(blob);
    const sttResp = await fetch("/api/stt/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: getLeadData().sttProvider,
        audioBase64,
        mimeType: blob.type || "audio/webm",
        fileName: blob.type && blob.type.includes("ogg") ? "speech.ogg" : "speech.webm",
        languageCode: "ru"
      }),
      signal: voice.pendingTurnAbort.signal
    });
    if (!sttResp.ok) throw new Error(await sttResp.text());
    const stt = await sttResp.json();
    transcript = (stt.text || "").trim();
    voice.sttDoneAt = performance.now();
  } catch (error) {
    if (error?.name === "AbortError") {
      // Клиент возобновил речь — этот turn отменён, выходим тихо.
      return;
    }
    console.error("STT failed", error);
  }

  const meaningful = transcript.replace(/[^\p{L}\p{N}]+/gu, "");
  if (!transcript || meaningful.length < 2) {
    if (voice.placeholderNode) voice.placeholderNode.remove();
    voice.placeholderNode = null;
    voice.pendingTurn = false;
    voice.pendingTextPrefix = ""; // не тащим висящий префикс в новый turn
    if (voice.active) {
      setLiveState("listening", "Не услышал, говорите снова");
      startListenTurn();
    }
    return;
  }

  // Защита от фонового шума (ТВ, радио): длинная непрерывная речь + длинный текст = почти точно фон.
  if (looksLikeAmbient && transcript.length > VAD.ambientMaxChars) {
    if (voice.placeholderNode) voice.placeholderNode.remove();
    voice.placeholderNode = null;
    voice.pendingTurn = false;
    voice.pendingTextPrefix = "";
    console.warn("ambient noise filtered", { recordingDurationMs, transcriptLength: transcript.length });
    if (voice.active) {
      setLiveState("listening", "Слушаю");
      startListenTurn();
    }
    return;
  }

  // Защита от случайных перебиваний — реплика клиента «не для бота».
  // Признаки: STT поймал реплику адресованную третьему лицу (домашняя речь, ТВ, обращение к ребёнку),
  // и в ней нет ни одного слова из нашей доменной области.
  const hasDomainWord = /(?:танц|хип-?хоп|пробн|занят|записать|развилк|озер|школ|анна|студи|телефон|номер|брейк|контемп|йог|зумб|сальс|бачат|леди|джаз|кпоп|k-?pop)/i.test(transcript.toLowerCase());
  const isLikelyToSomeoneElse = !hasDomainWord && transcript.length > 25 && (
    // Прямое обращение «остановись, не мешай».
    /(?:не\s+надо\s+(?:сюда|туда|идти|сейчас)|подожди|тише\s+там|выйди|отойди|не\s+мешай|выходи)/i.test(transcript) ||
    // Бытовая речь к ребёнку/домашним: про еду, питьё, одевание.
    /(?:давай\s+(?:тебе|я\s+тебе|покушай|поешь|подогрею|выпей|съешь|садись|сядь)|подогрею|подогрей|съешь|поешь|кушай|покушай|выпей|налей|положи|посиди\s+тут|сядь\s+(?:ровно|тут|здесь|сюда))/i.test(transcript) ||
    // «Что ты / куда ты / чего ты» + НЕ вопрос к боту (не содержит «сказал/говор/имеешь/предлаг»).
    (/(?:что|чего|куда)\s+ты\b/i.test(transcript) && !/(?:сказа|говор|имеешь|предлаг|спрашива|подсказ|перезвон)/i.test(transcript)) ||
    // Жалобы про температуру/состояние еды и т.п.
    /(?:холодн(?:ый|ое|ая)|горяч(?:ий|ее|ая)|замороженн|разогре(?:т|й)|размор)/i.test(transcript)
  );
  if (isLikelyToSomeoneElse) {
    if (voice.placeholderNode) voice.placeholderNode.remove();
    voice.placeholderNode = null;
    voice.pendingTurn = false;
    voice.pendingTextPrefix = "";
    console.warn("background speech filtered (not addressed to bot)", { transcript: transcript.slice(0, 100) });
    if (voice.active) {
      setLiveState("listening", "Слушаю");
      startListenTurn();
    }
    return;
  }

  // Гибридный случай: клиент задал вопрос боту, потом краем обратился к домашним —
  // STT отдал одной строкой «Что такое брейк-данс? Чай, кофе хочешь? Нет, спасибо».
  // Обрезаем «домашний хвост»: ищем фразовый признак обращения к третьему лицу и режем reply
  // до конца предыдущего предложения.
  const homeTailPattern = /(?:[.!?]\s+|^)\s*(?:[А-ЯЁA-Z][а-яёa-z]*[,!?\s]+)?(?:чай|кофе|подогре|съешь|поешь|кушай|покушай|выпей|тебе\s+налить|тебе\s+подогре|положи|садись\s+есть|сядь\s+есть|нет,?\s+спасибо|да,?\s+спасибо|я\s+тебе)/i;
  const trimMatch = transcript.match(homeTailPattern);
  if (trimMatch && trimMatch.index !== undefined && trimMatch.index > 8) {
    const trimmedTranscript = transcript.slice(0, trimMatch.index).replace(/[\s,]+$/, "").trim();
    if (trimmedTranscript.length >= 5) {
      console.warn("trimmed home-talk tail", { dropped: transcript.slice(trimMatch.index).slice(0, 80) });
      transcript = trimmedTranscript;
    }
  }

  // Если на прошлом turn'е клиент возобновил речь во время pendingTurn, у нас сохранён
  // префикс (то, что он сказал ДО паузы). Склеиваем с текущим transcript — brain получает
  // полную мысль клиента, без разрыва на половине.
  let combinedTranscript = transcript;
  if (voice.pendingTextPrefix && voice.pendingTextPrefix.trim()) {
    combinedTranscript = `${voice.pendingTextPrefix.trim()} ${transcript}`.trim();
    voice.pendingTextPrefix = "";
  }

  if (voice.placeholderNode) {
    voice.placeholderNode.textContent = combinedTranscript;
    state.lastUserText = combinedTranscript;
    voice.placeholderNode = null;
  }

  setLiveState("thinking", "Думаю");

  // Late-thinking filler: если brain не ответил за 5 сек — играем тихое «секундочку»,
  // чтобы клиент не слушал 5+ секунд тишины. Серверный backchannel приходит после brain'а
  // и не успевает спасти ситуацию на медленных ходах (когда модель композит нетиповой ответ).
  // Раньше 3 сек — но с v2 + auto-continue brain отвечает 4-6 сек обычно, и sek.mp3 звучал
  // на каждом ходе, что раздражало.
  //
  // НЕ играем «секундочку» до того как бот вообще что-то сказал (completedTurns=0): клиент
  // только включил микрофон, услышать «секундочку» до приветствия — странно.
  let lateThinkingFired = false;
  const lateThinkingTimer = setTimeout(() => {
    if (!voice.pendingTurn || voice.ttsPlaying) return;
    if ((voice.completedTurns ?? 0) < 1) return;
    try {
      let audio = backchannelCache.get("late-sek");
      if (!audio) {
        audio = new Audio("/audio/backchannels/sek.mp3");
        audio.preload = "auto";
        backchannelCache.set("late-sek", audio);
      }
      audio.volume = 0.55;
      audio.currentTime = 0;
      audio.play().catch(() => {});
      lateThinkingFired = true;
    } catch {}
  }, 5000);

  let result;
  try {
    // Streaming-режим: runStreamingTurn сам пушит TTS по предложению, backchannel
    // и thinkingDelayMs пропускаются (первый аудио-байт обычно через ~700-1000мс,
    // искусственная задумчивость не нужна).
    if (STREAMING_TURN_ENABLED) {
      result = await runStreamingTurn(combinedTranscript, voice.pendingTurnAbort?.signal);
    } else {
      result = await requestAssistant(combinedTranscript, voice.pendingTurnAbort?.signal);
    }
  } catch (error) {
    clearTimeout(lateThinkingTimer);
    if (error?.name === "AbortError") {
      // Клиент возобновил речь — этот turn отменён, выходим тихо.
      return;
    }
    console.error(error);
    appendMessage("assistant", "Не получилось обработать заявку.");
    voice.pendingTurn = false;
    if (voice.active) startListenTurn();
    return;
  }
  clearTimeout(lateThinkingTimer);

  state.dialog = result.state || {};
  voice.completedTurns = (voice.completedTurns || 0) + 1;
  // Новый turn клиента — разрешаем активному слушанию сработать снова в этом turn'е.
  resetActiveListeningForNewTurn();
  appendMessage("assistant", result.reply);
  renderSlots(result.slots);
  if (result.booking) {
    elements.bookingBox.className = "booking-box success";
    elements.bookingBox.textContent = `Запись создана: ${result.booking.customerName}, ${result.booking.phone}.`;
  }

  setLiveState("speaking", "Отвечаю");
  voice.ttsPlaying = true;
  voice.ttsStartedAt = 0;  // ставим только когда audio реально заиграет (см. listener ниже)
  voice.bargein = false;
  voice.bargeinFrames = 0;
  voice.pendingTurn = false;
  try {
    if (STREAMING_TURN_ENABLED) {
      // TTS уже пошёл в runStreamingTurn по мере прихода предложений. Только дожидаемся
      // конца воспроизведения; backchannel/thinkingDelay в streaming-режиме не применяем.
      if (!voice.bargein) await waitForAudioEnd();
    } else {
      // Если уже сыграл late-thinking filler (sek.mp3) — серверный pre-reply backchannel
      // («понимаю», «поняла») станет вторым сэмплом подряд и режет слух. Пропускаем.
      // Также пропускаем на самом первом ответе бота (completedTurns стало 1 чуть выше) —
      // «понимаю» перед приветствием звучит абсурдно: бот ещё ничего не услышал, кроме «здравствуйте».
      if (result.backchannel && !voice.bargein && !lateThinkingFired && voice.completedTurns > 1) {
        await playBackchannel(result.backchannel);
      }
      if (result.thinkingDelayMs && result.thinkingDelayMs > 0 && !voice.bargein) {
        await sleep(result.thinkingDelayMs);
      }
      if (!voice.bargein) {
        await streamAssistantSpeech(result.reply, result.voicePreset, result.pregeneratedAudioUrl);
        await waitForAudioEnd();
      }
    }
  } catch (error) {
    console.error("TTS failed", error);
  }
  const wasInterrupted = voice.bargein;
  voice.ttsPlaying = false;
  voice.ttsStartedAt = 0;

  // Если barge-in уже стартовал новую запись — не дублируем listen.
  if (voice.active && !wasInterrupted) {
    if (result.action === "booked" || result.action === "handoff") {
      setLiveState("listening", `Завершено (${result.action}). Можно продолжить разговор.`);
    }
    startListenTurn();
  }
  voice.bargein = false;
}

function waitForAudioEnd() {
  return new Promise((resolve) => {
    const audio = elements.audioPlayer;
    if (audio.paused || audio.ended) {
      resolve();
      return;
    }
    const onEnded = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("pause", onEnded);
      resolve();
    };
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", onEnded);
  });
}

elements.liveButton.addEventListener("click", () => {
  if (voice.active) {
    stopVoiceLoop();
  } else {
    startVoiceLoop();
  }
});
