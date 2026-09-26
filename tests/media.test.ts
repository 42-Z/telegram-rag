/**
 * Медиа → текст: настоящий ffmpeg на сгенерированных файлах, подменённые
 * Telegram (скачивание) и модель (разбор).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildUserContent, mediaText, parseAnalysis, type MediaInput } from "../src/media/analyzer.ts";
import { extractFrames, resizeImage, toMp3 } from "../src/media/ffmpeg.ts";
import { MediaProcessor } from "../src/media/processor.ts";
import { Indexer } from "../src/indexer.ts";
import { callTool } from "../src/tools.ts";
import { normalizeMessage } from "../src/telegram/normalize.ts";
import { fakeEmbedder, freshStore, message } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "telegram-rag-test-"));
function generate(name: string, args: string[]): Buffer {
  const out = join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  return readFileSync(out);
}

// Голосовое Telegram — OGG/Opus, кружок — квадратное MP4 со звуком.
const voice = generate("voice.ogg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libopus"]);
const circle = generate("circle.mp4", [
  "-f", "lavfi", "-i", "testsrc=size=384x384:rate=25:duration=4",
  "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
]);
const silentVideo = generate("silent.mp4", ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
const photo = generate("photo.png", ["-f", "lavfi", "-i", "testsrc=size=3000x2000", "-frames:v", "1"]);

const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8;
const isMp3 = (b: Buffer) => b.subarray(0, 3).toString() === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);

describe("ffmpeg", () => {
  it("голосовое → mp3", async () => {
    const mp3 = await toMp3(voice);
    expect(mp3 && isMp3(mp3)).toBe(true);
  });

  it("кружок → кадры и звук", async () => {
    const frames = await extractFrames(circle, 4, 3);
    expect(frames).toHaveLength(3);
    expect(frames.every(isJpeg)).toBe(true);
    expect(await toMp3(circle)).not.toBeNull();
  });

  it("видео без звука → звука нет, а не ошибка", async () => {
    expect(await toMp3(silentVideo)).toBeNull();
  });

  it("большое фото уменьшается до JPEG", async () => {
    const jpeg = await resizeImage(photo, 1536);
    expect(isJpeg(jpeg)).toBe(true);
    const out = join(dir, "resized.jpg");
    writeFileSync(out, jpeg);
    const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).toString().trim();
    expect(size).toBe("1536,1024");
  });
});

describe("запрос и ответ модели", () => {
  it("звук — input_audio mp3, картинки — data-URL", () => {
    const parts = buildUserContent({ type: "video_note", images: [Buffer.from("img")], audio: Buffer.from("snd"), caption: "Подпись" });
    expect(parts[0]).toMatchObject({ type: "text" });
    expect((parts[0] as any).text).toContain("кружок");
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,aW1n" } });
    expect(parts[2]).toEqual({ type: "input_audio", input_audio: { data: "c25k", format: "mp3" } });
  });

  it("ответ по схеме и без неё", () => {
    expect(parseAnalysis('{"transcript":"Привет","description":"","text_on_image":" "}', "m")).toEqual({
      transcript: "Привет",
      description: undefined,
      textOnImage: undefined,
      model: "m",
    });
    expect(parseAnalysis("просто текст", "m").description).toBe("просто текст");
  });

  it("текст для поиска", () => {
    expect(mediaText("voice", 75, { transcript: "Всем привет" })).toBe("[Голосовое сообщение, 1:15]\nРасшифровка: Всем привет");
    expect(mediaText("photo", undefined, {})).toBeNull();
  });
});

describe("очередь медиа", async () => {
  const { db, store } = await freshStore();
  afterAll(() => db.close());
  await store.upsertChannel({ id: 1, ref: "@ch", username: "ch", title: "Канал", about: null, accessHash: "1" });
  const doc = (mimeType: string, attributes: unknown[], id: number, size = 1000) => ({
    className: "MessageMediaDocument",
    document: { id: { toString: () => String(id) }, mimeType, size, attributes },
  });
  await store.upsertPosts([
    normalizeMessage(1, message(1, "", { media: doc("audio/ogg", [{ className: "DocumentAttributeAudio", voice: true, duration: 3 }], 11) })),
    normalizeMessage(1, message(2, "Смотрите кружок", { media: doc("video/mp4", [{ className: "DocumentAttributeVideo", roundMessage: true, duration: 4 }], 12) })),
    normalizeMessage(1, message(3, "Фото дня", { media: { className: "MessageMediaPhoto", photo: { id: { toString: () => "13" } } } })),
    normalizeMessage(1, message(4, "Огромное видео", { media: doc("video/mp4", [{ className: "DocumentAttributeVideo", duration: 10 }], 14, 999_000_000) })),
    normalizeMessage(1, message(5, "Длинное голосовое", { media: doc("audio/ogg", [{ className: "DocumentAttributeAudio", voice: true, duration: 7200 }], 15) })),
    normalizeMessage(1, message(6, "Просто текст")),
  ]);

  const files: Record<number, Buffer> = { 1: voice, 2: circle, 3: photo };
  const seen: MediaInput[] = [];
  const analyzer = {
    model: "fake-vision",
    async analyze(input: MediaInput) {
      seen.push(input);
      if (input.type === "voice") return { transcript: "Договорились встретиться в четверг у фонтана", model: "fake-vision" };
      if (input.type === "video_note") return { transcript: "Показываю новый ноутбук", description: "Человек держит ноутбук", model: "fake-vision" };
      return { description: "Закат над морем", textOnImage: "ПЯТНИЦА", model: "fake-vision" };
    },
  };
  const processor = new MediaProcessor(store, analyzer, async (_c, id) => files[id] ?? Buffer.alloc(0), {
    types: ["photo", "voice", "video_note", "video"],
    maxBytes: 20 * 1_048_576,
    maxSeconds: 1800,
    concurrency: 2,
  });
  while ((await processor.runOnce()) > 0);

  it("каждый тип подготовлен по-своему", () => {
    const byType = Object.fromEntries(seen.map((input) => [input.type, input]));
    expect(byType.voice).toMatchObject({ images: [] });
    expect(byType.voice!.audio && isMp3(byType.voice!.audio)).toBe(true);
    expect(byType.video_note!.images).toHaveLength(3);
    expect(byType.video_note!.audio).not.toBeNull();
    expect(byType.video_note!.caption).toBe("Смотрите кружок");
    expect(byType.photo!.images).toHaveLength(1);
    expect(byType.photo!.audio).toBeNull();
  });

  it("слишком большое и длинное пропущено, но с причиной", async () => {
    const big = await store.getPost(1, 4);
    expect(big).toMatchObject({ mediaStatus: "skipped" });
    expect(big!.mediaAnalysis?.note).toContain("MEDIA_MAX_MB");
    expect((await store.getPost(1, 5))!.mediaAnalysis?.note).toContain("MEDIA_MAX_SECONDS");
    expect(seen).toHaveLength(3);
    expect(await store.mediaStats(["photo", "voice", "video_note", "video"])).toEqual({ done: 3, skipped: 2 });
  });

  it("расшифровка находится поиском и видна нейросети", async () => {
    const indexer = new Indexer(store, fakeEmbedder(), 64);
    while ((await indexer.runOnce()) > 0);
    const context = { store, embedder: fakeEmbedder() };

    const byWords = (await callTool("search_posts", { query: "фонтана", mode: "keyword" }, context)) as any;
    expect(byWords.results[0]).toMatchObject({ message_id: 1 });
    expect(byWords.results[0].media).toMatchObject({ type: "voice", transcript: "Договорились встретиться в четверг у фонтана" });

    const bySense = (await callTool("search_posts", { query: "встреча в четверг у фонтана", mode: "semantic" }, context)) as any;
    expect(bySense.results[0].message_id).toBe(1);

    const post = (await callTool("get_post", { link: "https://t.me/ch/3" }, context)) as any;
    expect(post.media).toMatchObject({ type: "photo", description: "Закат над морем", text_on_image: "ПЯТНИЦА" });
    expect(post.media.fileId).toBeUndefined();
  });

  it("разобранное медиа переиндексирует пост; замена файла при правке — разбирает заново", async () => {
    expect((await store.indexStats()).pending).toBe(0);
    // правка подписи без замены файла — разбор остаётся
    await store.upsertPosts([normalizeMessage(1, message(3, "Фото дня (правка)", { media: { className: "MessageMediaPhoto", photo: { id: { toString: () => "13" } } } }))]);
    expect((await store.getPost(1, 3))!.mediaStatus).toBe("done");
    // новый файл — разбор сброшен и встаёт в очередь
    await store.upsertPosts([normalizeMessage(1, message(3, "Фото дня (правка)", { media: { className: "MessageMediaPhoto", photo: { id: { toString: () => "99" } } } }))]);
    expect((await store.getPost(1, 3))!.mediaStatus).toBeNull();
    expect((await store.pendingMedia(["photo"], undefined, 10)).map((j) => j.messageId)).toEqual([3]);
  });

  it("ошибка модели — failed, повтор по retry", async () => {
    const failing = new MediaProcessor(
      store,
      { model: "x", analyze: async () => Promise.reject(new Error("429 rate limit")) },
      async () => photo,
      { types: ["photo"], maxBytes: 20 * 1_048_576, maxSeconds: 1800, concurrency: 1 },
    );
    await failing.runOnce();
    expect((await store.getPost(1, 3))!.mediaStatus).toBe("failed");
    expect(await failing.runOnce()).toBe(0);
    await store.retryEmbedErrors();
    expect((await store.pendingMedia(["photo"], undefined, 10))).toHaveLength(1);
  });

  it("MEDIA_SINCE отсекает историю", async () => {
    expect(await store.pendingMedia(["photo"], new Date("2030-01-01"), 10)).toHaveLength(0);
  });
});
