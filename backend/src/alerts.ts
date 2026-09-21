/**
 * Tranche-B alert sinks: a generic JSON webhook plus Telegram Bot API.
 * Both are optional and fail soft — alerting must never break the request
 * that triggered it. Routes compose the digest text; this module only sends.
 */
import type { Config } from "./config.ts";

export interface AlertResult {
  sent: boolean;
  sinks: string[];
  errors: string[];
}

export function alertSinks(config: Config): string[] {
  const sinks: string[] = [];
  if (config.alertWebhookUrl) sinks.push("webhook");
  if (config.telegramBotToken && config.telegramChatId) sinks.push("telegram");
  return sinks;
}

async function postJson(url: string, payload: unknown): Promise<{ ok: boolean; detail: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
  if (!res.ok) return { ok: false, detail: `http ${res.status}` };
  return { ok: true, detail: `http ${res.status}` };
}

/**
 * Send `text` to every configured sink. `telegramBase` exists only so tests
 * can point the Telegram sink at a stub server; production always uses the
 * default api.telegram.org base.
 */
export async function sendAlertText(
  config: Config,
  text: string,
  opts: { telegramBase?: string } = {},
): Promise<AlertResult> {
  const sinks = alertSinks(config);
  if (sinks.length === 0) return { sent: false, sinks: [], errors: ["alerts-not-configured"] };
  const errors: string[] = [];
  const delivered: string[] = [];
  if (config.alertWebhookUrl) {
    const res = await postJson(config.alertWebhookUrl, {
      service: "neonrelay-backend",
      text,
      ts: Date.now(),
    });
    if (res.ok) delivered.push("webhook");
    else errors.push(`webhook: ${res.detail}`);
  }
  if (config.telegramBotToken && config.telegramChatId) {
    const base = opts.telegramBase ?? "https://api.telegram.org";
    let res: Response;
    try {
      res = await fetch(`${base}/bot${config.telegramBotToken}/sendMessage`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text,
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      errors.push(`telegram: ${(err as Error).message}`);
      return { sent: delivered.length > 0, sinks: delivered, errors };
    }
    if (!res.ok) {
      errors.push(`telegram: http ${res.status}`);
    } else {
      try {
        const body = (await res.json()) as { ok?: boolean; description?: string };
        if (body.ok === true) delivered.push("telegram");
        else errors.push(`telegram: ${body.description ?? "rejected"}`);
      } catch {
        errors.push("telegram: bad response");
      }
    }
  }
  return { sent: delivered.length > 0, sinks: delivered, errors };
}

export function formatDigest(title: string, lines: string[]): string {
  return lines.length === 0 ? title : `${title}\n${lines.map((l) => `• ${l}`).join("\n")}`;
}
