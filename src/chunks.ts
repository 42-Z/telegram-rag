/**
 * Нарезка поста на куски для векторной базы. Большинство постов короче
 * одного куска и индексируются целиком; длинные (до 4096 знаков у обычного
 * поста, больше — у премиум-авторов и описаний медиа) режутся по абзацам с
 * перекрытием, чтобы мысль на стыке не терялась.
 *
 * Перед каждым куском — шапка с каналом и датой: запрос «что писал X в
 * марте» находит пост, даже если в самом тексте ни того, ни другого нет.
 */

export const CHUNK_CHARS = 2000;
export const CHUNK_OVERLAP = 200;

export function splitText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (clean.length === 0) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Разрез — на ближайшей к концу границе абзаца, предложения или слова.
      const window = clean.slice(start, end);
      const cut = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf(" "),
      );
      if (cut > size / 2) end = start + cut + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function chunkHeader(channelTitle: string, date: Date): string {
  return `Канал: ${channelTitle}\nДата: ${date.toISOString().slice(0, 10)}`;
}

export function buildChunks(input: { channelTitle: string; date: Date; text: string }): string[] {
  const header = chunkHeader(input.channelTitle, input.date);
  return splitText(input.text).map((part) => `${header}\n\n${part}`);
}
