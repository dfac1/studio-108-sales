import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { synthesizeSpeech, transcribeSpeech, getVoiceProvidersStatus } from "./voiceProviders.js";

const originalFetch = global.fetch;
const originalYandex = structuredClone(config.yandex);

describe("voice providers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.yandex.apiKey = originalYandex.apiKey;
    config.yandex.iamToken = originalYandex.iamToken;
    config.yandex.folderId = originalYandex.folderId;
    config.yandex.ttsVoice = originalYandex.ttsVoice;
    config.yandex.ttsEmotion = originalYandex.ttsEmotion;
    config.yandex.ttsSpeed = originalYandex.ttsSpeed;
    config.yandex.sttLanguageCode = originalYandex.sttLanguageCode;
    config.yandex.sttModel = originalYandex.sttModel;
    config.yandex.sttFormat = originalYandex.sttFormat;
    config.yandex.sttSampleRateHertz = originalYandex.sttSampleRateHertz;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    global.fetch = originalFetch;
  });

  it("builds ElevenLabs TTS request for Russian speech", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeSpeech({
      provider: "elevenlabs",
      text: "Studio 108, Hip-hop, 300 рублей",
      outputFormat: "mp3_44100_128"
    });

    expect(result.provider).toBe("elevenlabs");
    expect(result.normalizedText).toContain("Студия сто восемь");
    expect(result.normalizedText).toContain("триста рублей");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/text-to-speech/");
    expect(String(url)).toContain("output_format=mp3_44100_128");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model_id: config.elevenLabs.modelId,
      language_code: "ru",
      apply_text_normalization: "on",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.85,
        style: 0.35,
        use_speaker_boost: true,
        speed: 0.96
      }
    });
  });

  it("builds ElevenLabs STT multipart request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "привет", language_code: "ru" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeSpeech({
      provider: "elevenlabs",
      audio: Buffer.from([1, 2, 3]),
      mimeType: "audio/ogg",
      fileName: "sample.ogg",
      languageCode: "ru"
    });

    expect(result.provider).toBe("elevenlabs");
    expect(result.text).toBe("привет");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it("builds Yandex TTS request with service auth", async () => {
    config.yandex.apiKey = "yandex-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeSpeech({
      provider: "yandex",
      text: "Здравствуйте! Studio 108.",
      outputFormat: "oggopus"
    });

    expect(result.provider).toBe("yandex");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize");
    expect(init?.headers).toMatchObject({
      Authorization: "Api-Key yandex-key"
    });
    expect(String(init?.body)).toContain("voice=");
  });

  it("builds Yandex STT request with query params", async () => {
    config.yandex.apiKey = "yandex-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: "хочу на хип-хоп" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeSpeech({
      provider: "yandex",
      audio: Buffer.from([0, 1, 2]),
      mimeType: "audio/ogg",
      languageCode: "ru-RU"
    });

    expect(result.text).toBe("хочу на хип-хоп");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?");
    expect(String(url)).toContain("lang=ru-RU");
    expect(String(url)).toContain("format=oggopus");
    expect(init?.headers).toMatchObject({
      Authorization: "Api-Key yandex-key"
    });
  });

  it("returns provider matrix for A/B setup", () => {
    const matrix = getVoiceProvidersStatus();
    expect(matrix.providers).toHaveLength(4);
    expect(matrix.providers.map((provider) => provider.id)).toContain("elevenlabs");
    expect(matrix.providers.map((provider) => provider.id)).toContain("yandex");
  });
});
