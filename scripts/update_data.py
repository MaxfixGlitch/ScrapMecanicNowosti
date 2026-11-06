#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборщик данных для сайта новостей Scrap Mechanic.

Что делает:
  1. Забирает официальные новости игры из Steam Web API (ISteamNews).
  2. Переводит заголовки и тексты на русский
     (приоритет: ручные переводы из data/translations.json -> авто-перевод -> оригинал).
  3. Забирает карточку игры (название, описание, обои, скриншоты, жанры)
     из Steam Store API c локализацией l=russian.
  4. Забирает текущий онлайн игры.
  5. Пишет data/news.json и data/game.json.

Никогда не падает: если сеть недоступна, существующие данные сохраняются.
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

APPID = int(os.environ.get("SM_APPID", "387990"))
TRANSLATE_LIMIT = int(os.environ.get("SM_TRANSLATE_LIMIT", "12"))  # новых постов за прогон
MAX_ITEMS = int(os.environ.get("SM_MAX_ITEMS", "400"))
DEBUG = os.environ.get("SM_DEBUG") == "1"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
NEWS_PATH = os.path.join(DATA_DIR, "news.json")
GAME_PATH = os.path.join(DATA_DIR, "game.json")
TRANSLATIONS_PATH = os.path.join(DATA_DIR, "translations.json")

UA = "Mozilla/5.0 (compatible; ScrapMecanicNowosti/1.0; +https://github.com)"
CLAN_IMAGE_BASE = "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/clans/"

FEED_LABELS_RU = {
    "steam community announcements": "Объявления сообщества",
    "steam community announcements ": "Объявления сообщества",
    "product update": "Обновление игры",
    "product updates": "Обновление игры",
    "news": "Новости",
    "patch notes": "Список изменений",
}

TAG_RULES = [
    (("hotfix", "patch", "update", "обновлен", "обновление"), "Обновление"),
    (("dev blog", "blog", "дневник", "блог"), "Дневник разработчиков"),
    (("sale", "скидк", "free weekend", "бесплатные выходные"), "Скидки"),
    (("event", "contest", "конкурс", "событ", "ивен"), "Событие"),
    (("survey", "опрос"), "Опрос"),
]


def log(*a):
    print("[update_data]", *a, flush=True)


# --------------------------------------------------------------------------- http


def http_get(url, timeout=40, retries=3, data=None):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as exc:  # noqa: BLE001 - сеть в CI может капризничать
            last = exc
            if DEBUG:
                log("HTTP fail", attempt + 1, url[:120], exc)
            time.sleep(2 + attempt * 3)
    raise last


def get_json(url, **kw):
    return json.loads(http_get(url, **kw).decode("utf-8", "replace"))


# ------------------------------------------------------------------- bbcode -> html


def preprocess_bbcode(text: str) -> str:
    """Steam иногда отдаёт новости в bbcode-подобном виде. Приводим к HTML."""
    if "{STEAM_CLAN_IMAGE}" not in text and "[/" not in text:
        return text

    text = text.replace("{STEAM_CLAN_IMAGE}", CLAN_IMAGE_BASE)
    text = re.sub(r"\[img\](.*?)\[/img\]", r'<img src="\1" />', text, flags=re.I | re.S)
    text = re.sub(r"\[url=(.*?)\](.*?)\[/url\]", r'<a href="\1">\2</a>', text, flags=re.I | re.S)
    text = re.sub(r"\[url\](.*?)\[/url\]", r'<a href="\1">\1</a>', text, flags=re.I | re.S)
    for tag in ("b", "i", "u", "s", "h1", "h2", "h3", "quote"):
        text = re.sub(r"\[%s\](.*?)\[/%s\]" % (tag, tag), r"<%s>\1</%s>" % (tag, tag), text, flags=re.I | re.S)
    text = re.sub(r"\[list\]", "<ul>", text, flags=re.I)
    text = re.sub(r"\[/list\]", "</ul>", text, flags=re.I)
    text = re.sub(r"\[\*\]\s*", "<li>", text, flags=re.I)
    text = text.replace("\n", "<br />")
    return text


# ------------------------------------------------------------------- html sanitizer

