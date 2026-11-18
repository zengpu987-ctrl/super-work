/**
 * 图片输入映射：把 `ChatMessage.images`（data URL 数组）转成各协议的 content parts。
 *
 * 约定（DESIGN v0.0.3 §6）：
 * - 图片是 data URL（`data:image/png;base64,...`），多图保持数组顺序；
 * - 没有图片时返回原来的字符串 content，保证旧请求体逐字节不变；
 * - Anthropic / Gemini 需要从 data URL 拆出 MIME 与 base64；解析失败的图片跳过，
 *   不让一张坏图毁掉整次调用。
 */
import type { ChatMessage } from "@super-work/core";

export interface ParsedImageData {
  /** 例如 image/png */
  mime: string;
  /** 不含 data URL 前缀的 base64 */
  base64: string;
  /** 原始 data URL */
  dataUrl: string;
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,([\s\S]+)$/;

/** 解析 data URL 图片；不是 `data:image/*;base64,` 时返回 undefined。 */
export function parseImageDataUrl(value: string): ParsedImageData | undefined {
  const dataUrl = value.trim();
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) return undefined;
  const mime = (match[1] ?? "").trim().toLowerCase();
  const base64 = (match[2] ?? "").replace(/\s+/g, "");
  if (!mime.startsWith("image/") || base64 === "") return undefined;
  return { mime, base64, dataUrl };
}

/** 过滤空串后的图片列表（保持原顺序）。 */
export function messageImages(message: ChatMessage): string[] {
  return (message.images ?? []).map((image) => image.trim()).filter(Boolean);
}

/** 这条消息是否带可用图片。 */
export function hasImages(message: ChatMessage): boolean {
  return messageImages(message).length > 0;
}

/**
 * OpenAI 兼容 chat 的 content（openai-compat / relay / workbuddy）：
 * 无图返回字符串；有图返回 `[{type:"text"},{type:"image_url",image_url:{url}}...]`。
 */
export function openAIChatContent(
  message: ChatMessage,
): string | Array<Record<string, unknown>> {
  const images = messageImages(message);
  if (images.length === 0) return message.content;
  const parts: Array<Record<string, unknown>> = [];
  if (message.content !== "") parts.push({ type: "text", text: message.content });
  for (const url of images) parts.push({ type: "image_url", image_url: { url } });
  return parts;
}

/**
 * Anthropic content blocks：
 * `[{type:"image",source:{type:"base64",media_type,data}}..., {type:"text"}]`。
 * 无图返回字符串；图片按顺序在前、文本在后（Anthropic 官方推荐顺序）。
 */
export function anthropicContent(
  message: ChatMessage,
): string | Array<Record<string, unknown>> {
  const images = messageImages(message);
  if (images.length === 0) return message.content;
  const blocks: Array<Record<string, unknown>> = [];
  for (const dataUrl of images) {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) continue;
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: parsed.mime, data: parsed.base64 },
    });
  }
  if (message.content !== "") blocks.push({ type: "text", text: message.content });
  return blocks.length > 0 ? blocks : message.content;
}

/** Gemini parts：文本 + `{inlineData:{mimeType,data}}`，多图按顺序。 */
export function geminiParts(message: ChatMessage): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (message.content !== "") parts.push({ text: message.content });
  for (const dataUrl of messageImages(message)) {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) continue;
    parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.base64 } });
  }
  return parts;
}

/**
 * OpenAI Responses API 的 content parts：
 * `[{type:"input_text"},{type:"input_image",image_url:<data URL>}...]`。
 * Responses 的图片 part 类型与 chat/completions 不同（input_image 而非 image_url）。
 */
export function responsesContent(message: ChatMessage): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (message.content !== "") parts.push({ type: "input_text", text: message.content });
  for (const url of messageImages(message)) {
    parts.push({ type: "input_image", image_url: url });
  }
  return parts;
}
