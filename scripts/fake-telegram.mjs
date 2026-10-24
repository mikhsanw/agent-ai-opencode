// Minimal fake Telegram Bot API for end-to-end tests (TELEGRAM_API_ROOT=<url>).
// Records every call, serves scripted updates through getUpdates long polling, and returns
// plausible results for send/edit methods so the real bot runs unmodified.
import http from "node:http";

export async function startFakeTelegram({ userId, botId = 1000, username = "aao_test_bot" }) {
  const calls = [];
  const queue = [];
  let updateId = 1;
  let messageId = 100;
  const waiters = new Set();
  const listeners = new Set();

  const message = (chatId, text, extra = {}) => ({
    message_id: ++messageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private", first_name: "Tester" },
    from: { id: botId, is_bot: true, first_name: "AAO", username },
    ...(text !== undefined ? { text } : {}),
    ...extra,
  });

  const respond = (method, params) => {
    switch (method) {
      case "getMe":
        return { id: botId, is_bot: true, first_name: "AAO", username, can_join_groups: false };
      case "getWebhookInfo":
        return { url: "", has_custom_certificate: false, pending_update_count: 0 };
      case "getUpdates":
        return null; // handled asynchronously
      default:
        if (/^(send|edit|copy|forward)/.test(method) && method !== "sendChatAction" && method !== "editMessageReplyMarkup") {
          return message(Number(params.chat_id ?? userId), params.text ?? params.caption);
        }
        return true;
    }
  };

  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/bot[^/]+\/(\w+)/);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const method = match?.[1] ?? "unknown";
      let params = {};
      const type = req.headers["content-type"] ?? "";
      if (type.includes("json") && raw) {
        try {
          params = JSON.parse(raw);
        } catch {}
      } else if (type.includes("x-www-form-urlencoded")) {
        params = Object.fromEntries(new URLSearchParams(raw));
      }
      const send = (result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (method === "getUpdates") {
        const offset = Number(params.offset ?? 0);
        const take = () => queue.filter((u) => u.update_id >= offset);
        const ready = take();
        if (ready.length > 0) return send(ready);
        const timeoutMs = Math.min(Number(params.timeout ?? 0) * 1000, 1000);
        const timer = setTimeout(() => finish(), timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(finish);
          send(take());
        };
        waiters.add(finish);
        return;
      }
      const call = { method, params, at: Date.now() };
      calls.push(call);
      for (const listener of listeners) listener(call);
      send(respond(method, params));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const push = (update) => {
    queue.push({ update_id: updateId++, ...update });
    for (const wake of [...waiters]) wake();
  };
  const from = { id: userId, is_bot: false, first_name: "Tester", language_code: "id" };
  const chat = { id: userId, type: "private", first_name: "Tester" };

  return {
    url,
    calls,
    sendText(text) {
      const sentAt = Date.now();
      const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : undefined;
      push({ message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat, from, text, ...(entities ? { entities } : {}) } });
      return sentAt;
    },
    pressButton(data, onMessageId = 1) {
      const sentAt = Date.now();
      push({
        callback_query: {
          id: String(Date.now()) + Math.random(),
          from,
          chat_instance: "e2e",
          data,
          message: { message_id: onMessageId, date: Math.floor(Date.now() / 1000), chat, from: { id: botId, is_bot: true, first_name: "AAO" }, text: "card" },
        },
      });
      return sentAt;
    },
    /** Resolves with the first call made at/after `since` that matches the predicate. */
    waitFor(predicate, { since = Date.now(), timeoutMs = 20_000, label = "telegram call" } = {}) {
      const found = calls.find((c) => c.at >= since && predicate(c));
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs);
        const listener = (call) => {
          if (call.at >= since && predicate(call)) {
            clearTimeout(timer);
            listeners.delete(listener);
            resolve(call);
          }
        };
        listeners.add(listener);
      });
    },
    close() {
      for (const wake of [...waiters]) wake();
      server.close();
    },
  };
}
