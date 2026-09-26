/**
 * Путь через драйвер pg — тот, которым сервис ходит в Supabase и Neon.
 * Вместо облака — PGlite, отданный по сетевому протоколу Postgres
 * (pglite-socket): драйвер, пул, параметры и типы — настоящие.
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, describe, expect, it } from "vitest";
import { explainConnectionError, migrate, openDb, postgresConfig } from "../src/db.ts";
import { Indexer } from "../src/indexer.ts";
import { Store } from "../src/store.ts";
import { callTool } from "../src/tools.ts";
import { DIMENSIONS, fakeEmbedder, seed } from "./helpers.ts";

describe("строка подключения", () => {
  it("Neon: SSL с проверкой и channel binding", async () => {
    const config = await postgresConfig(
      "postgresql://neondb_owner:secret@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    );
    expect(config).toMatchObject({
      user: "neondb_owner",
      password: "secret",
      host: "ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech",
      database: "neondb",
      enableChannelBinding: true,
      keepAlive: true,
    });
    expect(config.ssl).toBeTruthy();
    expect(config.ssl.rejectUnauthorized).not.toBe(false);
    // require закреплён как полная проверка сертификата
    expect(config.ssl).toEqual({});
  });

  it("Supabase: свой корневой сертификат подставляется поверх строки", async () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const config = await postgresConfig(
      "postgresql://postgres.abcdefgh:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
      { caCert: pem },
    );
    expect(config.ssl).toMatchObject({ ca: pem, rejectUnauthorized: true });
    expect(config.port).toBe(5432);
    expect(config.enableChannelBinding).toBe(false);
  });

  it("понятные объяснения частых ошибок", () => {
    const ipv6 = Object.assign(new Error("connect ENETUNREACH 2a05::1:5432"), { code: "ENETUNREACH" });
    expect(explainConnectionError(ipv6, "postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres")).toContain(
      "Session pooler",
    );
    expect(explainConnectionError(new Error("self-signed certificate in certificate chain"), "postgres://x@h/db")).toContain(
      "DATABASE_CA_CERT",
    );
    expect(explainConnectionError(new Error("что-то своё"), "postgres://x@h/db")).toBe("что-то своё");
  });
});

describe("сервис через драйвер pg", async () => {
  const pglite = await PGlite.create({ extensions: { vector } });
  const server = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1" });
  await server.start();
  const url = `postgres://postgres@${server.getServerConn()}/postgres`;

  const db = await openDb(url, { poolSize: 1 });
  afterAll(async () => {
    await db.close();
    await server.stop();
    await pglite.close();
  });

  it("схема, запись, индексация и поиск", async () => {
    await migrate(db, { model: "fake", dimensions: DIMENSIONS });
    const store = new Store(db);
    await seed(store);
    const embedder = fakeEmbedder();
    const indexer = new Indexer(store, embedder, 64);
    while ((await indexer.runOnce()) > 0);

    // int8, jsonb, даты и векторы проходят через драйвер без потерь
    expect(await store.indexStats()).toMatchObject({ posts: 6, indexed: 6, pending: 0 });
    const [channel] = await store.listChannels();
    expect(typeof channel!.id).toBe("number");
    expect(channel!.addedAt).toBeInstanceOf(Date);

    const context = { store, embedder };
    const found = (await callTool("search_posts", { query: "рецепт борща", limit: 1 }, context)) as any;
    expect(found.results[0]).toMatchObject({ channel: "Кулинария", message_id: 1 });

    const post = (await callTool("get_post", { link: "https://t.me/tech/3" }, context)) as any;
    expect(post.album).toHaveLength(2);
  });

  it("повторный запуск на той же базе ничего не ломает", async () => {
    await migrate(db, { model: "fake", dimensions: DIMENSIONS });
    expect((await new Store(db).indexStats()).indexed).toBe(6);
  });
});
