// Independent Cloudflare Worker. Never put VK tokens in this file or the site.
const SITE = "https://maxfixglitch.github.io/ScrapMecanicNowosti/";
const FEED = SITE + "data/news.json";
const VERSION = "5.199";

export function plainText(html) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(html || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|h[1-6]|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, key) => {
      if (key[0] !== "#") return entities[key.toLowerCase()] ?? match;
      const n = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/[\t \u00a0]+/g, " ").replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function messageFor(item) {
  const title = plainText(item.title).slice(0, 300);
  const body = plainText(item.body);
  // Leave room for the title and link; very long patch notes stay on the site.
  const text = body.length > 10000 ? body.slice(0, 9950) + "…\n\nПолный текст — по ссылке ниже." : body;
  return `${title}\n\n${text}\n\nНовости Scrap Mechanic на русском:\n${SITE}#p-${item.gid}`;
}

export function validateFeed(data) {
  if (data?.appid !== 387990 || !Array.isArray(data.items) || !data.items.length) {
    throw new Error("Неверная или пустая лента; состояние не изменено.");
  }
  const ids = new Set();
  for (const item of data.items) {
    if (!/^\d+$/.test(String(item.gid)) || !Number.isFinite(Number(item.date)) ||
        Number(item.date) <= 0 || typeof item.title !== "string" || typeof item.body !== "string" || ids.has(String(item.gid))) {
      throw new Error("Некорректная запись в ленте; состояние не изменено.");
    }
    ids.add(String(item.gid));
  }
  return data.items;
}

