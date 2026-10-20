import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";

const CONNECTION_TIMEOUT_MS = 5_000;
/** Простой соединения; общего requestTimeout нет — оригинал может идти дольше. */
const SOCKET_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const OBJECT_KEY_PATTERN = /^sha256\/[a-f0-9]{64}$/;
const FILENAME_METADATA_KEY = "filename";
const S3_USER_METADATA_MAX_BYTES = 2_048;

export interface S3StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  forcePathStyle: boolean;
  urlTtlSeconds: number;
}

export interface SaveOriginalInput {
  bytes: Uint8Array;
  contentType: string;
  /** Stored as object metadata only; it never contributes to the object key. */
  filename?: string;
}

export interface SaveOriginalFileInput {
  /** Path to a complete, immutable file; it is hashed and uploaded as a stream. */
  path: string;
  contentType: string;
  /** Stored as object metadata only; it never contributes to the object key. */
  filename?: string;
}

export interface StoredOriginal {
  key: string;
  sha256: string;
  size: number;
  contentType: string;
}

export interface SignedGetUrl {
  url: string;
  expiresIn: number;
  expiresAt: Date;
}

export interface ObjectStorage {
  readonly bucket: string;
  saveOriginal(input: SaveOriginalInput): Promise<StoredOriginal>;
  /** Streaming upload for originals that must not be loaded into memory whole. */
  saveOriginalFile(input: SaveOriginalFileInput): Promise<StoredOriginal>;
  readOriginal(key: string): Promise<Buffer>;
  signGet(key: string): Promise<SignedGetUrl>;
  close(): Promise<void>;
}

/** S3-compatible adapter; it does not create buckets or other cloud resources. */
export function createObjectStorage(config: S3StorageConfig): ObjectStorage {
  return new S3ObjectStorage(config);
}

class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly config: S3StorageConfig;
  readonly bucket: string;
  private closed = false;

  constructor(config: S3StorageConfig) {
    this.config = config;
    this.bucket = config.bucket;
    if (!config.region || !config.bucket) throw new TypeError("S3 region and bucket are required");
    if (!Number.isInteger(config.urlTtlSeconds) || config.urlTtlSeconds < 1 || config.urlTtlSeconds > 604_800) {
      throw new TypeError("S3 URL TTL must be an integer between 1 and 604800 seconds");
    }
    this.client = this.newClient(config.credentials);
  }

  async saveOriginal(input: SaveOriginalInput): Promise<StoredOriginal> {
    this.assertOpen();
    const encodedFilename = this.encodedFilename(input.contentType, input.filename);

    // Copy once so the digest, length, and bytes sent to S3 all describe the same snapshot.
    const bytes = Buffer.from(input.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = `sha256/${sha256}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: input.contentType,
        ...(encodedFilename === undefined
          ? {}
          : { Metadata: { [FILENAME_METADATA_KEY]: encodedFilename } }),
      }),
    );

    return { key, sha256, size: bytes.byteLength, contentType: input.contentType };
  }

  async saveOriginalFile(input: SaveOriginalFileInput): Promise<StoredOriginal> {
    this.assertOpen();
    const encodedFilename = this.encodedFilename(input.contentType, input.filename);
    const size = (await stat(input.path)).size;

    const hash = createHash("sha256");
    for await (const chunk of createReadStream(input.path)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const key = `sha256/${sha256}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(input.path),
        ContentLength: size,
        ContentType: input.contentType,
        ...(encodedFilename === undefined
          ? {}
          : { Metadata: { [FILENAME_METADATA_KEY]: encodedFilename } }),
      }),
    );

    return { key, sha256, size, contentType: input.contentType };
  }

  async readOriginal(key: string): Promise<Buffer> {
    this.assertOpen();
    this.assertObjectKey(key);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!result.Body) throw new Error(`S3 returned an empty body for ${key}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async signGet(key: string): Promise<SignedGetUrl> {
    this.assertOpen();
    this.assertObjectKey(key);

    const credentials = await this.resolveCredentials();
    const signingDate = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    let expiresIn = this.config.urlTtlSeconds;

    if (credentials.expiration !== undefined) {
      const expirationMs = credentials.expiration.getTime();
      if (!Number.isFinite(expirationMs)) throw new TypeError("Credential expiration is invalid");
      const credentialTtl = Math.floor(expirationMs / 1_000) - signingDate.getTime() / 1_000;
      expiresIn = Math.min(expiresIn, credentialTtl);
    }
    if (expiresIn < 1) throw new Error("S3 credentials expire too soon to sign a GET URL");

    // Pin the signer to the credentials whose expiration was just checked.
    const signingClient = this.newClient(credentials);
    try {
      const url = await getSignedUrl(
        signingClient,
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { expiresIn, signingDate },
      );
      return {
        url,
        expiresIn,
        expiresAt: new Date(signingDate.getTime() + expiresIn * 1_000),
      };
    } finally {
      signingClient.destroy();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.destroy();
  }

  private newClient(credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider): S3Client {
    return new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials,
      maxAttempts: MAX_ATTEMPTS,
      // S3-compatible сервисы не обязаны понимать aws-chunked trailers; для
      // потоковой загрузки достаточно Content-Length и TLS.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        // Большой оригинал передаётся минутами; общий таймаут оборвал бы его.
        // Зависшее соединение ловит socketTimeout по отсутствию активности.
        requestTimeout: 0,
        socketTimeout: SOCKET_TIMEOUT_MS,
      }),
    });
  }

  private async resolveCredentials(): Promise<AwsCredentialIdentity> {
    return typeof this.config.credentials === "function"
      ? this.config.credentials()
      : this.config.credentials;
  }

  private encodedFilename(contentType: string, filename: string | undefined): string | undefined {
    if (!contentType || /[\r\n]/.test(contentType)) {
      throw new TypeError("A valid content type is required");
    }
    if (filename !== undefined && /[\u0000-\u001f\u007f]/.test(filename)) {
      throw new TypeError("Filename metadata cannot contain control characters");
    }
    const encodedFilename = filename === undefined ? undefined : encodeURIComponent(filename);
    const filenameMetadataBytes = encodedFilename === undefined
      ? 0
      : Buffer.byteLength(FILENAME_METADATA_KEY, "utf8") + Buffer.byteLength(encodedFilename, "utf8");
    if (filenameMetadataBytes > S3_USER_METADATA_MAX_BYTES) {
      throw new TypeError(`Filename metadata exceeds S3's ${S3_USER_METADATA_MAX_BYTES}-byte user metadata limit`);
    }
    return encodedFilename;
  }

  private assertObjectKey(key: string): void {
    if (!OBJECT_KEY_PATTERN.test(key)) {
      throw new TypeError("Object key must be a SHA-256 storage key");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Storage client is closed");
  }
}
