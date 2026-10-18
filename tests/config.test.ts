import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const embeddingEnv = { OPENROUTER_API_KEY: "test-openrouter-key" };
const storageEnv = {
  S3_REGION: "us-east-1",
  S3_BUCKET: "media",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
};
const validEnv = { ...embeddingEnv, ...storageEnv };
const ollamaEnv = {
  ...storageEnv,
  EMBEDDING_BASE_URL: "http://ollama:11434",
  EMBEDDING_MODEL: "embeddinggemma-2",
  EMBEDDING_DIMENSIONS: "768",
};

describe("S3 configuration", () => {
  it("defaults to path-style requests and a one-hour signed URL", () => {
    const config = loadConfig(validEnv);

    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
    expect(config.S3_URL_TTL_SECONDS).toBe(3600);
    expect(config.S3_ENDPOINT).toBeUndefined();
    expect(config.S3_SESSION_TOKEN).toBeUndefined();
  });

  it("accepts a custom endpoint, temporary token, and virtual-host addressing", () => {
    const config = loadConfig({
      ...validEnv,
      S3_ENDPOINT: "https://objects.example.test",
      S3_SESSION_TOKEN: "test-session-token",
      S3_CREDENTIALS_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
      S3_FORCE_PATH_STYLE: "false",
      S3_URL_TTL_SECONDS: "120",
    });

    expect(config).toMatchObject({
      S3_ENDPOINT: "https://objects.example.test",
      S3_SESSION_TOKEN: "test-session-token",
      S3_CREDENTIALS_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
      S3_FORCE_PATH_STYLE: false,
      S3_URL_TTL_SECONDS: 120,
    });
  });

  it("allows HTTP only for loopback endpoints and requires HTTPS for public hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "127.255.255.254", "[::1]"]) {
      const config = loadConfig({ ...validEnv, S3_ENDPOINT: `http://${host}:9000` });
      expect(config.S3_ENDPOINT).toBe(`http://${host}:9000`);
    }

    expect(() =>
      loadConfig({ ...validEnv, S3_ENDPOINT: "http://objects.example.test:9000" }),
    ).toThrow(/S3_ENDPOINT must use HTTPS/);
    expect(
      loadConfig({ ...validEnv, S3_ENDPOINT: "https://objects.example.test" }).S3_ENDPOINT,
    ).toBe("https://objects.example.test");
    expect(() => loadConfig({ ...validEnv, S3_ENDPOINT: "https://user:password@objects.example.test" })).toThrow();
    expect(() => loadConfig({ ...validEnv, S3_ENDPOINT: "https://objects.example.test?token=secret" })).toThrow();
  });

  it("always requires complete storage configuration", () => {
    expect(() => loadConfig(embeddingEnv)).toThrow(/S3 is required for the media archive/);
    expect(() => loadConfig({ ...embeddingEnv, S3_BUCKET: "media" })).toThrow(/S3_REGION/);
    expect(() => loadConfig({ ...validEnv, S3_SECRET_ACCESS_KEY: "" })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => loadConfig({ ...validEnv, S3_SESSION_TOKEN: "temporary" })).toThrow(/S3_CREDENTIALS_EXPIRES_AT/);
  });

  it("rejects the retired MEDIA_TYPES instead of silently changing what is stored", () => {
    expect(() => loadConfig({ ...validEnv, MEDIA_TYPES: "photo,voice" })).toThrow(/MEDIA_TYPES is no longer used/);
    expect(loadConfig({ ...validEnv, MEDIA_TYPES: "" }).embedding.modalities).toEqual(["image", "audio", "video"]);
  });

  it("rejects malformed endpoints and invalid URL TTLs", () => {
    expect(() => loadConfig({ ...validEnv, S3_ENDPOINT: "ftp://objects.example.test" })).toThrow();
    expect(() => loadConfig({ ...validEnv, S3_URL_TTL_SECONDS: "0" })).toThrow();
  });

  it("accepts the SigV4 maximum URL TTL and rejects the next second", () => {
    expect(loadConfig({ ...validEnv, S3_URL_TTL_SECONDS: "604800" }).S3_URL_TTL_SECONDS).toBe(604800);
    expect(() => loadConfig({ ...validEnv, S3_URL_TTL_SECONDS: "604801" })).toThrow();
  });
});

