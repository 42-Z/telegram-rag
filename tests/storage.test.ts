import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
let failDeletes = false;
let failHeads = false;
let listPages = new Map<string, string>();
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

    if (request.method === "HEAD") {
      if (failHeads) {
        response.writeHead(403);
      } else {
        const object = objects.get(key);
        response.writeHead(object ? 200 : 404, object ? {
          "content-type": object.contentType,
          "content-length": object.bytes.byteLength,
        } : {});
      }
      response.end();
      return;
    }

    if (request.method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const page = listPages.get(parsed.searchParams.get("continuation-token") ?? "");
      if (page === undefined) {
        respondXml(response, 400, "InvalidToken");
        return;
      }
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(page);
      return;
    }

    if (request.method === "DELETE") {
      if (failDeletes) {
        respondXml(response, 403, "AccessDenied");
        return;
      }
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }

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
  failDeletes = false;
  failHeads = false;
  listPages = new Map();
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
  it("checks an original with HEAD and returns false only when it is missing", async () => {
    const storage = makeStorage();
    const original = await storage.saveOriginal({ bytes: Buffer.from("HEAD original"), contentType: "image/png" });
    expect(await storage.hasOriginal(original.key)).toBe(true);
    await storage.deleteOriginal(original.key);
    expect(await storage.hasOriginal(original.key)).toBe(false);
    const heads = requests.filter((request) => request.method === "HEAD");
    expect(heads).toHaveLength(2);
    for (const request of heads) {
      expect(new URL(request.url, endpoint).pathname).toBe(`/${BUCKET}/${original.key}`);
      expect(request.headers.authorization).toContain(ACCESS_KEY);
      expect(request.body).toHaveLength(0);
    }
    expect(requests.some((request) => request.method === "GET")).toBe(false);
  });

  it("propagates HEAD permission errors instead of treating them as missing objects", async () => {
    const storage = makeStorage();
    failHeads = true;
    await expect(storage.hasOriginal(testKey(Buffer.from("forbidden"))))
      .rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("HEAD");
  });

  it("lists all original pages, passes continuation tokens and ignores unrelated or incomplete entries", async () => {
    const storage = makeStorage();
    const first = testKey(Buffer.from("first"));
    const second = testKey(Buffer.from("second"));
    const withoutDate = testKey(Buffer.from("without date"));
    const modifiedAt = new Date("2026-11-01T10:20:30.000Z");
    const token = "opaque+/=token";
    const contents = (key: string) =>
      `<Contents><Key>${key}</Key><LastModified>${modifiedAt.toISOString()}</LastModified></Contents>`;
    listPages.set("", `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <IsTruncated>true</IsTruncated><NextContinuationToken>${token}</NextContinuationToken>
      ${contents(first)}${contents("other/file")}${contents("sha256/not-a-digest")}
      <Contents><Key>${withoutDate}</Key></Contents>
      <Contents><LastModified>${modifiedAt.toISOString()}</LastModified></Contents>
    </ListBucketResult>`);
    listPages.set(token, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <IsTruncated>false</IsTruncated>${contents(second)}
    </ListBucketResult>`);

    const listed = [];
    for await (const object of storage.listOriginals()) listed.push(object);
    expect(listed).toEqual([{ key: first, modifiedAt }, { key: second, modifiedAt }]);
    expect(requests).toHaveLength(2);
    const urls = requests.map((request) => new URL(request.url, endpoint));
    for (const url of urls) {
      expect(url.pathname).toBe(`/${BUCKET}/`);
      expect(url.searchParams.get("list-type")).toBe("2");
      expect(url.searchParams.get("prefix")).toBe("sha256/");
    }
    expect(urls[0]!.searchParams.has("continuation-token")).toBe(false);
    expect(urls[1]!.searchParams.get("continuation-token")).toBe(token);
  });

  it("handles an empty object list", async () => {
    const storage = makeStorage();
    listPages.set("", "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
    const listed = [];
    for await (const object of storage.listOriginals()) listed.push(object);
    expect(listed).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("rejects truncated listings without a continuation token", async () => {
    const storage = makeStorage();
    listPages.set("", "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>");
    await expect(storage.listOriginals()[Symbol.asyncIterator]().next()).rejects.toThrow(/continuation token/);
    expect(requests).toHaveLength(1);
  });

  it("deletes an original using DELETE and accepts an already missing object", async () => {
    const storage = makeStorage();
    const original = await storage.saveOriginal({ bytes: Buffer.from("delete me"), contentType: "text/plain" });
    await storage.deleteOriginal(original.key);
    expect(objects.has(original.key)).toBe(false);
    await storage.deleteOriginal(original.key);
    const deletes = requests.filter((request) => request.method === "DELETE");
    expect(deletes).toHaveLength(2);
    for (const request of deletes) {
      expect(new URL(request.url, endpoint).pathname).toBe(`/${BUCKET}/${original.key}`);
      expect(request.body).toHaveLength(0);
      expect(request.headers.authorization).toContain(ACCESS_KEY);
    }
  });

  it("surfaces an S3 deletion failure", async () => {
    const storage = makeStorage();
    const original = await storage.saveOriginal({ bytes: Buffer.from("keep me"), contentType: "text/plain" });
    failDeletes = true;
    await expect(storage.deleteOriginal(original.key)).rejects.toThrow();
    expect(objects.has(original.key)).toBe(true);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

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

  it("streams an original from a file and keeps the same digest-only path", async () => {
    const storage = makeStorage();
    const dir = await mkdtemp(join(tmpdir(), "telegram-rag-storage-"));
    const path = join(dir, "original.bin");
    const original = Buffer.alloc(1_048_576 + 17, 0x5a);
    await writeFile(path, original);
    try {
      const stored = await storage.saveOriginalFile({
        path,
        contentType: "video/mp4",
        filename: "clip.mp4",
      });

      expect(stored).toEqual({
        key: testKey(original),
        sha256: createHash("sha256").update(original).digest("hex"),
        size: original.byteLength,
        contentType: "video/mp4",
      });
      const put = requests.find((request) => request.method === "PUT");
      expect(put?.headers["content-length"]).toBe(String(original.byteLength));
      expect(put?.headers["x-amz-meta-filename"]).toBe("clip.mp4");
      expect(put?.body).toEqual(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

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

  it("caps a signed URL at expiresBy and rounds down to whole seconds", async () => {
    const storage = makeStorage({ urlTtlSeconds: 3600 });
    const now = Date.UTC(2026, 10, 16, 12, 0, 0, 250);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const expiresBy = new Date(now + 20_500);
      const signed = await storage.signGet(testKey(Buffer.from("temporary original")), expiresBy);
      const url = new URL(signed.url);
      expect(signed.expiresIn).toBe(20);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("20");
      expect(signed.expiresAt).toEqual(urlExpiresAt(url));
      expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(expiresBy.getTime());
      expect(requests).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not extend the configured URL TTL when expiresBy is later", async () => {
    const storage = makeStorage({ urlTtlSeconds: 90 });
    const signed = await storage.signGet(testKey(Buffer.from("original")), new Date(Date.now() + 3_600_000));
    expect(signed.expiresIn).toBe(90);
    expect(new URL(signed.url).searchParams.get("X-Amz-Expires")).toBe("90");
  });

  it("still respects temporary credentials when they expire before expiresBy", async () => {
    const now = Date.UTC(2026, 10, 16, 12);
    const expiration = new Date(now + 15_000);
    const storage = makeStorage({
      urlTtlSeconds: 3600,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, expiration },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const signed = await storage.signGet(testKey(Buffer.from("original")), new Date(now + 30_000));
      expect(signed.expiresIn).toBe(15);
      expect(signed.expiresAt).toEqual(expiration);
      expect(urlExpiresAt(new URL(signed.url))).toEqual(expiration);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects signing when expiresBy has already elapsed", async () => {
    const storage = makeStorage();
    await expect(storage.signGet(testKey(Buffer.from("expired")), new Date(Date.now() - 1000)))
      .rejects.toThrow("Original retention expires too soon to sign a GET URL");
    expect(requests).toHaveLength(0);
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
    await expect(storage.deleteOriginal("../../bucket/object")).rejects.toThrow(/SHA-256/);
    await expect(storage.hasOriginal("../../bucket/object")).rejects.toThrow(/SHA-256/);
    expect(requests).toHaveLength(0);
  });
});

function urlExpiresAt(url: URL): Date {
  return new Date(signingDate(url).getTime() + Number(url.searchParams.get("X-Amz-Expires")) * 1_000);
}