ALLOWED_TAGS = {
    "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "strike", "del",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "blockquote", "a", "img",
    "div", "span", "table", "thead", "tbody", "tr", "td", "th", "pre", "code",
    "center", "small", "sup", "sub",
}
VOID_TAGS = {"br", "hr", "img"}
ALLOWED_ATTRS = {
    "a": {"href", "title"},
    "img": {"src", "alt", "title", "width", "height"},
}


class Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.nodes = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag not in ALLOWED_TAGS:
            return
        d = {}
        for k, v in attrs:
            k = k.lower()
            if k in ALLOWED_ATTRS.get(tag, set()):
                d[k] = (v or "").strip()
        if tag == "a":
            d["target"] = "_blank"
            d["rel"] = "noopener noreferrer"
            d["href"] = _force_https(d.get("href", ""))
        if tag == "img":
            d["src"] = _force_https(d.get("src", ""))
            d["loading"] = "lazy"
            d.setdefault("alt", "")
        if tag in VOID_TAGS:
            self.nodes.append({"type": "void", "tag": tag, "attrs": d})
        else:
            self.nodes.append({"type": "start", "tag": tag, "attrs": d})
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        before = len(self.nodes)
        self.handle_starttag(tag, attrs)
        tag = tag.lower()
        if tag not in VOID_TAGS and len(self.nodes) > before:
            if self.stack and self.stack[-1] == tag:
                self.stack.pop()
                self.nodes.append({"type": "end", "tag": tag})

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.stack:
            while self.stack:
                t = self.stack.pop()
                self.nodes.append({"type": "end", "tag": t})
                if t == tag:
                    break

    def handle_data(self, data):
        if data:
            self.nodes.append({"type": "text", "text": data})

    def result(self):
        self.close()
        while self.stack:
            self.nodes.append({"type": "end", "tag": self.stack.pop()})
        return self.nodes


def _force_https(url: str) -> str:
    url = (url or "").strip()
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("http://"):
        return "https://" + url[len("http://"):]
    return url


def serialize(nodes):
    parts = []
    for n in nodes:
        if n["type"] == "text":
            parts.append(html.escape(n["text"], quote=False))
        elif n["type"] in ("start", "void"):
            attrs = "".join(
                ' %s="%s"' % (k, html.escape(str(v), quote=True))
                for k, v in n["attrs"].items()
                if v not in (None, "")
            )
            tail = " /" if n["type"] == "void" else ""
            parts.append("<%s%s%s>" % (n["tag"], attrs, tail))
        elif n["type"] == "end":
            parts.append("</%s>" % n["tag"])
    return "".join(parts)


def sanitize_html(raw: str) -> list:
    p = Sanitizer()
    p.feed(preprocess_bbcode(raw or ""))
    return p.result()


def html_text_preview(nodes, limit=260):
    buf = []

    def walk(ns):
        for n in ns:
            if n["type"] == "text":
                buf.append(n["text"])
    walk(nodes)
    text = re.sub(r"\s+", " ", "".join(buf)).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


# -------------------------------------------------------------------- translators


def _google_translate(text: str) -> str:
    url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t"
    body = urllib.parse.urlencode({"q": text}).encode("utf-8")
    raw = http_get(url, retries=2, data=body)
    data = json.loads(raw.decode("utf-8", "replace"))
    return "".join(seg[0] for seg in data[0] if seg and seg[0])


def _mymemory_translate(text: str) -> str:
    url = "https://api.mymemory.translated.net/get?" + urllib.parse.urlencode(
        {"q": text, "langpair": "en|ru"}
    )
    data = get_json(url, retries=2)
    out = (data.get("responseData") or {}).get("translatedText") or ""
    if "MYMEMORY WARNING" in out.upper():
        raise ValueError("mymemory quota")
    return out


def _lingva_translate(text: str) -> str:
    for host in ("lingva.ml", "lingva.pussthecat.org", "lingva.garudalinux.org"):
        try:
            url = "https://%s/api/v1/en/ru/%s" % (host, urllib.parse.quote(text, safe=""))
            data = get_json(url, retries=1, timeout=25)
            if data.get("translation"):
                return data["translation"]
        except Exception:  # noqa: BLE001
            continue
    raise ValueError("lingva unavailable")