describe("embedding configuration", () => {
  it("uses OpenRouter with Gemini Embedding 2 when OPENROUTER_API_KEY is set, and bounds serialized requests", () => {
    const { embedding } = loadConfig(validEnv);
    expect(embedding).toMatchObject({
      api: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "test-openrouter-key",
      model: "google/gemini-embedding-2",
      dimensions: 1536,
      sendDimensions: true,
      maxRequestBytes: 32 * 1_048_576,
      modalities: ["image", "audio", "video"],
    });
    expect(loadConfig({ ...validEnv, EMBEDDING_MAX_REQUEST_MB: "4" }).embedding.maxRequestBytes).toBe(4 * 1_048_576);
  });

  it("selects Ollama by EMBEDDING_BASE_URL, needs no key and defaults to image and audio", () => {
    const { embedding } = loadConfig(ollamaEnv);
    expect(embedding).toMatchObject({
      api: "ollama",
      baseURL: "http://ollama:11434",
      apiKey: undefined,
      model: "embeddinggemma-2",
      dimensions: 768,
      modalities: ["image", "audio"],
    });
    expect(loadConfig({ ...ollamaEnv, EMBEDDING_API_KEY: "proxy-key" }).embedding.apiKey).toBe("proxy-key");
  });

  it("requires exactly one backend", () => {
    expect(() => loadConfig(storageEnv)).toThrow(/OPENROUTER_API_KEY \(OpenRouter\) or EMBEDDING_BASE_URL \(Ollama\)/);
    expect(() => loadConfig({ ...ollamaEnv, ...embeddingEnv })).toThrow(/mutually exclusive/);
    expect(() => loadConfig({ ...validEnv, EMBEDDING_API_KEY: "other" })).toThrow(/only used together with EMBEDDING_BASE_URL/);
  });

  it("makes the model and vector size explicit for Ollama", () => {
    const { EMBEDDING_MODEL: _model, EMBEDDING_DIMENSIONS: _dimensions, ...bare } = ollamaEnv;
    expect(() => loadConfig(bare)).toThrow(/EMBEDDING_MODEL is required/);
    expect(() => loadConfig({ ...bare, EMBEDDING_MODEL: "embeddinggemma-2" })).toThrow(/EMBEDDING_DIMENSIONS is required/);
  });

  it("validates the declared modalities and refuses video for Ollama", () => {
    expect(loadConfig({ ...validEnv, EMBEDDING_MODALITIES: "image, audio" }).embedding.modalities).toEqual(["image", "audio"]);
    expect(loadConfig({ ...ollamaEnv, EMBEDDING_MODALITIES: "image" }).embedding.modalities).toEqual(["image"]);
    expect(() => loadConfig({ ...validEnv, EMBEDDING_MODALITIES: "text" })).toThrow(/EMBEDDING_MODALITIES/);
    expect(() => loadConfig({ ...validEnv, EMBEDDING_MODALITIES: " , " })).toThrow(/EMBEDDING_MODALITIES/);
    expect(() => loadConfig({ ...ollamaEnv, EMBEDDING_MODALITIES: "image,video" })).toThrow(/Ollama does not accept video/);
  });

  it("defaults to valid segment windows and rejects overlapping ones", () => {
    const config = loadConfig(validEnv);
    expect(config.MEDIA_SEGMENT_SECONDS).toBe(60);
    expect(config.MEDIA_SEGMENT_OVERLAP_SECONDS).toBe(5);
    expect(() => loadConfig({ ...validEnv, MEDIA_SEGMENT_SECONDS: "5", MEDIA_SEGMENT_OVERLAP_SECONDS: "5" })).toThrow(/smaller than/);
  });
});