async function feed(fetcher) {
  const response = await fetcher(FEED, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Сайт недоступен (HTTP ${response.status}).`);
  return validateFeed(await response.json());
}

async function vk(method, params, env, fetcher) {
  const response = await fetcher(`https://api.vk.com/method/${method}`, {
    method: "POST",
    body: new URLSearchParams({ ...params, access_token: env.VK_TOKEN, v: VERSION }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`ВК: HTTP ${response.status}.`);
  const data = await response.json();
  // Do NOT log the raw error: VK may echo the access_token in request_params.
  if (data.error) throw new Error(`ВК: код ошибки ${Number(data.error.error_code) || 0}. Проверьте права ключа и состояние группы.`);
  if (data.response === undefined) throw new Error("Неожиданный ответ ВК.");
  return data.response;
}

export class NewsPublisher {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }

  // All calls use ONE named Durable Object. A queue serializes async operations,
  // while durable 'pending' records survive restarts and ambiguous API failures.
  fetch(request) {
    const task = this.queue.then(() => this.handle(request));
    this.queue = task.catch(() => {});
    return task;
  }

  async handle(request) {
    const path = new URL(request.url).pathname;
    const storage = this.ctx.storage;
    if (path === "/status") {
      return Response.json({
        state: (await storage.get("meta")) || null,
        pending: (await storage.get("pending")) || null,
        lastRun: (await storage.get("lastRun")) || null,
      });
    }
    if (path === "/resolve") {
      const input = await request.json();
      const pending = await storage.get("pending");
      if (!pending || String(input.gid) !== pending.gid || !["published", "skip", "retry"].includes(input.action)) {
        return new Response("Укажите gid ожидающей записи и действие published, skip или retry.", { status: 400 });
      }
      if (input.action !== "retry") await storage.put("item:" + pending.gid, { status: input.action });
      await storage.delete("pending");
      return Response.json({ ok: true });
    }
    if (path !== "/run") return new Response("Not found", { status: 404 });
    try {
      const result = await this.run();
      await storage.put("lastRun", { at: new Date().toISOString(), ok: true, ...result });
      return Response.json(result);
    } catch (error) {
      // Only our own sanitized errors; never store a network exception with URLs.
      const message = /^(ВК:|Сайт недоступен|Неверная|Некорректная|Неожиданный|Укажите|Изменена|Есть)/.test(error.message)
        ? error.message : "Ошибка сети или хранилища. Проверьте /status перед повторной отправкой.";
      await storage.put("lastRun", { at: new Date().toISOString(), ok: false, error: message });
      return Response.json({ ok: false, error: message }, { status: 503 });
    }
  }

  async run(fetcher = fetch) {
    const env = this.env;
    const storage = this.ctx.storage;
    if (!env.VK_TOKEN || !/^[a-z\d_]+$/i.test(env.VK_GROUP || "")) {
      throw new Error("Укажите VK_TOKEN и VK_GROUP в настройках Worker.");
    }
    if (await storage.get("pending")) {
      throw new Error("Есть запись с неподтверждённым результатом. Проверьте стену и разрешите её через /resolve.");
    }
    const items = await feed(fetcher);
    let meta = await storage.get("meta");
    if (!meta) {
      const response = await vk("groups.getById", { group_ids: env.VK_GROUP }, env, fetcher);
      const group = (Array.isArray(response) ? response : response.groups)?.[0];
      if (!Number.isSafeInteger(group?.id) || group.id <= 0 ||
          group.screen_name?.toLowerCase() !== env.VK_GROUP.toLowerCase()) {
        throw new Error("Неожиданный ответ ВК: группа не подтверждена.");
      }
      meta = { group: env.VK_GROUP, groupId: group.id, initializedAt: new Date().toISOString(), cutoff: Math.max(...items.map(i => Number(i.date))) };
      // One transaction: partial initialization must never cause archive posting.
      await storage.transaction(async txn => {
        for (const item of items) await txn.put("item:" + item.gid, { status: "archive" });
        await txn.put("meta", meta);
      });
      return { initialized: true, archived: items.length, posted: 0 };
    }
    if (meta.group !== env.VK_GROUP) throw new Error("Изменена группа. Нужна отдельная установка бота, чтобы не потерять историю публикаций.");
    const candidates = items.filter(i => Number(i.date) > meta.cutoff)
      .sort((a, b) => Number(a.date) - Number(b.date));
    let posted = 0;
    for (const item of candidates) {
      if (await storage.get("item:" + item.gid)) continue;
      // Wait for Russian translation instead of publishing an English fallback.
      if (item.translated !== true || !/[а-яё]/i.test(item.title)) continue;
      const gid = String(item.gid);
      // Persist BEFORE the external side effect. An unknown result pauses posting
      // rather than retrying blindly after VK's short guid deduplication window.
      await storage.put("pending", { gid, title: item.title, since: new Date().toISOString() });
      const result = await vk("wall.post", {
        owner_id: String(-meta.groupId), from_group: "1",
        message: messageFor(item), guid: `sm-${gid}`,
      }, env, fetcher);
      if (!Number.isSafeInteger(result?.post_id) || result.post_id <= 0) throw new Error("Неожиданный ответ ВК: нет номера публикации.");
      await storage.transaction(async txn => {
        await txn.put("item:" + gid, { status: "published", postId: result.post_id });
        await txn.delete("pending");
      });
      posted++;
      if (posted === 3) break; // Don't flood the wall after a prolonged outage.
    }
    return { posted };
  }
}

export default {
  async scheduled(_event, env) {
    const stub = env.PUBLISHER.get(env.PUBLISHER.idFromName("scrapmehi-v1"));
    const response = await stub.fetch(new Request("https://internal/run", { method: "POST" }));
    if (!response.ok) throw new Error("Автопубликация остановлена. Проверьте защищённый /status.");
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/" && request.method === "GET") return new Response("Scrap Mechanic → ВК. Служебный адрес бота.");
    if (!["/status", "/run", "/resolve"].includes(path)) return new Response("Not found", { status: 404 });
    if (!env.ADMIN_SECRET || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.method !== (path === "/status" ? "GET" : "POST")) return new Response("Method not allowed", { status: 405 });
    const stub = env.PUBLISHER.get(env.PUBLISHER.idFromName("scrapmehi-v1"));
    return stub.fetch(request);
  },
};
