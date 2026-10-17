import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createObjectStorage, type ObjectStorage, type S3StorageConfig } from "../src/storage.ts";

const BUCKET = "test-media";
const ACCESS_KEY = "test-access-key";
const SECRET_KEY = "test-secret-key-not-real";

interface RequestRecord {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

interface StoredResponse {
  bytes: Buffer;
  contentType: string;
}

let server: Server;
let endpoint: string;
let failPuts = false;
let requests: RequestRecord[] = [];
let objects = new Map<string, StoredResponse>();
const storages: ObjectStorage[] = [];

const baseConfig: S3StorageConfig = {
  region: "us-east-1",
  bucket: BUCKET,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true,
  urlTtlSeconds: 90,
};

async function collectBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function respondXml(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(`<Error><Code>${code}</Code><Message>local test error</Message></Error>`);
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const body = await collectBody(request);
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body,
    });

    const parsed = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const bucketPrefix = `/${BUCKET}/`;
    if (!parsed.pathname.startsWith(bucketPrefix)) {
      respondXml(response, 404, "NoSuchBucket");
      return;
    }
    const key = decodeURIComponent(parsed.pathname.slice(bucketPrefix.length));

    if (request.method === "PUT") {
      if (failPuts) {
        respondXml(response, 500, "InternalError");
        return;
      }
      objects.set(key, {
        bytes: body,
        contentType: request.headers["content-type"] ?? "",
      });
      response.writeHead(200, { "x-amz-request-id": "local-test" });
      response.end();
      return;
    }

    if (request.method === "GET") {
      const object = objects.get(key);
      if (!object) {
        respondXml(response, 404, "NoSuchKey");
        return;
      }
      response.writeHead(200, {
        "content-type": object.contentType,
        "content-length": object.bytes.byteLength,
        etag: '"local-test-etag"',
      });
      response.end(object.bytes);
      return;
    }

    respondXml(response, 405, "MethodNotAllowed");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.all(storages.splice(0).map((storage) => storage.close()));
  failPuts = false;
  requests = [];
  objects = new Map();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function makeStorage(overrides: Partial<S3StorageConfig> = {}): ObjectStorage {
  const storage = createObjectStorage({ endpoint, ...baseConfig, ...overrides });
  storages.push(storage);
  return storage;
}

function testKey(bytes: Uint8Array): string {
  return `sha256/${createHash("sha256").update(bytes).digest("hex")}`;
}

function signingDate(url: URL): Date {
  const value = url.searchParams.get("X-Amz-Date")!;
  return new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );
}

describe("S3-compatible object storage", () => {
  it("uploads and downloads original bytes at a digest-only path", async () => {
    const storage = makeStorage();
    const original = Buffer.from([0, 255, 1, 128, 10, 13, 42]);
    const stored = await storage.saveOriginal({
      bytes: original,
      contentType: "image/png",
      filename: "telegram-photo.png",
    });

    expect(stored).toEqual({
      key: testKey(original),
      sha256: createHash("sha256").update(original).digest("hex"),
      size: original.byteLength,
      contentType: "image/png",
    });

    const put = requests.find((request) => request.method === "PUT");
    expect(put).toBeDefined();
    const putUrl = new URL(put!.url, endpoint);
    expect(putUrl.origin).toBe(endpoint);
    expect(putUrl.pathname).toBe(`/${BUCKET}/${stored.key}`);
    expect(putUrl.pathname).not.toContain("telegram-photo.png");
    expect(put!.headers["content-type"]).toBe("image/png");
    expect(put!.headers["content-length"]).toBe(String(original.byteLength));
    expect(put!.headers["x-amz-meta-filename"]).toBe("telegram-photo.png");
    expect(put!.body).toEqual(original);

    const downloaded = await storage.readOriginal(stored.key);
    expect(downloaded).toEqual(original);
    const get = requests.find((request) => request.method === "GET");
    expect(new URL(get!.url, endpoint).pathname).toBe(`/${BUCKET}/${stored.key}`);
  });

  it("keeps filename metadata within the 2048-byte S3 limit and rejects overflow before PUT", async () => {
    const storage = makeStorage();
    const contentType = "text/plain";

    await storage.saveOriginal({
      bytes: Buffer.from("metadata at limit"),
      contentType,
      filename: "я".repeat(340),
    });
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(Buffer.byteLength(String(requests[0]!.headers["x-amz-meta-filename"]), "utf8")).toBe(2040);

    const oversizedUpload = storage.saveOriginal({
      bytes: Buffer.from("metadata over limit"),
      contentType,
      filename: "я".repeat(341),
    });
    await expect(oversizedUpload).rejects.toThrow(TypeError);
    await expect(oversizedUpload).rejects.toThrow(/2048-byte/);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it("uses the configured endpoint and signs a direct path-style GET URL", async () => {
    const storage = makeStorage();
    const key = testKey(Buffer.from("original"));
    const signed = await storage.signGet(key);
    const url = new URL(signed.url);

    expect(url.origin).toBe(endpoint);
    expect(url.pathname).toBe(`/${BUCKET}/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("90");
    expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(url.searchParams.get("X-Amz-Credential")?.startsWith(`${ACCESS_KEY}/`)).toBe(true);
    expect(signed.expiresIn).toBe(90);
    expect(signed.expiresAt).toEqual(new Date(signingDate(url).getTime() + 90_000));
    expect(requests).toHaveLength(0);
  });

  it("preserves virtual-host addressing when explicitly requested", async () => {
    const storage = makeStorage({
      endpoint: "https://objects.example.test",
      forcePathStyle: false,
    });
    const signed = await storage.signGet(testKey(Buffer.from("original")));
    const url = new URL(signed.url);

    expect(url.hostname).toBe(`${BUCKET}.objects.example.test`);
    expect(url.pathname).toBe(`/${testKey(Buffer.from("original"))}`);
  });

  it("never signs beyond the expiry returned by temporary credentials", async () => {
    const expiration = new Date(Date.now() + 20_000);
    let providerCalls = 0;
    const storage = makeStorage({
      urlTtlSeconds: 3600,
      credentials: async () => {
        providerCalls += 1;
        return {
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET_KEY,
          sessionToken: "temporary-test-token",
          expiration,
        };
      },
    });
    const signed = await storage.signGet(testKey(Buffer.from("original")));
    const url = new URL(signed.url);

    expect(providerCalls).toBe(1);
    expect(signed.expiresIn).toBeLessThan(3600);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBe(signed.expiresIn);
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("temporary-test-token");
    expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(expiration.getTime());
    expect(urlExpiresAt(url).getTime()).toBeLessThanOrEqual(expiration.getTime());
  });

  it("surfaces failed uploads and retries no more than the configured attempt limit", async () => {
    const storage = makeStorage();
    failPuts = true;

    await expect(
      storage.saveOriginal({ bytes: Buffer.from("failure"), contentType: "text/plain" }),
    ).rejects.toThrow();

    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(3);
  });

  it("rejects keys that are not generated SHA-256 object keys", async () => {
    const storage = makeStorage();

    await expect(storage.readOriginal("../../bucket/object")).rejects.toThrow(/SHA-256/);
    await expect(storage.signGet("https://t.me/+invite")).rejects.toThrow(/SHA-256/);
    expect(requests).toHaveLength(0);
  });
});

function urlExpiresAt(url: URL): Date {
  return new Date(signingDate(url).getTime() + Number(url.searchParams.get("X-Amz-Expires")) * 1_000);
}