PROVIDERS = [
    ("google", _google_translate, 1400),
    ("lingva", _lingva_translate, 900),
    ("mymemory", _mymemory_translate, 480),
]


def translate_block(text: str):
    """Переводит один блок текста. Возвращает (результат, провайдер) или (None, None)."""
    text = text.strip()
    if not text or len(text) < 2:
        return text, "none"
    for name, fn, max_len in PROVIDERS:
        if len(text) > max_len:
            continue
        try:
            out = fn(text)
        except Exception as exc:  # noqa: BLE001
            if DEBUG:
                log("provider %s failed: %s" % (name, exc))
            continue
        if out and out.strip() and out.strip() != text:
            return out.strip(), name
    return None, None


def translate_many(pieces):
    """Переводит список строк, сохраняя порядок и количество. None для неудачных."""
    result = [None] * len(pieces)
    # Склеиваем короткие куски, чтобы уменьшить число запросов.
    groups, cur, cur_len = [], [], 0
    for i, piece in enumerate(pieces):
        text = re.sub(r"\s+", " ", (piece or "").strip())
        if not text:
            result[i] = ""
            continue
        if cur_len + len(text) > 1000:
            groups.append(cur)
            cur, cur_len = [], 0
        cur.append((i, text))
        cur_len += len(text) + 1
    if cur:
        groups.append(cur)

    for group in groups:
        joined = "\n".join(t for _, t in group)
        out, _ = translate_block(joined)
        if out is None:
            # Пробуем перевести каждый кусок по отдельности.
            for i, text in group:
                one, _ = translate_block(text)
                result[i] = one
            continue
        lines = out.split("\n")
        if len(lines) == len(group):
            for (i, _), line in zip(group, lines):
                result[i] = line.strip()
        else:
            for i, text in group:
                one, _ = translate_block(text)
                result[i] = one
        time.sleep(0.15)
    return result


# --------------------------------------------------------------------------- data


def load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:  # noqa: BLE001
        log("cannot read", path, exc)
        return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def classify(title: str) -> str:
    low = (title or "").lower()
    for keys, label in TAG_RULES:
        for k in keys:
            if k in low:
                return label
    return "Новость"


def fetch_news():
    url = (
        "https://api.steampowered.com/ISteamNews/GetNewsForApp/v0002/"
        "?appid=%d&count=60&format=json" % APPID
    )
    data = get_json(url)
    items = (data.get("appnews") or {}).get("newsitems") or []
    log("получено новостей из Steam:", len(items))
    return items


def fetch_game():
    url = "https://store.steampowered.com/api/appdetails?appids=%d&l=russian&cc=ru" % APPID
    data = get_json(url)
    block = data.get(str(APPID)) or {}
    if not block.get("success"):
        raise ValueError("appdetails: success=false")
    return block["data"]


def fetch_players():
    url = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=%d" % APPID
    try:
        return get_json(url, retries=2).get("response", {}).get("player_count")
    except Exception:  # noqa: BLE001
        return None


