/* ==========================================================================
   Scrap News — логика новостной ленты
   ========================================================================== */
(function () {
  "use strict";

  var APPID = 387990;
  var STEAM_NEWS_API =
    "https://api.steampowered.com/ISteamNews/GetNewsForApp/v0002/?appid=" +
    APPID + "&count=25&format=json";

  var PAGE = 10;

  var state = {
    items: [],
    filter: "Все",
    query: "",
    shown: PAGE,
    game: null,
    loaded: false
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------- helpers -- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " → " + r.status);
      return r.json();
    });
  }

  function fmtDate(ts) {
    if (!ts) return "";
    return new Date(ts * 1000).toLocaleDateString("ru-RU", {
      day: "numeric", month: "long", year: "numeric"
    });
  }

  function fmtShort(ts) {
    if (!ts) return "";
    return new Date(ts * 1000).toLocaleDateString("ru-RU", {
      day: "numeric", month: "short", year: "2-digit"
    });
  }

  function daysAgo(ts) {
    return (Date.now() / 1000 - ts) / 86400;
  }

  var FEED_LABELS = {
    "steam community announcements": "Объявления сообщества",
    "product update": "Обновление игры",
    "patch notes": "Список изменений"
  };

  function feedRu(label) {
    if (!label) return "Новости";
    return FEED_LABELS[String(label).toLowerCase()] || label;
  }

  function tagClass(tag) {
    if (tag === "Скидки") return "pill green";
    if (tag === "Событие") return "pill warn";
    return "pill";
  }

  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "toast"; }, 4200);
  }

  /* --------------------------------------------- очистка HTML от Steam ---- */

  var ALLOWED = {
    P: 1, BR: 1, HR: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1,
    UL: 1, OL: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, BLOCKQUOTE: 1,
    A: 1, IMG: 1, DIV: 1, SPAN: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1,
    PRE: 1, CODE: 1, CENTER: 1, SMALL: 1, SUP: 1, SUB: 1
  };

  function preprocessBB(text) {
    if (text.indexOf("[") === -1) return text;
    var base = "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/clans/";
    text = text.split("{STEAM_CLAN_IMAGE}/").join(base).split("{STEAM_CLAN_IMAGE}").join(base);
    text = text.replace(/\[img\s+src=(["'])(.*?)\1\s*\/?\]/gi, '<img src="$2" />');
    text = text.replace(/\[img\s+src=([^\]\s]+)\s*\/?\]/gi, '<img src="$1" />');
    text = text.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, '<img src="$1" />');
    text = text.replace(/\[url=(["']?)(.*?)\1\]([\s\S]*?)\[\/url\]/gi, '<a href="$2">$3</a>');
    text = text.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '<a href="$1">$1</a>');
    text = text.replace(/\[previewyoutube=([^;\]]+)[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi,
      '<a href="https://www.youtube.com/watch?v=$1">Смотреть видео на YouTube</a>');
    text = text.replace(/\[\/olist\]/gi, "</ol>").replace(/\[olist\]/gi, "<ol>");
    text = text.replace(/\[\/list\]/gi, "</ul>").replace(/\[list\]/gi, "<ul>");
    text = text.replace(/\[\/\*\]/gi, "</li>").replace(/\[\*\]/gi, "<li>");
    ["b", "i", "u", "s", "h1", "h2", "h3", "h4", "p", "center", "c", "quote", "spoiler",
     "table", "tr", "td", "th"].forEach(function (bb) {
      var tag = { c: "code", quote: "blockquote", spoiler: "blockquote" }[bb] || bb;
      text = text.replace(new RegExp("\\[" + bb + "\\]([\\s\\S]*?)\\[\\/" + bb + "\\]", "gi"),
        "<" + tag + ">$1</" + tag + ">");
    });
    text = text.replace(/\[hr\]/gi, "<hr />");
    return text.replace(/\[\/[a-z0-9]+\]/gi, "");
  }

  function sanitize(htmlText) {
    var doc = new DOMParser().parseFromString(
      "<body><div id=\"r\">" + preprocessBB(htmlText || "") + "</div></body>", "text/html");
    var host = doc.getElementById("r");

    (function walk(node) {
      var child, next, i;
      for (child = node.firstChild; child; child = next) {
        next = child.nextSibling;
        if (child.nodeType === 1) {
          if (!ALLOWED[child.tagName]) {
            walk(child);
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            node.removeChild(child);
            continue;
          }
          for (i = child.attributes.length - 1; i >= 0; i--) {
            var a = child.attributes[i];
            var keep = (child.tagName === "A" && (a.name === "href" || a.name === "title")) ||
                       (child.tagName === "IMG" && (a.name === "src" || a.name === "alt"));
            if (!keep) child.removeAttribute(a.name);
          }
          if (child.tagName === "A") {
            var href = child.getAttribute("href") || "";
            if (href.indexOf("http://") === 0) href = "https://" + href.slice(7);
            if (!href) {
              var txt = (child.textContent || "").trim();
              if (/^https?:\/\/\S+$/.test(txt)) href = txt;
            }
            if (href) {
              child.setAttribute("href", href);
              child.setAttribute("target", "_blank");
              child.setAttribute("rel", "noopener noreferrer");
            } else {
              while (child.firstChild) node.insertBefore(child.firstChild, child);
              node.removeChild(child);
              continue;
            }
          }
          if (child.tagName === "IMG") {
            var src = child.getAttribute("src") || "";
            if (src.indexOf("//") === 0) src = "https:" + src;
            else if (src.indexOf("http://") === 0) src = "https://" + src.slice(7);
            if (!src) { node.removeChild(child); continue; }
            child.setAttribute("src", src);
            child.setAttribute("loading", "lazy");
          }
          walk(child);
        } else if (child.nodeType !== 3) {
          node.removeChild(child);
        }
      }
    })(host);

    return host.innerHTML;
  }

  /* ---------------------------------------------------------- классификация */

  function classify(title) {
    var t = String(title || "").toLowerCase();
    if (/hotfix|patch|update|обновлен/.test(t)) return "Обновление";
    if (/devblog|dev blog|дневник|блог/.test(t)) return "Дневник разработчиков";
    if (/sale|скидк|free weekend|бесплатные выходные/.test(t)) return "Скидки";
    if (/event|contest|конкурс|событ|ивен/.test(t)) return "Событие";
    if (/опрос|survey/.test(t)) return "Опрос";
    return "Новость";
  }

  /* --------------------------------------------------------------- шапка --- */

  function renderHero(g) {
    if (!g) return;
    var bg = g.background || g.header_image;
    if (bg) $("hero").style.setProperty("--hero", "url(" + bg + ")");

    var cover = g.header_image || g.capsule_image;
    var coverEl = $("heroCover");
    if (cover) { coverEl.src = cover; coverEl.hidden = false; coverEl.alt = g.name || ""; }

    $("heroTitle").textContent = g.name || "Scrap Mechanic";
    $("crumbGame").textContent = g.name || "Scrap Mechanic";
    $("heroSub").textContent = g.short_description || "";

    var meta = [];
    if (g.release_date) meta.push('<span class="pill">Выпущено: ' + esc(g.release_date) + "</span>");
    (g.genres || []).slice(0, 4).forEach(function (x) { meta.push('<span class="pill">' + esc(x) + "</span>"); });
    if (g.price) meta.push('<span class="pill green">' + esc(g.price) + "</span>");
    else if (g.is_free) meta.push('<span class="pill green">Бесплатно</span>');
    if (state.items.length) {
      meta.push('<span class="pill">Последняя новость: ' + esc(fmtShort(state.items[0].date)) + "</span>");
    }
    $("heroMeta").innerHTML = meta.join("");

    document.title = (g.name || "Scrap Mechanic") + " — новости, обновления и патчи";

    // Сайдбар: об игре
    if (cover) { $("sideCover").src = cover; $("sideCover").hidden = false; $("sideCover").alt = g.name || ""; }
    $("sideDesc").textContent = g.short_description || "";

    var rows = [
      ["Разработчик", (g.developers || []).join(", ")],
      ["Издатель", (g.publishers || []).join(", ")],
      ["Дата выхода", g.release_date],
      ["Жанры", (g.genres || []).join(", ")],
      ["Рекомендации", g.recommendations ? g.recommendations.toLocaleString("ru-RU") + " отзывов" : null],
      ["Метакритика", g.metacritic],
      ["Цена", g.is_free ? "Бесплатно" : g.price]
    ];
    var html = "";
    rows.forEach(function (r) {
      if (r[1]) html += '<div class="row"><span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + "</span></div>";
    });
    $("gameKv").innerHTML = html;

    if (g.players_now) {
      $("onlineBox").hidden = false;
      $("onlineNum").textContent = g.players_now.toLocaleString("ru-RU");
    }

    if ((g.screenshots || []).length) {
      $("screens").hidden = false;
      $("screensBox").innerHTML = g.screenshots.map(function (s) {
        return '<a href="' + esc(s) + '" target="_blank" rel="noopener">' +
               '<img src="' + esc(s) + '" alt="" loading="lazy" style="width:100%;border-radius:2px;display:block"></a>';
      }).join("");
    }
  }

  /* -------------------------------------------------------------- рубрики -- */

  function renderTags() {
    var counts = {};
    state.items.forEach(function (i) {
      (i.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (!keys.length) { $("tagCloud").innerHTML = '<span style="color:#67707b">Пока нет рубрик</span>'; return; }

    var pills = ['<button class="tab' + (state.filter === "Все" ? " active" : "") + '" data-tag="Все">Все рубрики</button>'];
    keys.forEach(function (k) {
      pills.push('<button class="tab' + (state.filter === k ? " active" : "") +
        '" data-tag="' + esc(k) + '">' + esc(k) + '<span class="n">' + counts[k] + "</span></button>");
    });
    $("tagCloud").innerHTML = pills.join("");
  }

  function renderTabs() {
    var counts = { "Все": state.items.length };
    state.items.forEach(function (i) {
      (i.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var order = ["Все", "Обновление", "Дневник разработчиков", "Событие", "Скидки", "Новость", "Опрос"];
    var html = "";
    order.forEach(function (t) {
      if (!counts[t]) return;
      html += '<button class="tab' + (state.filter === t ? " active" : "") + '" data-tag="' + esc(t) + '">' +
              esc(t) + '<span class="n">' + counts[t] + "</span></button>";
    });
    $("tabs").innerHTML = html;
  }

  function renderRecent() {
    var list = state.items.slice(0, 7);
    $("recent").innerHTML = list.map(function (i) {
      return '<li><a href="#p-' + esc(i.gid) + '">' + esc(i.title) +
             '<span class="d">' + esc(fmtShort(i.date)) + " · " + esc((i.tags || [])[0] || "") + "</span></a></li>";
    }).join("") || '<li><a href="#">Новостей пока нет</a></li>';
  }

  /* ---------------------------------------------------------------- лента - */

  function visibleItems() {
    var q = state.query.trim().toLowerCase();
    return state.items.filter(function (i) {
      if (state.filter !== "Все" && (i.tags || []).indexOf(state.filter) === -1) return false;
      if (!q) return true;
      var hay = (i.title + " " + (i.title_en || "") + " " + strip(i.body) + " " + (i.author || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function strip(htmlText) {
    var d = document.createElement("div");
    d.innerHTML = htmlText || "";
    return d.textContent || "";
  }

  function postHTML(i) {
    var tags = (i.tags || []).map(function (t) {
      return '<span class="' + tagClass(t) + '">' + esc(t) + "</span>";
    }).join("");

    var flag = "";
    if (i.isFresh) flag = '<span class="pill green">Только что из Steam</span>';
    else if (daysAgo(i.date) < 5) flag = '<span class="pill green">Новое</span>';
    if (!i.translated) {
      flag += '<span class="pill warn" title="Автоперевод ещё не выполнен">Оригинал на английском</span>';
    }

    var meta = [esc(fmtDate(i.date))];
    if (i.author) meta.push('<span class="author">' + esc(i.author) + "</span>");
    meta.push(esc(feedRu(i.feedlabel_ru || i.feedlabel)));

    return '' +
      '<article class="post' + (i.isFresh ? " is-new" : "") + '" id="p-' + esc(i.gid) + '">' +
        '<div class="post_head">' +
          (tags || flag ? '<div class="post_tags">' + tags + flag + "</div>" : "") +
          '<h2 class="post_title"><a href="#p-' + esc(i.gid) + '">' + esc(i.title) + "</a></h2>" +
          '<div class="post_meta">' + meta.join(' <span class="dot">·</span> ') + "</div>" +
        "</div>" +
        '<div class="post_body collapsed">' + (i.body || "") + "</div>" +
        '<div class="post_footer">' +
          '<button class="btn_more" type="button">Читать далее</button>' +
          '<span class="spacer"></span>' +
          (i.url ? '<a class="linkish" href="' + esc(i.url) + '" target="_blank" rel="noopener">Открыть на Steam ↗</a>' : "") +
        "</div>" +
      "</article>";
  }

  function measure(post) {
    var body = post.querySelector(".post_body");
    var btn = post.querySelector(".btn_more");
    if (!body || !btn) return;
    // Почти все новости Steam содержат картинки, а они подгружаются лениво —
    // поэтому считаем такой пост «длинным» заранее, до загрузки изображений.
    var tall = body.scrollHeight > 560 || body.querySelectorAll("img").length > 0;
    body.classList.toggle("collapsed", tall && !post.dataset.open);
    btn.style.display = tall ? "" : "none";
    btn.textContent = (post.dataset.open || !tall) ? "Свернуть" : "Читать далее";
  }

  function renderFeed() {
    var list = visibleItems();
    var feed = $("feed");

    if (!list.length) {
      feed.innerHTML = '<div class="empty"><strong>Ничего не найдено</strong>' +
        "Попробуйте изменить запрос или выбрать другую рубрику.</div>";
      return;
    }

    var page = list.slice(0, state.shown);
    var more = list.length - page.length;

    feed.innerHTML = page.map(postHTML).join("") +
      (more > 0
        ? '<button class="btn btn_blue" id="moreBtn" type="button" style="align-self:center;width:240px">' +
          "Показать ещё " + more + "</button>"
        : "");

    var moreBtn = $("moreBtn");
    if (moreBtn) {
      moreBtn.addEventListener("click", function () {
        state.shown += PAGE;
        renderFeed();
      });
    }

    Array.prototype.forEach.call(feed.querySelectorAll(".post"), function (post) {
      measure(post);
      Array.prototype.forEach.call(post.querySelectorAll("img"), function (img) {
        if (img.complete) { measure(post); return; }
        img.addEventListener("load", function () { measure(post); });
        img.addEventListener("error", function () { measure(post); });
      });
      post.querySelector(".btn_more").addEventListener("click", function () {
        var body = post.querySelector(".post_body");
        var open = body.classList.contains("collapsed");
        if (open) {
          body.classList.remove("collapsed");
          post.dataset.open = "1";
        } else {
          body.classList.add("collapsed");
          delete post.dataset.open;
          post.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        this.textContent = open ? "Свернуть" : "Читать далее";
      });
    });
  }

  function renderAll() {
    renderTabs();
    renderTags();
    renderRecent();
    renderFeed();
    renderHero(state.game);
  }

  /* --------------------------------------------------------- «свежее» ----- */

  function normalizeRaw(raw) {
    var body = sanitize(raw.contents || "");
    var title = String(raw.title || "").replace(/\s+/g, " ").trim();
    return {
      gid: String(raw.gid),
      title: title,
      title_en: title,
      body: body,
      body_en: body,
      preview: strip(body).slice(0, 260),
      date: Number(raw.date) || 0,
      url: raw.url || "",
      author: raw.author || "",
      feedlabel: raw.feedlabel || "",
      feedlabel_ru: feedRu(raw.feedlabel),
      tags: [classify(title)],
      translated: false,
      isFresh: true,
      source: "steam-live"
    };
  }

  function tryFetch(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function refreshLive() {
    var btn = $("refreshBtn");
    btn.disabled = true;
    btn.textContent = "Загружаю…";
    toast("Запрашиваю свежие новости из Steam…");

    var enc = encodeURIComponent(STEAM_NEWS_API);
    var sources = [
      STEAM_NEWS_API,
      "https://api.allorigins.win/raw?url=" + enc,
      "https://api.codetabs.com/v1/proxy?quest=" + enc
    ];

    var attempt = function (n) {
      if (n >= sources.length) {
        btn.disabled = false;
        btn.textContent = "Обновить ленту";
        toast("Не удалось подключиться к Steam — показаны сохранённые новости.", true);
        return;
      }
      tryFetch(sources[n]).then(function (data) {
        var items = ((data.appnews || {}).newsitems) || [];
        var known = {};
        state.items.forEach(function (i) { known[i.gid] = 1; });
        var added = [];
        items.forEach(function (raw) {
          var it = normalizeRaw(raw);
          if (!known[it.gid]) added.push(it);
        });
        if (added.length) {
          state.items = added.concat(state.items).sort(function (a, b) { return b.date - a.date; });
          renderAll();
          toast("Добавлено новых записей из Steam: " + added.length);
        } else {
          toast("Свежих новостей нет — лента уже актуальна.");
        }
        btn.disabled = false;
        btn.textContent = "Обновить ленту";
      }).catch(function () { attempt(n + 1); });
    };
    attempt(0);
  }

  /* ------------------------------------------------------------- запуск --- */

  function boot() {
    var newsP = getJSON("data/news.json").catch(function () { return { items: [] }; });
    var gameP = getJSON("data/game.json").catch(function () { return null; });
    var manualP = getJSON("data/manual-news.json").catch(function () { return { items: [] }; });

    Promise.all([newsP, gameP, manualP]).then(function (res) {
      var news = res[0], game = res[1], manual = res[2];

      var items = (news.items || []).concat(manual.items || []);
      items.forEach(function (i) {
        if (!i.gid) i.gid = "m" + (i.date || 0) + Math.random().toString(36).slice(2, 7);
        if (!i.tags || !i.tags.length) i.tags = [classify(i.title)];
      });
      items.sort(function (a, b) { return (b.date || 0) - (a.date || 0); });

      state.items = items;
      state.game = game;
      state.loaded = true;

      if (news.updated_at) {
        $("updatedAt").textContent = "Данные обновлены: " +
          new Date(news.updated_at).toLocaleString("ru-RU") +
          " · обновляются автоматически каждые 6 часов · записей в архиве: " + items.length;
      }

      renderAll();

      if (!items.length) {
        $("feed").innerHTML = '<div class="empty"><strong>Новостей пока нет</strong>' +
          "Данные загружаются автоматически. Нажмите «Обновить ленту», чтобы запросить их прямо сейчас.</div>";
      }

      openFromHash();
    }).catch(function (e) {
      $("feed").innerHTML = '<div class="empty"><strong>Не удалось загрузить данные</strong>' +
        esc(e.message) + "</div>";
    });
  }

  function openFromHash() {
    var m = /^#p-(.+)$/.exec(location.hash);
    if (!m) return;
    var el = document.getElementById("p-" + m[1]);
    if (!el) return;
    el.dataset.open = "1";
    measure(el);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ----------------------------------------------------------- события ---- */

  document.addEventListener("click", function (e) {
    var tab = e.target.closest ? e.target.closest(".tab[data-tag]") : null;
    if (tab) {
      state.filter = tab.getAttribute("data-tag");
      state.shown = PAGE;
      renderTabs();
      renderTags();
      renderFeed();
    }
  });

  var searchTimer = null;
  $("search").addEventListener("input", function () {
    clearTimeout(searchTimer);
    var v = this.value;
    searchTimer = setTimeout(function () {
      state.query = v;
      state.shown = PAGE;
      renderFeed();
    }, 180);
  });

  $("refreshBtn").addEventListener("click", refreshLive);
  $("refreshLink").addEventListener("click", function (e) { e.preventDefault(); refreshLive(); });

  window.addEventListener("scroll", function () {
    $("toTop").classList.toggle("show", window.scrollY > 600);
  });
  $("toTop").addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  window.addEventListener("resize", function () {
    Array.prototype.forEach.call(document.querySelectorAll(".post"), measure);
  });
  window.addEventListener("hashchange", openFromHash);

  boot();
})();
