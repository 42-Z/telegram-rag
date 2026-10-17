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
      S3_FORCE_PATH_STYLE: "false",
      S3_URL_TTL_SECONDS: "120",
    });

    expect(config).toMatchObject({
      S3_ENDPOINT: "https://objects.example.test",
      S3_SESSION_TOKEN: "test-session-token",
      S3_FORCE_PATH_STYLE: false,
      S3_URL_TTL_SECONDS: 120,
    });
  });

  it("requires complete storage configuration when media types are enabled", () => {
    expect(() => loadConfig({ MEDIA_TYPES: "photo" })).toThrow(/S3 is required while MEDIA_TYPES is enabled/);
    expect(() => loadConfig({ ...storageEnv, S3_SECRET_ACCESS_KEY: "" })).toThrow(/S3_SECRET_ACCESS_KEY/);
  });

  it("allows text-only mode without S3, but rejects a partial S3 setup", () => {
    expect(loadConfig({ MEDIA_TYPES: " , " }).MEDIA_TYPES).toEqual([]);
    expect(() => loadConfig({ MEDIA_TYPES: "", S3_BUCKET: "media" })).toThrow(/S3 configuration is incomplete/);
  });

  it("rejects malformed endpoints and invalid URL TTLs", () => {
    expect(() => loadConfig({ ...storageEnv, S3_ENDPOINT: "ftp://objects.example.test" })).toThrow();
    expect(() => loadConfig({ ...storageEnv, S3_URL_TTL_SECONDS: "0" })).toThrow();
  });
});
