/** 轻量 token 估算（离线、不引入 tokenizer 依赖）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

/** 估算一组文本片段的总 token。 */
export function estimateMany(texts: Array<string | undefined | null>): number {
  return texts.reduce((sum, t) => sum + (t ? estimateTokens(t) : 0), 0);
}
