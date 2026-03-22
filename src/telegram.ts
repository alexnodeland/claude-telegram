import { TELEGRAM_API_BASE } from "./config.js";
import type {
  TelegramBotCommand,
  TelegramGetUpdatesResponse,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramSendMessageResponse,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export class TelegramClient {
  private readonly base: string;

  constructor(private readonly token: string) {
    this.base = `${TELEGRAM_API_BASE}/bot${token}`;
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram API returned ok=false: ${json.description ?? "unknown error"}`);
    }

    return json.result as T;
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  async getUpdates(offset: number, timeout = 0): Promise<TelegramUpdate[]> {
    const res = await this.call<TelegramGetUpdatesResponse["result"]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
    return res as TelegramUpdate[];
  }

  async sendMessage(chatId: number, text: string, replyToMessageId?: number): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    };
    if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
    return this.call<TelegramMessage>("sendMessage", body);
  }

  async sendDocument(
    chatId: number,
    fileData: Uint8Array,
    filename: string,
    caption?: string,
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([fileData]), filename);
    if (caption) form.append("caption", caption);

    const res = await fetch(`${this.base}/sendDocument`, {
      method: "POST",
      body: form,
    });

    if (!res.ok) throw new Error(`sendDocument HTTP ${res.status}`);
    const json = (await res.json()) as TelegramSendMessageResponse;
    if (!json.ok) throw new Error(`sendDocument failed: ${json.description}`);
    return json.result!;
  }

  async sendPhoto(chatId: number, imageData: Uint8Array, filename: string, caption?: string): Promise<TelegramMessage> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([imageData], { type: "image/jpeg" }), filename);
    if (caption) form.append("caption", caption);

    const res = await fetch(`${this.base}/sendPhoto`, {
      method: "POST",
      body: form,
    });

    if (!res.ok) throw new Error(`sendPhoto HTTP ${res.status}`);
    const json = (await res.json()) as TelegramSendMessageResponse;
    if (!json.ok) throw new Error(`sendPhoto failed: ${json.description}`);
    return json.result!;
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    });
  }

  async sendChatAction(
    chatId: number,
    action: "typing" | "upload_document" | "upload_photo" = "typing",
  ): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action });
  }

  async sendReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
  }

  async getFile(fileId: string): Promise<{ file_path: string }> {
    return this.call<{ file_path: string }>("getFile", { file_id: fileId });
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const url = `${TELEGRAM_API_BASE}/file/bot${this.token}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async sendMessageWithKeyboard(
    chatId: number,
    text: string,
    keyboard: TelegramInlineKeyboardMarkup,
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined); // ignore if already deleted
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }
}