def build_items(raw_items, old_by_gid, manual_translations):
    items = []
    translated_now = 0
    for raw in raw_items:
        gid = str(raw.get("gid") or "").strip()
        if not gid:
            continue
        ts = int(raw.get("date") or 0)
        nodes_en = sanitize_html(raw.get("contents") or "")
        body_en = serialize(nodes_en)
        title_en = re.sub(r"\s+", " ", (raw.get("title") or "").strip())
        feed = (raw.get("feedlabel") or "").strip()
        feed_ru = FEED_LABELS_RU.get(feed.lower(), feed or "Новости")

        item = {
            "gid": gid,
            "title": title_en,
            "title_en": title_en,
            "body": body_en,
            "body_en": body_en,
            "preview": html_text_preview(nodes_en),
            "date": ts,
            "url": raw.get("url") or "",
            "author": (raw.get("author") or "").strip(),
            "feedlabel": feed,
            "feedlabel_ru": feed_ru,
            "tags": [classify(title_en)],
            "translated": False,
            "source": "steam",
        }

        manual = manual_translations.get(gid)
        if manual and manual.get("title") and manual.get("body"):
            item["title"] = manual["title"]
            item["body"] = manual["body"]
            item["preview"] = manual.get("preview") or strip_tags_preview(manual["body"])
            item["translated"] = True
            item["translation"] = "manual"
        else:
            old = old_by_gid.get(gid)
            if old and old.get("translated") and old.get("body") and old.get("body_en") == body_en:
                item["title"] = old["title"]
                item["body"] = old["body"]
                item["preview"] = old.get("preview") or strip_tags_preview(old["body"])
                item["translated"] = True
                item["translation"] = old.get("translation", "auto")
            elif translated_now < TRANSLATE_LIMIT:
                translated_now += 1
                nodes = sanitize_html(raw.get("contents") or "")
                texts = [
                    n["text"]
                    for n in nodes
                    if n["type"] == "text" and n["text"].strip()
                ]
                title_ru, _ = translate_block(title_en)
                body_ru_parts = translate_many(texts)
                if title_ru or any(body_ru_parts):
                    idx = 0
                    for n in nodes:
                        if n["type"] == "text" and n["text"].strip():
                            tr = body_ru_parts[idx] if idx < len(body_ru_parts) else None
                            if tr:
                                n["text"] = tr
                            idx += 1
                    item["title"] = title_ru or title_en
                    item["body"] = serialize(nodes)
                    item["preview"] = html_text_preview(nodes)
                    item["translated"] = bool(title_ru)
                    item["translation"] = "auto"
                log("переведён пост", gid, "->", item["translated"])
        items.append(item)

    # Старые записи, которых уже нет в выдаче Steam, остаются в архиве.
    fresh = {i["gid"] for i in items}
    for gid, old in old_by_gid.items():
        if gid not in fresh:
            items.append(old)

    items.sort(key=lambda i: i.get("date") or 0, reverse=True)
    return items[:MAX_ITEMS]


def strip_tags_preview(body_html, limit=260):
    text = re.sub(r"<[^>]+>", " ", body_html or "")
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    old_news = load_json(NEWS_PATH, {})
    old_by_gid = {i["gid"]: i for i in old_news.get("items", []) if i.get("gid")}
    manual = load_json(TRANSLATIONS_PATH, {}).get("items", {})

    # ---------------------------------------------------------------- новости
    try:
        items = build_items(fetch_news(), old_by_gid, manual)
        save_json(
            NEWS_PATH,
            {
                "appid": APPID,
                "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "count": len(items),
                "items": items,
            },
        )
        log("news.json обновлён, записей:", len(items))
    except Exception as exc:  # noqa: BLE001
        log("ОШИБКА новостей (оставляю старые данные):", exc)

    # ------------------------------------------------------------------- игра
    try:
        g = fetch_game()
        players = fetch_players()
        movies = [
            {"id": m.get("id"), "name": m.get("name"), "thumb": m.get("thumbnail")}
            for m in (g.get("movies") or [])[:6]
        ]
        shots = [s.get("path_full") for s in (g.get("screenshots") or [])[:8]]
        game = {
            "appid": APPID,
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "name": g.get("name"),
            "short_description": g.get("short_description"),
            "about": g.get("about_the_game"),
            "detailed_description": g.get("detailed_description"),
            "header_image": g.get("header_image"),
            "capsule_image": g.get("capsule_imagev5") or g.get("capsule_image"),
            "background": g.get("background"),
            "developers": g.get("developers") or [],
            "publishers": g.get("publishers") or [],
            "release_date": (g.get("release_date") or {}).get("date"),
            "genres": [x.get("description") for x in (g.get("genres") or [])],
            "categories": [x.get("description") for x in (g.get("categories") or [])[:12]],
            "price": (g.get("price_overview") or {}).get("final_formatted"),
            "is_free": g.get("is_free"),
            "recommendations": (g.get("recommendations") or {}).get("total"),
            "metacritic": (g.get("metacritic") or {}).get("score"),
            "screenshots": shots,
            "movies": movies,
            "players_now": players,
            "website": g.get("website"),
            "supported_languages": g.get("supported_languages"),
            "platforms": g.get("platforms") or {},
        }
        save_json(GAME_PATH, game)
        log("game.json обновлён:", game.get("name"), "| онлайн:", players)
    except Exception as exc:  # noqa: BLE001
        log("ОШИБКА данных об игре (оставляю старые):", exc)

    return 0


if __name__ == "__main__":
    sys.exit(main())
