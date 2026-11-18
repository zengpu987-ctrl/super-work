type Level = "debug" | "info" | "warn" | "error";

function line(level: Level, scope: string, message: string, extra?: unknown): string {
  const ts = new Date().toISOString().slice(11, 23);
  const tail = extra === undefined ? "" : ` ${safeJson(extra)}`;
  return `[${ts}] ${level.toUpperCase().padEnd(5)} ${scope} · ${message}${tail}`;
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return String(v);
  }
}

export function createLogger(scope: string) {
  const log = (level: Level, message: string, extra?: unknown) => {
    const text = line(level, scope, message, extra);
    if (level === "error" || level === "warn") console.error(text);
    else console.log(text);
  };
  return {
    debug: (m: string, e?: unknown) => log("debug", m, e),
    info: (m: string, e?: unknown) => log("info", m, e),
    warn: (m: string, e?: unknown) => log("warn", m, e),
    error: (m: string, e?: unknown) => log("error", m, e),
    child: (sub: string) => createLogger(`${scope}/${sub}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;

/** 生成一个不会泄露凭证的错误描述。 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message || error.name;
    return msg.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1…").slice(0, 400);
  }
  return String(error).slice(0, 400);
}
