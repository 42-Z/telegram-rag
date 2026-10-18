import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const storageEnv = {
  MEDIA_TYPES: "photo,voice",
  S3_REGION: "us-east-1",
  S3_BUCKET: "media",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
};

describe("S3 configuration", () => {
  it("defaults to path-style requests and a one-hour signed URL", () => {
    const config = loadConfig(storageEnv);

    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
    expect(config.S3_URL_TTL_SECONDS).toBe(3600);
    expect(config.S3_ENDPOINT).toBeUndefined();
    expect(config.S3_SESSION_TOKEN).toBeUndefined();
  });

  it("accepts a custom endpoint, temporary token, and virtual-host addressing", () => {
    const config = loadConfig({
      ...storageEnv,
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
      const config = loadConfig({ ...storageEnv, S3_ENDPOINT: `http://${host}:9000` });
      expect(config.S3_ENDPOINT).toBe(`http://${host}:9000`);
    }

    expect(() =>
      loadConfig({ ...storageEnv, S3_ENDPOINT: "http://objects.example.test:9000" }),
    ).toThrow(/S3_ENDPOINT must use HTTPS/);
    expect(
      loadConfig({ ...storageEnv, S3_ENDPOINT: "https://objects.example.test" }).S3_ENDPOINT,
    ).toBe("https://objects.example.test");
    expect(() => loadConfig({ ...storageEnv, S3_ENDPOINT: "https://user:password@objects.example.test" })).toThrow();
    expect(() => loadConfig({ ...storageEnv, S3_ENDPOINT: "https://objects.example.test?token=secret" })).toThrow();
  });

  it("requires complete storage configuration when media types are enabled", () => {
    expect(() => loadConfig({ MEDIA_TYPES: "photo" })).toThrow(/S3 is required while MEDIA_TYPES is enabled/);
    expect(() => loadConfig({ ...storageEnv, S3_SECRET_ACCESS_KEY: "" })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => loadConfig({ ...storageEnv, S3_SESSION_TOKEN: "temporary" })).toThrow(/S3_CREDENTIALS_EXPIRES_AT/);
  });

  it("allows text-only mode without S3, but rejects a partial S3 setup", () => {
    expect(loadConfig({ MEDIA_TYPES: " , " }).MEDIA_TYPES).toEqual([]);
    expect(() => loadConfig({ MEDIA_TYPES: "", S3_BUCKET: "media" })).toThrow(/S3 configuration is incomplete/);
  });

  it("rejects malformed endpoints and invalid URL TTLs", () => {
    expect(() => loadConfig({ ...storageEnv, S3_ENDPOINT: "ftp://objects.example.test" })).toThrow();
    expect(() => loadConfig({ ...storageEnv, S3_URL_TTL_SECONDS: "0" })).toThrow();
  });

  it("accepts the SigV4 maximum URL TTL and rejects the next second", () => {
    expect(loadConfig({ ...storageEnv, S3_URL_TTL_SECONDS: "604800" }).S3_URL_TTL_SECONDS).toBe(604800);
    expect(() => loadConfig({ ...storageEnv, S3_URL_TTL_SECONDS: "604801" })).toThrow();
  });
});

describe("embedding configuration", () => {
  it("uses Gemini Embedding 2 and bounds serialized requests", () => {
    const config = loadConfig({ ...storageEnv, MEDIA_TYPES: "" });
    expect(config.EMBEDDING_MODEL).toBe("google/gemini-embedding-2");
    expect(config.EMBEDDING_DIMENSIONS).toBe(1536);
    expect(config.EMBEDDING_MAX_REQUEST_MB).toBe(32);
    expect(loadConfig({ ...storageEnv, MEDIA_TYPES: "", EMBEDDING_MAX_REQUEST_MB: "4" }).EMBEDDING_MAX_REQUEST_MB).toBe(4);
  });

  it("defaults to all supported media types and valid segment windows", () => {
    const config = loadConfig({ ...storageEnv, MEDIA_TYPES: undefined });
    expect(config.MEDIA_TYPES).toEqual(["photo", "voice", "video_note", "audio", "video", "gif"]);
    expect(config.MEDIA_SEGMENT_SECONDS).toBe(60);
    expect(config.MEDIA_SEGMENT_OVERLAP_SECONDS).toBe(5);
    expect(() => loadConfig({ ...storageEnv, MEDIA_TYPES: "", MEDIA_SEGMENT_SECONDS: "5", MEDIA_SEGMENT_OVERLAP_SECONDS: "5" })).toThrow(/smaller than/);
    expect(() => loadConfig({ ...storageEnv, MEDIA_TYPES: "photo,pdf" })).toThrow(/Unsupported MEDIA_TYPES/);
  });
});
