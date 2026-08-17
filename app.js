"use strict";

/* TYR INTEL: vanilla-JS hash-router SPA. No build tooling, no external deps. */

(function () {
  var APP = document.getElementById("app");
  var TABS = document.getElementById("tabs");
  var UPDATED = document.getElementById("updated");

  var DATA = null; // parsed site_data.json, or null if unavailable
  // "loading" until the boot fetch settles, then "ready" or "error".
  // Needed because DATA stays null in both the still-loading and the
  // failed case, and those want completely different messages.
  var LOAD_STATE = "loading";
  var REPLAY = null; // parsed match_data.json (deep single-replay debrief), or null
  var currentUser = { loggedIn: false, steamid: null, pref: "private" }; // from /api/me

  // All player-identifying pages are back on. Per-player privacy is now
  // handled server-side by the Cloudflare Worker (see cloudflare/src/
  // redact.js): a player who hasn't opted in shows up everywhere as a
  // {id: null, label: "Private Player N", private: true} placeholder rather
  // than being blocked from the page entirely, default private. This flag
  // stays as a harmless emergency kill-switch (flip to false to hide every
  // player-identifying route again, same as before) but there's no reason
  // to touch it under normal operation anymore.
  var SHOW_PLAYER_PAGES = true;

  // Panels the main site does not carry. The WIP build sets this true, so a
  // page can be kept and shown there without a second copy of its code.
  var WIP_ONLY = false;

  // ---------------------------------------------------------------- utils

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtNum(n) {
    if (n === null || n === undefined || typeof n !== "number" || Number.isNaN(n)) return "-";
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }

  function fmtPct(n) {
    if (n === null || n === undefined) return "-";
    return fmtNum(n) + "%";
  }

  function relTime(unixSec) {
    if (unixSec === null || unixSec === undefined) return "-";
    var diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 5) return "just now";
    var steps = [[31536000, "y"], [2592000, "mo"], [604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]];
    for (var i = 0; i < steps.length; i++) {
      var secs = steps[i][0], label = steps[i][1];
      if (diff >= secs) return Math.floor(diff / secs) + label + " ago";
    }
    return diff + "s ago";
  }

  // toLocaleString already converts to the reader's own timezone, but nothing
  // said so, so a timestamp could be read as the uploader's local time or as
  // UTC. The zone abbreviation removes the guess.
  var TZ_LABEL = (function () {
    try {
      var parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
        .formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === "timeZoneName") return parts[i].value;
      }
    } catch (e) { /* older browser: omit rather than fail */ }
    return "";
  })();

  function fmtDateTime(unixSec, withZone) {
    if (unixSec === null || unixSec === undefined) return "-";
    var d = new Date(unixSec * 1000);
    var s = d.toLocaleString(undefined, { year: "numeric", month: "short",
      day: "numeric", hour: "2-digit", minute: "2-digit" });
    return (withZone && TZ_LABEL) ? s + " " + TZ_LABEL : s;
  }

  function getPath(obj, path) {
    return path.split(".").reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }

  function findByKey(list, key, val) {
    for (var i = 0; i < (list ? list.length : 0); i++) {
      if (list[i][key] === val) return list[i];
    }
    return null;
  }

  function withOverride(obj, patch) {
    var out = {};
    for (var k in obj) out[k] = obj[k];
    for (var k2 in patch) out[k2] = patch[k2];
    return out;
  }

  // A redacted (private, not-you) player always arrives with id: null (see
  // cloudflare/src/redact.js's contract) -- render plain text instead of a
  // dead link. Centralizing the check here means every call site (rosters,
  // kill feed, leaderboard, tank pages) gets it for free.
  // shortId is the small, stable, "first spotted" sequence number
  // (tools/replay_to_site.py assigns it, append-only, never reassigned --
  // see data/player_short_ids.json) that routes #/player/<n> WITHOUT ever
  // putting the raw SteamID64 in a URL/browser-history entry. Falls back to
  // routing by the raw id when shortId isn't available (older cached data,
  // or a row shape that hasn't been touched by the short-id attach pass) --
  // renderPlayer() accepts either format, so old links keep working too.
  function playerLink(id, label, shortId) {
    if (shortId !== undefined && shortId !== null) {
      return '<a href="#/player/' + shortId + '">' + esc(label) + "</a>";
    }
    if (id === null || id === undefined) return esc(label);
    return '<a href="#/player/' + encodeURIComponent(id) + '">' + esc(label) + "</a>";
  }

  // Categories a still-public player can additionally hide (see
  // cloudflare/src/redact.js's HIDE_FIELD_PATHS -- this list must match its
  // keys, "matchHistory" included even though it has no field-path entry
  // there, since it's a valid category implemented by scoping visibility
  // instead of nulling a field).
  // Grouped (not a flat list) so the settings panel can render section
  // headers -- every field a visitor can see about another player gets its
  // own independent toggle now, instead of a few bundled catch-alls.
  // Steam ID is NOT here -- unlike everything in this list (visible by
  // default, opt-in to hide), it's hidden by default for EVERYONE
  // (including signed in players) and opt-in to SHOW -- see the separate
  // "showSteamId" checkbox in settingsPanelHtml() and
  // cloudflare/src/redact.js's hideUnshownSteamIds.
  var HIDE_GROUPS = [
    { title: "Identity", items: [
      { key: "clan", label: "Clan tag" },
      { key: "pastNames", label: "Past names" },
      { key: "squadmates", label: "Who I play with" },
    ] },
    { title: "Stats", items: [
      { key: "games", label: "Games" },
      { key: "winrate", label: "Winrate" },
      { key: "kills", label: "Kills" },
      { key: "damage", label: "Damage" },
      { key: "assist", label: "Assist" },
      { key: "blocked", label: "Blocked" },
      { key: "survival", label: "Survival time" },
    ] },
    { title: "History", items: [
      { key: "tanksWinrate", label: "Tanks played" },
      { key: "maps", label: "Maps played" },
      { key: "matchHistory", label: "Match history" },
    ] },
  ];
  var HIDE_CATEGORIES = HIDE_GROUPS.reduce(function (acc, g) { return acc.concat(g.items); }, []);

  function findOwnRow() {
    if (!DATA || !DATA.players || !currentUser.loggedIn) return null;
    for (var i = 0; i < DATA.players.length; i++) {
      if (DATA.players[i].id === currentUser.steamid) return DATA.players[i];
    }
    return null;
  }

  // Top-right header widget: signed-out shows nothing here for now (the
  // Steam sign-in link still lives on the About page, #/about, reached via
  // the "About data" nav tab); signed-in shows a compact "Settings" button
  // that opens a dropdown panel (rather than the account status/toggle
  // sitting directly in the header) containing who you're signed in as,
  // the Public/Private gate, per-category hide checkboxes (only meaningful
  // while Public), and Sign out. Lives in index.html's static header
  // (outside #app), so unlike page content it only needs rendering once at
  // boot -- router() re-rendering #app doesn't touch it.
  function renderAuthWidget() {
    var el = document.getElementById("auth-widget");
    if (!el) return;
    if (!currentUser.loggedIn) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML =
      '<button class="settings-btn" id="settings-toggle" type="button">&#9881; Settings</button>' +
      '<div class="settings-panel" id="settings-panel" hidden></div>';
    document.getElementById("settings-toggle").addEventListener("click", function () {
      var panel = document.getElementById("settings-panel");
      if (panel.hasAttribute("hidden")) {
        panel.innerHTML = settingsPanelHtml();
        panel.removeAttribute("hidden");
        wireSettingsPanel();
      } else {
        panel.setAttribute("hidden", "");
      }
    });
  }

  function settingsPanelHtml() {
    var pref = currentUser.pref || { visibility: "private", hide: [], hideAll: [],
                                     showSteamId: false, anonymousUploads: false };
    var me = findOwnRow();
    var name = me ? me.label : currentUser.steamid;
    var isPublic = pref.visibility === "public";
    var disabled = isPublic ? "" : " disabled";
    // Two independent per-category controls: "hide" only affects signed-out
    // (anonymous) visitors, same as before. "hideAll" is the new one -- it
    // affects EVERY other viewer, signed in or not, mirroring how
    // showSteamId already works below. Unlike "hide", "hideAll" checkboxes
    // are never disabled by the Public/Private picker: they're about
    // signed-in visibility, which is a completely separate audience from
    // the signed out gate that picker controls, so they matter even while
    // Private (signed in players still see a Private player's stats today).
    function categoryRow(c, showPrimary) {
      var hideChecked = pref.hide.indexOf(c.key) !== -1 ? " checked" : "";
      var hideAllChecked = pref.hideAll.indexOf(c.key) !== -1 ? " checked" : "";
      var primary = showPrimary
        ? '<label class="settings-check"><input type="checkbox" data-hide="' + c.key + '"' + hideChecked + disabled + "> " + esc(c.label) + "</label>"
        : '<div class="settings-check-label small">' + esc(c.label) + "</div>";
      var sub = '<label class="settings-check settings-subcheck"><input type="checkbox" data-hideall="' + c.key + '"' + hideAllChecked + "> hide from signed in too</label>";
      return '<div class="settings-check-item">' + primary + sub + "</div>";
    }
    function groupsHtml(showPrimary) {
      return HIDE_GROUPS.map(function (g) {
        var items = g.items.map(function (c) { return categoryRow(c, showPrimary); }).join("");
        return '<div class="settings-group"><div class="settings-group-title">' + esc(g.title) + "</div>" +
          '<div class="settings-check-grid">' + items + "</div></div>";
      }).join("");
    }
    // Bulk shortcuts -- neither stores anything extra server side, both are
    // just "check every box below at once". Player still shows up by name
    // either way; every stat column reads as hidden, same as clicking each
    // box individually.
    var allHidden = HIDE_CATEGORIES.every(function (c) { return pref.hide.indexOf(c.key) !== -1; });
    var allHiddenEveryone = HIDE_CATEGORIES.every(function (c) { return pref.hideAll.indexOf(c.key) !== -1; });
    var hideAllRow = '<label class="settings-check" style="margin-top:12px;font-weight:600">' +
      '<input type="checkbox" id="settings-hide-all"' + (allHidden ? " checked" : "") + disabled + "> " +
      "Hide everything from signed out visitors (stay listed by name only)</label>";
    var hideAllEveryoneRow = '<label class="settings-check" style="margin-top:6px;font-weight:600">' +
      '<input type="checkbox" id="settings-hide-all-everyone"' + (allHiddenEveryone ? " checked" : "") + "> " +
      "Hide everything from EVERYONE, including signed in players (stay listed by name only)</label>";
    var picker =
      '<div class="settings-row"><span>Who can see you</span><select class="settings-select" id="settings-visibility">' +
      '<option value="public"' + (isPublic ? " selected" : "") + ">Everyone</option>" +
      '<option value="private"' + (isPublic ? "" : " selected") + ">Signed in players only</option>" +
      "</select></div>";
    var body = isPublic
      ? '<div class="small" style="margin:12px 0 2px">Signed out visitors can see you. Hide anything else here:</div>' +
        hideAllRow + hideAllEveryoneRow + groupsHtml(true)
      : '<div class="small" style="margin:12px 0 2px;color:var(--dim)">You’re hidden from signed out visitors entirely. ' +
        "Signed in players still see your stats. Hide specific things from them below:</div>" +
        hideAllEveryoneRow + groupsHtml(false);
    // Unlike the checkboxes above (which only affect signed out visitors
    // and are disabled while Private, since they're moot then), this one
    // is NEVER disabled and applies to EVERY viewer, signed in or not --
    // a Steam id is hidden by default from literally everyone until you
    // opt in here, even other signed in players who otherwise see your
    // full data regardless of the picker above.
    var showIdRow = '<label class="settings-check" style="margin-top:12px">' +
      '<input type="checkbox" id="settings-show-steamid"' + (pref.showSteamId ? " checked" : "") + "> " +
      "Show my Steam ID (hidden from everyone, including signed in players, unless checked)</label>";
    // Separate from the visibility picker on purpose: being listed on the
    // leaderboard and wanting your name on every match you sent in are two
    // different choices.
    var anonUploadRow = '<label class="settings-check">' +
      '<input type="checkbox" id="settings-anon-uploads"' +
      (pref.anonymousUploads ? " checked" : "") + "> " +
      "Upload anonymously (your name is not shown as the uploader on matches)</label>";
    return '<div class="settings-signedin">Signed in as ' + esc(name) + "</div>" +
      '<div class="small" style="margin:0 0 10px;color:var(--dim)">Signed in players see everything by default. ' +
      "Your Steam ID, and anything you mark “hide from signed in too” below, are the exceptions.</div>" +
      showIdRow + anonUploadRow +
      picker + body +
      '<a href="/auth/logout" class="settings-row" style="margin-top:12px">Sign out</a>';
  }

  function wireSettingsPanel() {
    function save() {
      var vis = document.getElementById("settings-visibility").value;
      var hide = [];
      var boxes = document.querySelectorAll("#settings-panel input[data-hide]");
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) hide.push(boxes[i].getAttribute("data-hide"));
      }
      var hideAll = [];
      var allBoxes = document.querySelectorAll("#settings-panel input[data-hideall]");
      for (var i2 = 0; i2 < allBoxes.length; i2++) {
        if (allBoxes[i2].checked) hideAll.push(allBoxes[i2].getAttribute("data-hideall"));
      }
      var showSteamId = document.getElementById("settings-show-steamid").checked;
      var anonUploads = document.getElementById("settings-anon-uploads").checked;
      fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: vis, hide: hide, hideAll: hideAll,
                               showSteamId: showSteamId, anonymousUploads: anonUploads }),
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res && res.ok) {
            currentUser.pref = res.pref;
            // the visitor's own redaction state just changed -- refresh
            // site_data.json and re-render the current page so it shows up
            // immediately rather than waiting for the next page load.
            loadJson("site_data.json").then(function (fresh) {
              if (fresh) { DATA = fresh; router(); }
            });
          }
          var panel = document.getElementById("settings-panel");
          if (panel && !panel.hasAttribute("hidden")) {
            panel.innerHTML = settingsPanelHtml();
            wireSettingsPanel();
          }
        });
    }
    document.getElementById("settings-visibility").addEventListener("change", save);
    document.getElementById("settings-show-steamid").addEventListener("change", save);
    var hideAllBox = document.getElementById("settings-hide-all");
    if (hideAllBox) hideAllBox.addEventListener("change", function () {
      // bulk-check (or bulk-clear) every individual category box to match,
      // then save -- this box has no state of its own server side, it's
      // purely a shortcut for "check all the boxes below".
      var checked = hideAllBox.checked;
      var catBoxes = document.querySelectorAll("#settings-panel input[data-hide]");
      for (var j = 0; j < catBoxes.length; j++) catBoxes[j].checked = checked;
      save();
    });
    var hideAllEveryoneBox = document.getElementById("settings-hide-all-everyone");
    if (hideAllEveryoneBox) hideAllEveryoneBox.addEventListener("change", function () {
      var checked = hideAllEveryoneBox.checked;
      var catBoxes = document.querySelectorAll("#settings-panel input[data-hideall]");
      for (var j = 0; j < catBoxes.length; j++) catBoxes[j].checked = checked;
      save();
    });
    // was "#settings-hides input[data-hide]" -- no element with that id
    // exists anywhere in settingsPanelHtml(), so this querySelectorAll
    // always returned an empty list and these checkboxes never got a
    // change listener at all (toggling one alone silently didn't save;
    // it only took effect if the visibility <select> was ALSO changed,
    // since that save() call happens to read every checkbox's current
    // state via the working "#settings-panel" scope below).
    var boxes = document.querySelectorAll("#settings-panel input[data-hide]");
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].addEventListener("change", save);
    }
    var allBoxes = document.querySelectorAll("#settings-panel input[data-hideall]");
    for (var k = 0; k < allBoxes.length; k++) {
      allBoxes[k].addEventListener("change", save);
    }
  }

  // "Hidden" (a player's own choice) reads very differently from "—" (no
  // data) -- this makes that distinction visible instead of collapsing
  // both into the same dash.
  function isHidden(p, category) {
    return !!(p && p.hiddenFields && p.hiddenFields.indexOf(category) !== -1);
  }
  function hiddenLabel() {
    return '<span class="small" style="opacity:.55" title="This player has chosen to hide this">Hidden</span>';
  }
  function hideAware(p, category, formatted) {
    return isHidden(p, category) ? hiddenLabel() : formatted;
  }

  // Outside a player's profile there's no "side" to call a winner or loser --
  // VICTORY/DEFEAT is only meaningful relative to one specific player. So
  // everywhere but the profile match history, just show how the match ended.
  var WIN_TYPE_TEXT = { elimination: "Elimination", capture: "Capture" };
  function resultChip(winType) {
    var label = WIN_TYPE_TEXT[winType];
    if (label) return '<span class="chip ' + (winType === "elimination" ? "chip-victory" : "chip-capture") + '">' + label + "</span>";
    // A null winType means the decoder could not confirm how the match ended
    // (no elimination or capture signal decoded) -- NOT that it was a draw.
    // Calling it a draw would be a claim the data doesn't back up.
    return '<span class="chip chip-gray" title="The decoder could not determine how this match ended">Unknown</span>';
  }

  function typeChip(match) {
    // RANKED is decoded from the replay's own mode tag. Before this the chip
    // only knew CUSTOM and STANDARD, so it called every ranked game STANDARD.
    if (match.type === "RANKED") return '<span class="chip chip-ranked">RANKED</span>';
    var isCustom = match.type ? match.type === "CUSTOM" : !!match.is_custom;
    return isCustom ?
      '<span class="chip chip-custom">CUSTOM</span>' :
      '<span class="chip chip-standard">STANDARD</span>';
  }

  function isRanked(m) { return m && m.type === "RANKED"; }

  // ---- game versions --------------------------------------------------
  //
  // Every match carries the game build it was recorded on. The game renumbers
  // builds as it patches, so nothing here is hardcoded: the list, the labels
  // and which one counts as current are all read off the archive at render
  // time. A build that stops appearing stops being offered.

  function matchBuild(m) {
    return m && m.build != null && m.build !== "" ? String(m.build) : "";
  }

  // Builds present in the archive, newest activity first.
  function buildList() {
    var by = {};
    ((DATA && DATA.matches) || []).forEach(function (m) {
      var b = matchBuild(m);
      if (!b) return;
      var e = by[b] || (by[b] = { build: b, matches: 0, first: null, last: null });
      e.matches++;
      var t = m.captured_unix || 0;
      if (!t) return;
      if (e.first === null || t < e.first) e.first = t;
      if (e.last === null || t > e.last) e.last = t;
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return (b.last || 0) - (a.last || 0); });
  }

  // Short day label, used for the span under a version name.
  function fmtDay(unixSec) {
    if (!unixSec) return "";
    var d = new Date(unixSec * 1000);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function buildSpan(e) {
    if (!e || !e.first) return "";
    var a = fmtDay(e.first), b = fmtDay(e.last);
    return a === b ? a : a + " to " + b;
  }

  // mm:ss. Match length is the one figure here that reads worse as a decimal.
  function fmtDuration(sec) {
    if (sec == null || !isFinite(sec) || sec <= 0) return "";
    var s = Math.round(sec);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  // <option> list of every build, for any filter that wants one.
  function buildOptions(selected) {
    return buildList().map(function (e) {
      return '<option value="' + esc(e.build) + '"' +
        (String(selected) === e.build ? " selected" : "") + ">" +
        esc(e.build) + " (" + fmtNum(e.matches) + ")</option>";
    }).join("");
  }

  function rankedGamesOf(playerId) {
    var n = 0, ms = (DATA && DATA.matches) || [], i, j;
    for (i = 0; i < ms.length; i++) {
      if (!isRanked(ms[i])) continue;
      var ps = ms[i].players || [];
      for (j = 0; j < ps.length; j++) {
        if (ps[j].id === playerId) { n++; break; }
      }
    }
    return n;
  }

  function personalOutcome(match, playerId) {
    var row = null;
    for (var i = 0; i < match.players.length; i++) { if (match.players[i].id === playerId) { row = match.players[i]; break; } }
    if (!row || !row.side || (match.result !== "VICTORY" && match.result !== "DEFEAT")) return "unknown";
    if ((match.result === "VICTORY" && row.side === "ally") || (match.result === "DEFEAT" && row.side === "enemy")) return "win";
    if ((match.result === "DEFEAT" && row.side === "ally") || (match.result === "VICTORY" && row.side === "enemy")) return "loss";
    return "unknown";
  }

  function personalChip(outcome) {
    if (outcome === "win") return '<span class="chip chip-victory">WIN</span>';
    if (outcome === "loss") return '<span class="chip chip-defeat">LOSS</span>';
    return '<span class="chip chip-gray">UNKNOWN</span>';
  }

  function copyId(id) {
    var status = document.getElementById("copy-id-status");
    function done() {
      if (!status) return;
      status.textContent = "Copied!";
      setTimeout(function () { if (status) status.textContent = ""; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(done, function () { fallbackCopy(id, done); });
    } else {
      fallbackCopy(id, done);
    }
  }

  function fallbackCopy(text, cb) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      cb();
    } catch (e) { /* clipboard unavailable, so silently give up */ }
  }

  // ---------------------------------------------------------------- assets (maps / tanks)

  function slugify(name) {
    return String(name == null ? "" : name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // Graceful image tag: hides itself on 404 (onerror) so a broken-image icon never
  // shows — the caller is expected to always render the text label alongside/instead.
  function imgTag(src, cls) {
    return '<img src="' + esc(src) + '" class="' + cls + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';
  }

  function mapImgTag(map, cls) {
    if (!map) return "";
    return imgTag("assets/maps/" + slugify(map) + ".png", cls || "map-thumb");
  }

  // Maps section hero image: prefer the top-down minimap capture, fall back
  // to the lobby thumbnail, hide entirely if neither exists (see imgTag).
  function mapHeroImgTag(slug, cls) {
    if (!slug) return "";
    var mini = "assets/maps/minimap/" + esc(slugify(slug)) + ".png";
    var fallback = "assets/maps/" + esc(slugify(slug)) + ".png";
    return '<img src="' + mini + '" class="' + (cls || "map-hero-img") + '" alt="" loading="lazy" ' +
      "onerror=\"this.onerror=function(){this.style.display='none'};this.src='" + fallback + "'\">";
  }

  function tankImgTag(tankId, cls) {
    if (!tankId) return "";
    return imgTag("assets/tanks/" + slugify(tankId) + ".png", cls || "tank-icon");
  }

  function tankCell(name, tankId) {
    if (!name) return "-";
    return '<span class="tank-cell">' + tankImgTag(tankId, "tank-icon") + "<span>" + esc(name) + "</span></span>";
  }

  function tankRouteId(t) {
    return slugify(t.tank_id || t.tank);
  }

  function tankHref(t) {
    return "#/tank/" + encodeURIComponent(tankRouteId(t));
  }

  function findTank(idParam) {
    var key = String(idParam || "").toLowerCase();
    var list = (DATA && DATA.tanks) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].tank_id && slugify(list[i].tank_id) === key) return list[i];
    }
    for (var j = 0; j < list.length; j++) {
      if (slugify(list[j].tank) === key) return list[j];
    }
    return null;
  }

  // ---------------------------------------------------------------- nav

  function setActiveTab(route) {
    var links = TABS.querySelectorAll("a");
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle("active", links[i].dataset.route === route);
    }
  }

  function updateUpdatedLabel() {
    UPDATED.textContent = DATA ? "updated " + relTime(DATA.generated_unix) : "";
  }

  // ---------------------------------------------------------------- pages

  // Three genuinely different situations, which used to share one message
  // telling people to "play a match". That was wrong in the common case:
  // the site data failing to load is a fetch problem, not an empty database,
  // and saying otherwise sends people off to do something pointless.
  function renderLoading() {
    APP.innerHTML =
      '<div class="panel empty-state">' +
      '<div class="big">Loading<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>' +
      '<div class="sub">Fetching match data.</div>' +
      "</div>";
  }

  function renderLoadError(detail) {
    APP.innerHTML =
      '<div class="panel empty-state">' +
      '<div class="big">Could not load the data</div>' +
      '<div class="sub">The site data did not come back. This is usually temporary.' +
      (detail ? " " + esc(detail) : "") + "</div>" +
      '<div style="margin-top:16px"><button id="retry-load">Try again</button></div>' +
      "</div>";
    var b = document.getElementById("retry-load");
    if (b) b.addEventListener("click", function () { location.reload(); });
  }

  // Only for the real case: data loaded fine and there is genuinely nothing
  // in it yet.
  function renderEmptyState() {
    APP.innerHTML =
      '<div class="panel empty-state">' +
      '<div class="big">No matches yet</div>' +
      '<div class="sub">Nothing has been uploaded yet. ' +
      '<a href="#/upload">Upload a replay</a> to get started.</div>' +
      "</div>";
  }

  function renderNotFoundRoute() {
    APP.innerHTML =
      '<div class="panel not-found"><h2 style="border:none">Page not found</h2>' +
      '<p><a href="#/">&larr; Back to home</a></p></div>';
  }

  // ---- Upload (#/upload) ----------------------------------------------
  // Drop replays, they get checked here, then they go into the site.
  // Checks stream in as newline-delimited JSON from /api/verify. Files are
  // processed one at a time because each one is a full net-stream decode,
  // roughly a second of CPU per megabyte.

  var UPLOAD_LABELS = {
    "l1.size": "File size", "l1.magic": "Tyr replay file",
    "l1.chunks": "File structure", "l1.completed": "Closed by the game",
    "l1.iscompressed": "Storage format", "l1.isencrypted": "Encryption",
    "l1.build": "Current game version", "l1.map": "Official map",
    "l1.timestamp": "Recording date", "l1.headerchunk": "File header",
    "l1.parse": "File header", "l1.read": "File readable",
    "l2.decode": "Match data readable", "l3.anomalies": "No signs of editing",
    "l2.matchmaking": "Matchmade game", "l2.mode": "Official mode",
    "l2.matchid": "Server match ID", "l2.completed": "Played to the end",
    "l2.roster": "Full 8v8", "l2.duration": "Length adds up",
    "l4.deaths": "Kill timeline", "l4.scoreboard": "Scoreboard matches roster",
    "l4.survival": "Survival times", "l4.positions": "Player positions",
    "l6.recorder": "Recorded by one player", "l6.uploader": "You recorded this",
    "l5.corroboration": "Second point of view"
  };

  // Six named stages beat one flat list of 24 rows. Each collapses to a
  // single line once it passes and only opens when something needs looking at.
  var UPLOAD_STAGES = [
    // "Signs of editing" read as a finding, not a category: a stage collapses
    // to one green line when it passes, so a tick beside it looked like the
    // check had found editing.
    ["L1", "The file"], ["L2", "The match"], ["L3", "No signs of editing"],
    ["L4", "Internal consistency"], ["L6", "Who recorded it"], ["L5", "Corroboration"]
  ];

  var UPLOAD_VERDICTS = {
    UNVERIFIED: ["Accepted", "Everything checkable from one file passed."],
    CORROBORATED: ["Verified", "Another player uploaded this match and the two agree."],
    REJECTED: ["Not accepted", "Failed a check a real replay cannot fail."]
  };

  var upJobs = [], upQ = [], upBusy = false, upDead = false, upSeq = 0;

  // ---- persistent upload dock -------------------------------------------
  //
  // Uploads outlive the page they were started on. The queue and its fetches
  // are module state, so they keep going after navigation, but the progress
  // UI lived inside #app and the router replaces that wholesale, so leaving
  // the upload page looked like the batch had vanished. Tyr keeps about ten
  // replays, so a batch of ten is the normal case, and nobody wants to sit
  // and watch it.
  //
  // The dock renders into #jobs-dock, which sits outside #app.
  var upDockOpen = true;

  function upActive() {
    return upJobs.filter(function (j) { return !j.report && j.status !== "error"; });
  }

  function upRenderDock() {
    var dock = document.getElementById("jobs-dock");
    if (!dock) return;
    var active = upActive();
    var done = upJobs.filter(function (j) { return j.report; });
    // Nothing in flight and nothing finished: no reason to be on screen.
    if (!upJobs.length) { dock.hidden = true; dock.innerHTML = ""; return; }
    // On the upload page the full cards are already visible, so the dock
    // would just repeat them.
    if ((location.hash || "#/") === "#/upload") { dock.hidden = true; return; }

    dock.hidden = false;
    var ok = done.filter(function (j) { return j.report.verdict !== "REJECTED"; }).length;
    var bad = done.length - ok;
    var head = active.length
      ? active.length + " upload" + (active.length === 1 ? "" : "s") + " running"
      : done.length + " upload" + (done.length === 1 ? "" : "s") + " finished";

    var rows = upDockOpen ? upJobs.slice().reverse().map(function (j) {
      var state = j.report
        ? (UPLOAD_VERDICTS[j.report.verdict] || [j.report.verdict])[0]
        : ({ waiting: "Waiting", running: "Checking", error: "Error" }[j.status] || "");
      var cls = j.report ? "up-" + j.report.verdict : j.status;
      return '<div class="jd-row"><span class="jd-name">' + esc(j.name) + "</span>" +
        '<span class="jd-state ' + cls + '">' + esc(state) + "</span></div>";
    }).join("") : "";

    dock.innerHTML =
      '<div class="jd-head"><b>' + esc(head) + "</b>" +
      (done.length ? '<span class="jd-sum">' + ok + " ok" +
        (bad ? ", " + bad + " rejected" : "") + "</span>" : "") +
      '<button class="jd-toggle" id="jd-toggle">' + (upDockOpen ? "hide" : "show") + "</button>" +
      "</div>" + (upDockOpen ? '<div class="jd-rows">' + rows + "</div>" +
        '<a class="jd-link" href="#/upload">Open upload page</a>' : "");

    var tg = document.getElementById("jd-toggle");
    if (tg) tg.addEventListener("click", function () {
      upDockOpen = !upDockOpen; upRenderDock();
    });
  }

  // Average the Steam player-count samples into 24 local hours.
  // Returns empty when there is nothing to average, so the caller can fall
  // back rather than draw a flat line implying zero players.
  function upMapSlug(p) {
    var m = /Map_([A-Za-z0-9]+)$/.exec(String(p || ""));
    return m ? m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() : null;
  }
  function upMapName(p) {
    var s = upMapSlug(p);
    return s ? s.replace(/-/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); })
             : "Unknown map";
  }
  function upEl(j, part) { return document.getElementById("uj" + j.id + "-" + part); }

  function upCard(j) {
    return '<div class="panel up-job" id="uj' + j.id + '-root">' +
      '<div class="up-jhead"><span class="up-jname">' + esc(j.name) + "</span>" +
      '<span class="up-jstate" id="uj' + j.id + '-state">Waiting</span></div>' +
      '<div class="up-bar" id="uj' + j.id + '-bar"><i></i></div>' +
      '<div class="up-phase" id="uj' + j.id + '-phase"></div>' +
      '<div id="uj' + j.id + '-stages"></div>' +
      '<div id="uj' + j.id + '-out"></div></div>';
  }

  function upRenderAll() {
    var list = document.getElementById("up-list");
    if (!list) return;
    list.innerHTML = upJobs.map(upCard).join("");
    upJobs.forEach(function (j) {
      upState(j); upStages(j);
      if (j.report) upResult(j);
    });
  }

  function upState(j) {
    upRenderDock();          // the dock mirrors job state wherever you are
    upSave();                // and localStorage keeps it across a reload
    var s = upEl(j, "state");
    if (!s) return;
    var t = { waiting: "Waiting", running: "Checking", error: "Error", done: "" }[j.status] || "";
    if (j.report) t = (UPLOAD_VERDICTS[j.report.verdict] || [j.report.verdict])[0];
    s.textContent = t;
    s.className = "up-jstate " + (j.report ? "up-" + j.report.verdict : j.status);
  }

  function upBar(j, pct, cls) {
    var b = upEl(j, "bar");
    if (!b) return;
    b.firstElementChild.style.width = Math.min(100, pct) + "%";
    if (cls !== undefined) b.className = "up-bar " + cls;
  }

  // Which bucket a single check falls into.
  function upKind(c) {
    if (c.status === "pass") return "pass";
    if (c.status === "skip") return "skip";
    return c.severity === "warn" ? "warn" : "fail";
  }

  var UP_MARK = { pass: "✓", warn: "!", fail: "✕", skip: "·" };

  // Was this the first finished upload of the batch? The full breakdown is
  // genuinely useful the first time you ever see it, and pure noise by the
  // fifth: WarMechanic's words were that once it shows up more than once it is
  // too much space, and that the space is better spent on the map and rosters.
  // So the first clean upload explains itself in full, and the rest collapse
  // to one line you can still open. Anything that FAILED always shows, because
  // that is the case worth reading (his example: catching a sandbox replay by
  // accident).
  function upIsFirstClean(j) {
    for (var i = 0; i < upJobs.length; i++) {
      var o = upJobs[i];
      if (o === j) return true;
      if (o.report && o.report.verdict !== "REJECTED") return false;
    }
    return true;
  }

  function upStages(j) {
    var wrap = upEl(j, "stages");
    if (!wrap) return;

    var stages = UPLOAD_STAGES.map(function (st) {
      var rows = j.checks.filter(function (c) { return c.tier === st[0]; });
      if (!rows.length) return null;
      var fails = rows.filter(function (c) { return c.status === "fail" && c.severity !== "warn"; });
      var warns = rows.filter(function (c) { return c.status === "fail" && c.severity === "warn"; });
      var passes = rows.filter(function (c) { return c.status === "pass"; });
      // A stage where nothing ran did not pass. Saying so would claim
      // something was verified when it was not, so it is never "clean".
      var kind = fails.length ? "fail" : warns.length ? "warn" : passes.length ? "pass" : "skip";
      return { st: st, rows: rows, fails: fails, warns: warns,
               passes: passes, kind: kind, clean: kind === "pass" };
    }).filter(Boolean);

    function detail(rows) {
      return '<ul class="up-list-inner">' + rows.map(function (c) {
        var k = upKind(c);
        return '<li class="up-row ' + k + '"><span class="up-ic">' + UP_MARK[k] + "</span><span>" +
          esc(UPLOAD_LABELS[c.id] || c.title) +
          (c.status === "fail" ? '<div class="up-why">' + esc(c.detail) + "</div>" : "") +
          "</span></li>";
      }).join("") + "</ul>";
    }

    function block(s) {
      var note = s.fails.length ? s.fails.length + " failed"
               : s.warns.length ? s.warns.length + " to note"
               : s.passes.length ? s.passes.length + " passed" : "not checked";
      return '<details class="up-stage ' + s.kind + '"' + (s.fails.length ? " open" : "") + ">" +
        '<summary><span class="up-ic ' + s.kind + '">' + UP_MARK[s.kind] + "</span>" +
        "<span>" + esc(s.st[1]) + '</span><span class="up-note">' + note + "</span></summary>" +
        detail(s.rows) + "</details>";
    }

    function stripOf(run) {
      var total = run.reduce(function (n, s) { return n + s.passes.length; }, 0);
      // Corroboration is the one pass worth calling out, since it means
      // somebody else's recording of this match agreed.
      var corroborated = run.some(function (s) {
        return s.rows.some(function (c) {
          return c.id === "l5.corroboration" && c.status === "pass";
        });
      });
      return '<details class="up-strip">' +
        "<summary>" + run.map(function (s, i) {
          return (i ? '<span class="up-arrow">→</span>' : "") +
            '<span class="up-step">✓ ' + esc(s.st[1]) + "</span>";
        }).join("") +
        '<span class="up-note">' + total + " passed" +
        (corroborated ? ' <span class="up-bang">!</span>' : "") + "</span></summary>" +
        run.map(function (s) {
          return '<div class="up-substage">' + esc(s.st[1]) + "</div>" + detail(s.rows);
        }).join("") + "</details>";
    }

    // Everything passed, and an earlier upload already showed the breakdown:
    // one line, openable. The verdict block and the match preview below carry
    // the actual outcome.
    var allClean = stages.length > 0 && stages.every(function (s) { return s.clean; });
    if (allClean && j.report && !upIsFirstClean(j)) {
      var total0 = stages.reduce(function (a, s) { return a + s.passes.length; }, 0);
      wrap.innerHTML = '<details class="up-thin"><summary>' +
        '<span class="up-tick">✓</span> all ' + total0 + ' checks passed' +
        '<span class="up-note">show</span></summary>' +
        stages.map(function (s) {
          return '<div class="up-substage">' + esc(s.st[1]) + "</div>" + detail(s.rows);
        }).join("") + "</details>";
      return;
    }

    // Stages that passed outright get folded into one line rather than a row
    // each -- six rows saying "9 passed" is a lot of vertical space telling
    // you nothing is wrong, and it pushes the map and rosters (which people
    // actually read) off the screen. But folding every clean stage to the
    // front, ahead of anything that only warned, put "The match" before "The
    // file" on almost every accepted upload: the build-version check (l1.build)
    // is WARN rather than FAIL for any replay not from the exact pinned build,
    // which is most of them, so "The file" essentially never comes back fully
    // clean and got pushed behind everything checked after it. Order is kept
    // by walking stages once and only folding RUNS of two or more consecutive
    // clean stages -- a warned or failed stage still gets its own block, in
    // its own place, same as a lone clean stage would (folding one stage just
    // hides it behind a click for no gain).
    var out = "", i = 0;
    while (i < stages.length) {
      if (stages[i].clean) {
        var run = [stages[i]], k = i + 1;
        while (k < stages.length && stages[k].clean) { run.push(stages[k]); k++; }
        out += run.length >= 2 ? stripOf(run) : block(run[0]);
        i = k;
      } else {
        out += block(stages[i]);
        i++;
      }
    }
    wrap.innerHTML = out;
  }

  function upMatch(f) {
    var roster = f.roster || [];
    var a = roster.filter(function (p) { return p.team === 0; });
    var b = roster.filter(function (p) { return p.team === 1; });
    function side(list, cls, label) {
      return '<div><div class="up-tside ' + cls + '">' + label + " " + list.length + "</div>" +
        list.map(function (p) {
          var me = p.name === f.recorder;
          return '<div class="up-trow' + (me ? " me" : "") + '">' + esc(p.name) +
            (me ? " <span>you</span>" : "") + "</div>";
        }).join("") + "</div>";
    }
    var slug = upMapSlug(f.map);
    return '<div class="up-match"' +
      (slug ? ' style="background-image:url(assets/maps/' + encodeURIComponent(slug) + '.png)"' : "") +
      '><div class="up-minner"><div class="up-mtop"><b>' + esc(upMapName(f.map)) + "</b> " +
      '<span class="small">' + (f.durationSec ? fmtClock(f.durationSec) : "") +
      (f.recordedIso ? " · " + esc(f.recordedIso.replace("T", " ").slice(0, 16)) : "") +
      "</span></div>" +
      (roster.length ? '<div class="up-teams">' + side(a, "a", "Team A") +
        side(b, "b", "Team B") + "</div>" : "") + "</div></div>";
  }

  function upResult(j) {
    var out = upEl(j, "out");
    if (!out) return;
    var rep = j.report, f = rep.facts || {};
    var v = UPLOAD_VERDICTS[rep.verdict] || [rep.verdict, ""];
    var added = rep.verdict === "REJECTED" ? "" :
      '<div class="up-added">Saved. It appears on the site the next time the match ' +
      "data is rebuilt." +
      (rep.verdict === "UNVERIFIED"
        ? " Upload another point of view of the same match to get it verified." : "") + "</div>";
    out.innerHTML = '<div class="up-verdict up-' + esc(rep.verdict) + '"><b>' + esc(v[0]) +
      '</b><div class="small">' + esc(v[1]) + "</div>" + added + "</div>" +
      // Only when accepted. A rejected file often still has a readable
      // header, so a map name survives; showing it as "the match" would
      // dress up a file we just refused as a real game.
      (rep.verdict !== "REJECTED" && (f.roster || f.map) ? upMatch(f) : "");
    upBar(j, 100, rep.verdict === "REJECTED" ? "fail" : "done");
    var ph = upEl(j, "phase");
    if (ph) ph.textContent = "";
    upState(j);
    upSummary();
  }

  function upSummary() {
    var s = document.getElementById("up-sum");
    if (!s) return;
    var done = upJobs.filter(function (j) { return j.report; });
    if (!done.length) { s.innerHTML = ""; return; }
    var ok = done.filter(function (j) { return j.report.verdict !== "REJECTED"; }).length;
    s.innerHTML = done.length + " checked, " + ok + " accepted" +
      (done.length - ok ? ", " + (done.length - ok) + " rejected" : "");
  }

  // True while every queued job is parked on a retry timer, so the pump
  // knows to stand down instead of spinning on them.
  function upWaiting() {
    if (!upQ.length) return false;
    var now = Date.now();
    for (var i = 0; i < upQ.length; i++) {
      if (!upQ[i].waitUntil || upQ[i].waitUntil <= now) return false;
    }
    return true;
  }

  function upPump() {
    if (upDead || upBusy) return;
    var j = upQ.shift();
    if (!j) return;
    if (j.waitUntil && Date.now() < j.waitUntil) {
      upQ.unshift(j);                  // not yet: leave it where it was
      return;
    }
    j.waitUntil = null;
    upBusy = true;
    j.status = "running";
    upState(j);
    var ph = upEl(j, "phase");
    if (ph) ph.textContent = "Uploading";

    // No uploader is passed here on purpose. The edge reads it from the
    // signed in session, because anything sent from this side is just a
    // query string the uploader could set to somebody else's Steam ID.
    fetch("/api/verify?name=" + encodeURIComponent(j.name),
          { method: "POST", body: j.file })
      .then(function (res) {
        if (res.status === 401) {
          throw new Error("You need to be signed in with Steam to upload. " +
                          "Your session may have expired, so try signing in again.");
        }
        if (res.status === 429) {
          // Wait it out rather than failing. Tyr only keeps about ten
          // replays, so people back them up ten at a time; making the
          // eleventh an error threw away a whole batch for something that
          // just needed a pause. The server says how long, so honour it.
          return res.json().catch(function () { return {}; }).then(function (b) {
            var secs = Math.max(5, Math.min(900, b.retryAfterSeconds || 60));
            j.waitUntil = Date.now() + secs * 1000;
            j.status = "waiting";
            upQ.unshift(j);            // keeps its place at the front
            upBar(j, 0, "warn");
            upState(j);
            var ph = upEl(j, "phase");
            if (ph) ph.textContent = "Server is busy, retrying in " + secs + "s";
            j.retryScheduled = true;
            setTimeout(function () { if (!upDead) upPump(); }, secs * 1000 + 250);
            return null;               // not an error, just deferred
          });
        }
        if (!res.ok) throw new Error("server returned " + res.status);
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
        function read() {
          return reader.read().then(function (r) {
            if (r.done || upDead) return;
            buf += dec.decode(r.value, { stream: true });
            var nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              var line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              var ev;
              try { ev = JSON.parse(line); } catch (e) { continue; }
              if (ev.type === "phase") {
                var p = upEl(j, "phase");
                if (p) p.textContent = ev.label;
                upBar(j, ev.phase === "file" ? 3 : ev.phase === "decode" ? 8 : 93);
              } else if (ev.type === "progress") {
                upBar(j, 8 + 84 * (ev.done / Math.max(1, ev.total)));
              } else if (ev.type === "check") {
                j.checks.push(ev.check);
                upStages(j);
              } else if (ev.type === "done") {
                j.status = "done"; j.report = ev.report; upResult(j);
              } else if (ev.type === "error") {
                j.status = "error"; upBar(j, 100, "fail"); upState(j);
              }
            }
            return read();
          });
        }
        return read();
      })
      .catch(function (e) {
        if (upDead) return;
        j.status = "error";
        var o = upEl(j, "out");
        if (o) {
          o.innerHTML = '<div class="up-verdict up-REJECTED"><b>Could not check this file</b>' +
            '<div class="small">' + esc(e.message || String(e)) + "</div></div>";
        }
        upBar(j, 100, "fail");
        upState(j);
      })
      .then(function () {
        upBusy = false;
        // A deferred job re-queued itself with its own timer; pumping now
        // would just pull it straight back out and hit the limit again.
        if (!upDead && !upWaiting()) upPump();
      });
  }

  function upAccept(files) {
    var n = 0;
    Array.prototype.forEach.call(files, function (f) {
      if (!/\.replay$/i.test(f.name)) return;
      var j = { id: ++upSeq, file: f, name: f.name, status: "waiting",
               checks: [], report: null, at: Date.now() };
      upJobs.push(j); upQ.push(j); n++;
    });
    if (!n) return;
    upRenderAll();
    upPump();
  }

  // ---- upload history ---------------------------------------------------
  //
  // Two different kinds of persistence, because they answer different
  // questions:
  //
  //   the server  -> every replay this account has ever had accepted. Survives
  //                  reloads, new browsers, other machines. This is the real
  //                  history and it comes from /api/my-uploads, filtered to
  //                  the signed-in account server side.
  //   localStorage -> the batch currently in flight. A reload used to lose the
  //                  whole view mid-upload even though the uploads themselves
  //                  had already been accepted, which read as data loss.
  var UP_STORE = "tyr.uploads.session";

  function upSave() {
    try {
      // Only what is needed to redraw a row. Never the File objects, which
      // cannot be serialised, and never the full check list, which is large
      // and stale the moment the page reloads.
      var slim = upJobs.map(function (j) {
        return { name: j.name, status: j.report ? "done" : j.status,
                 verdict: j.report ? j.report.verdict : null,
                 at: j.at || Date.now() };
      });
      localStorage.setItem(UP_STORE, JSON.stringify(slim.slice(-40)));
    } catch (e) { /* private mode or quota: history is a nicety, not required */ }
  }

  function upLoadSession() {
    try {
      var raw = localStorage.getItem(UP_STORE);
      if (!raw) return [];
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function upHistoryPanel() {
    return '<div class="panel" id="up-hist"><h2>Your uploads</h2>' +
      '<p class="small" id="up-hist-note">Loading your history…</p>' +
      '<div id="up-hist-body"></div></div>';
  }

  function upRenderHistory(rows, sessionRows) {
    var note = document.getElementById("up-hist-note");
    var body = document.getElementById("up-hist-body");
    if (!body) return;

    if (!rows.length && !sessionRows.length) {
      if (note) note.textContent = "Nothing uploaded yet. Anything you send shows up here, and stays.";
      body.innerHTML = "";
      return;
    }
    if (note) {
      note.textContent = rows.length
        ? rows.length + " replay" + (rows.length === 1 ? "" : "s") + " accepted from this account."
        : "From this browser session.";
    }

    // Server rows are authoritative. Session rows only fill in a batch the
    // server has not indexed yet, matched by filename so nothing double lists.
    var seen = {};
    rows.forEach(function (r) { if (r.file) seen[r.file] = true; });
    var pending = sessionRows.filter(function (s) { return !seen[s.name]; });

    function verdictChip(v) {
      var label = (UPLOAD_VERDICTS[v] || [v || "?"])[0];
      return '<span class="uh-v up-' + esc(v || "") + '">' + esc(label) + "</span>";
    }

    body.innerHTML = '<div class="tablewrap-uh"><table class="uh-table"><tbody>' +
      rows.map(function (r) {
        var when = r.storedUnix ? fmtDateTime(r.storedUnix) : "";
        return "<tr><td>" + verdictChip(r.verdict) + "</td>" +
          '<td class="uh-map">' + esc(upMapName(r.map)) + "</td>" +
          '<td class="uh-when">' + esc(when) + "</td>" +
          '<td class="uh-state">' + (r.collected ? "on the site" : "waiting for rebuild") + "</td></tr>";
      }).join("") +
      pending.map(function (s) {
        return '<tr class="uh-pending"><td>' + verdictChip(s.verdict) + "</td>" +
          '<td class="uh-map">' + esc(s.name) + "</td>" +
          '<td class="uh-when">this session</td>' +
          '<td class="uh-state">not indexed yet</td></tr>';
      }).join("") +
      "</tbody></table></div>";
  }

  function upFetchHistory() {
    var session = upLoadSession();
    fetch("/api/my-uploads", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { uploads: [] }; })
      .then(function (d) { upRenderHistory(d.uploads || [], session); })
      .catch(function () {
        // Offline or the endpoint is unavailable: the session list is still
        // worth showing rather than an error.
        upRenderHistory([], session);
      });
  }

  function renderUpload() {
    // Do NOT clear jobs that are still going. Revisiting the page used to
    // reset the queue, which orphaned in-flight fetches: they kept uploading
    // while their cards were gone, and the summary counted nothing.
    upDead = false;
    if (!upJobs.length || !upActive().length) {
      upJobs = []; upQ = []; upBusy = false; upSeq = 0;
    }

    // Signed out visitors get the explanation and a way in, but no drop
    // zone. The edge rejects their uploads anyway, so offering the control
    // would only produce a failure after they picked a file. The tab is
    // hidden for them too; this still has to hold because the route can be
    // reached by typing the URL or following an old link.
    if (!currentUser.loggedIn) {
      APP.innerHTML =
        '<div class="page-head"><h1>Upload replays</h1></div>' +
        '<div class="up-signin-banner"><div><b>Sign in to upload.</b> Replays are ' +
        "tied to the Steam account that sends them. That is how the site knows who " +
        'recorded what.</div><a class="btn-signin" href="/auth/steam/login">' +
        "Sign in with Steam</a></div>" +
        '<div class="panel"><h2>What happens after you sign in</h2>' +
        '<p class="small">Drop the replays from ' +
        "<code>%LOCALAPPDATA%\\Tyr\\Saved\\Demos</code>. Each one gets checked: " +
        "game version, file structure, matchmade or custom, whether it ran to the " +
        "end, whether the numbers inside agree. Anything that passes goes on the " +
        "site at the next rebuild.</p>" +
        '<p class="small">Tyr does not sign its replays. No single file can prove ' +
        "it was untouched. A second player uploading the same match settles " +
        "it.</p></div>";
      return;
    }

    APP.innerHTML =
      '<div class="page-head"><h1>Upload replays</h1></div>' +
      '<p class="small" style="margin:-8px 0 14px">Your replays are in ' +
      '<code>%LOCALAPPDATA%\\Tyr\\Saved\\Demos</code>.</p>' +
      '<div class="up-signed">Signed in. Uploads are checked against your ' +
      "Steam account.</div>" +
      '<div class="panel">' +
        '<div class="up-drop" id="up-drop">' +
          '<div class="up-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
          'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M8 10.5V2.5M5 5.5L8 2.5l3 3"/><path d="M2.5 10v3.5h11V10"/></svg></div>' +
          '<div class="up-big">Drop replays here</div>' +
          '<div class="small">or click to choose files</div></div>' +
        '<div class="small up-sum" id="up-sum"></div>' +
      "</div>" +
      '<div id="up-list"></div>' +
      // A token is what lets something other than this page upload for you,
      // so it belongs on the page about uploading rather than on one of its
      // own. What holds the token is not this site's business.
      '<div class="panel"><h2>Upload token</h2>' +
      '<p class="small">For uploading from somewhere other than this page. A ' +
      "token can only upload.</p><div id=\"tokbox\" class=\"small\">Checking...</div></div>" +
      upHistoryPanel() +
      // Full width, with the explanation in three columns. A 64ch panel left
      // most of the row empty next to a full width drop zone, which read as a
      // layout mistake rather than a choice.
      '<div class="panel up-how"><h2>How this works</h2>' +
      '<div class="up-cols">' +
        "<div><h3>1. Checked here first</h3>" +
        '<p class="small">Game version, file structure, matchmade or custom, whether ' +
        "the match ran to the end, whether the numbers inside agree.</p></div>" +
        "<div><h3>2. Added either way</h3>" +
        '<p class="small">Anything that passes is kept. It appears at the next data ' +
        "rebuild, marked unverified.</p></div>" +
        "<div><h3>3. A second view verifies it</h3>" +
        '<p class="small">Upload another point of view of the same match. The two ' +
        "recordings get checked against each other. That makes it verified.</p></div>" +
      "</div>" +
      '<p class="small up-note">Tyr does not sign its replays. No single file can ' +
      "prove it was untouched. The checks make faking one harder. A second player's " +
      "recording is what settles it, and most replays stay unverified until someone " +
      "uploads the same match.</p></div>";

    upFetchHistory();
    wireTokens();
    var drop = document.getElementById("up-drop");
    function stop(ev) { ev.preventDefault(); ev.stopPropagation(); }
    ["dragenter", "dragover"].forEach(function (e) {
      drop.addEventListener(e, function (ev) { stop(ev); drop.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (e) {
      drop.addEventListener(e, function (ev) { stop(ev); drop.classList.remove("over"); });
    });
    drop.addEventListener("drop", function (ev) {
      if (ev.dataTransfer.files.length) upAccept(ev.dataTransfer.files);
    });
    drop.addEventListener("click", function () {
      var i = document.createElement("input");
      i.type = "file"; i.accept = ".replay"; i.multiple = true;
      i.onchange = function () { if (i.files.length) upAccept(i.files); };
      i.click();
    });
  }

  function renderAbout() {
    APP.innerHTML =
      '<div class="page-head"><h1>About this data</h1></div>' +
      '<div class="panel" style="max-width:64ch">' +
      '<p>Everything here comes out of .replay files. Tyr writes one to your disk at the end of a ' +
      'match, and players upload them. There is no live game feed behind this and no official Tyr API.</p>' +
      '<p>That makes the picture <b>incomplete</b>. Only uploaded matches are here. If someone ' +
      'recorded a game you played in, your real numbers for it show up. If nobody did, that game ' +
      'does not exist as far as this site is concerned.</p>' +
      '<p>A match tagged <b>Unknown</b> instead of Elimination or Capture is fine. Every player, ' +
      'tank and score on it is real. The decoder could not tell which signal ended the match, and ' +
      'it would sooner say Unknown than guess.</p>' +
      '<h2 style="font-size:16px;margin:22px 0 6px">Who sees what</h2>' +
      '<p><b>Signed in players see everything about other players by default.</b> Signing in with ' +
      'Steam proves you are a real player and not an anonymous scraper. Two things stay hidden even ' +
      'from them: your Steam ID, unless you opt in to show it, and any individual stat you mark ' +
      '“hide from signed in too.”</p>' +
      '<p><b>Signed out visitors</b> see only the players who chose to be public.</p>' +
      '<h2 style="font-size:16px;margin:22px 0 6px">Your settings</h2>' +
      '<p>The gear at the top right is where you decide what others see of you.</p>' +
      '<ul style="margin:0 0 12px;padding-left:20px;line-height:1.7">' +
      '<li><b>Show my Steam ID</b> is off. It applies to every viewer, signed in ones included. ' +
      'Check it and people can see your raw ID.</li>' +
      '<li><b>Who can see you</b> set to <b>Signed in players only</b> hides you from signed out ' +
      'visitors completely.</li>' +
      '<li>Or stay on <b>Everyone</b> and hide things one at a time: clan tag, past names, ' +
      'who you play with, games, winrate, kills, damage, assist, blocked, survival time, tanks played, maps played, ' +
      'match history. <b>Hide everything from signed out visitors</b> does the lot at once and leaves ' +
      'your name listed.</li>' +
      '<li>Each of those has a second box, <b>hide from signed in too</b>. That is the one exception ' +
      'to “signed in sees everything”. Tick it on a stat, or tick <b>Hide everything from EVERYONE</b>, ' +
      'and no other player sees it either way. You always see your own data in full.</li>' +
      '</ul>' +
      '<p><a href="/auth/steam/login">Sign in via Steam</a> to see all of it and to set your own ' +
      'visibility.</p>' +
      "</div>";
  }

  // ---- popular tanks strip + steam chart (home page) ----

  function popularTanksStrip() {
    var tanks = DATA.popular_tanks || [];
    if (!tanks.length) return "";
    var cards = tanks.map(function (t) {
      var img = tankImgTag(t.tank_id, "tank-card-img");
      var pct = fmtPct(Math.round((t.pick_rate || 0) * 1000) / 10);
      return '<a class="tank-card" href="' + tankHref(t) + '">' +
        (img || '<div class="tank-card-img tank-card-img-empty"></div>') +
        '<div class="tank-card-name">' + esc(t.tank) + "</div>" +
        '<div class="tank-card-meta">' + fmtNum(t.games) + " games · " + pct + "</div>" +
        '<div class="tank-card-meta">' + fmtNum(t.avg.dmg) + " avg dmg</div>" +
        "</a>";
    }).join("");
    return '<div class="strip-label">Popular Tanks</div><div class="tank-strip">' + cards + "</div>";
  }

  // Chart is OFF for now (too few samples yet for the sparkline to mean
  // anything) -- tools/live_refresh.py keeps sampling every minute
  // regardless, so the moment this flips back on there's real history to
  // draw from. Flip to true to bring the chart back.
  var SHOW_STEAM_CHART = false;

  function steamChartSection() {
    var steam = DATA.steam;
    if (!steam || steam.latest === null || steam.latest === undefined) return "";
    var latest = steam.latest;
    var chart = "";
    if (SHOW_STEAM_CHART && steam.samples && steam.samples.length) {
      var samples = steam.samples;
      var counts = samples.map(function (s) { return s.count || 0; });
      var min = Math.min.apply(null, counts), max = Math.max.apply(null, counts);
      var range = (max - min) || 1;
      var w = 600, h = 60;
      var pts = samples.map(function (s, i) {
        var x = samples.length > 1 ? (i / (samples.length - 1)) * w : 0;
        var y = h - (((s.count || 0) - min) / range) * h;
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      chart = '<svg class="steam-chart" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none">' +
        '<defs><linearGradient id="steamGrad" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0%" stop-color="#42588d"></stop><stop offset="100%" stop-color="#65508a"></stop></linearGradient></defs>' +
        '<polyline points="' + pts + '" fill="none" stroke="url(#steamGrad)" stroke-width="2"></polyline>' +
        "</svg>";
    }
    return '<a class="panel steam-panel" id="steam-panel" href="#/online">' +
      '<div class="steam-head"><div class="strip-label" style="margin:0">Players online</div>' +
      '<div class="steam-latest">' + fmtNum(latest) + "</div></div>" + chart + "</a>";
  }

  // ---- players online (#/online) --------------------------------------
  //
  // The sparkline above carries 200 points, which is enough to show a shape
  // and nothing else. This page reads players_online.json instead: the full
  // recorded history, drawn against the playtest, ranked and patch windows it
  // happened inside. Steam publishes no history of its own, so everything
  // here came from our own sampling and the gaps are real.

  var ONLINE = null;

  var ONLINE_KIND = {
    // no fill: stated in text, never drawn as a band. See onlineChart.
    playtest: { name: "Playtest" },
    ranked: { fill: "rgba(160,107,255,0.30)", stroke: "rgba(160,107,255,0.75)", name: "Ranked queue" },
    patch: { stroke: "#c98b3a", name: "Patch" },
  };

  function onlineChart(d, events) {
    var W = 1240, H = 360, padL = 54, padR = 18, padT = 18, padB = 38;
    var t0 = d.first_unix, t1 = d.last_unix;
    var span = (t1 - t0) || 1;
    var maxC = Math.max(d.peak || 0, 1);
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var X = function (t) { return padL + ((t - t0) / span) * plotW; };
    var Y = function (c) { return padT + plotH - (c / maxC) * plotH; };

    // horizontal guides + count labels
    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var v = maxC * g / 4, gy = Y(v);
      grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) +
        '" y2="' + gy.toFixed(1) + '" stroke="rgba(255,255,255,0.07)" stroke-width="1"></line>' +
        '<text x="' + (padL - 8) + '" y="' + (gy + 4).toFixed(1) +
        '" text-anchor="end" class="chart-axis-label">' + fmtNum(Math.round(v)) + "</text>";
    }

    // Windows behind the line. The playtest is deliberately not one of them:
    // it ran unbroken across everything recorded here, so its rectangle came
    // out the full width of the chart and told the reader nothing. It is a
    // line of text under the chart instead.
    var bands = "";
    (events || []).forEach(function (e) {
      var k = ONLINE_KIND[e.kind];
      if (!k || !k.fill || e.start == null || e.end == null) return;
      var a = Math.max(e.start, t0), b = Math.min(e.end, t1);
      if (b <= a) return;
      // Three hours inside a month is under half a percent of the width. Give
      // each one a floor so a ranked window is something you can actually see.
      var bw = Math.max(X(b) - X(a), 4);
      bands += '<rect x="' + X(a).toFixed(1) + '" y="' + padT + '" width="' + bw.toFixed(1) +
        '" height="' + plotH + '" fill="' + k.fill + '" stroke="' + k.stroke +
        '" stroke-width="1" rx="1"><title>' +
        esc(e.label + "\n" + fmtDateTime(e.start)) + "</title></rect>";
    });

    // The line breaks wherever the collector stopped. online_history tags the
    // point after each real gap, because neither end can tell from the thinned
    // spacing alone: it is uneven by design, so guessing invented breaks in
    // stretches that recorded fine and missed the 12 day hole entirely.
    var segs = [], cur = [];
    (d.points || []).forEach(function (s) {
      if (s.brk && cur.length) { segs.push(cur); cur = []; }
      cur.push(s);
    });
    if (cur.length) segs.push(cur);

    var line = "";
    segs.forEach(function (seg) {
      if (seg.length < 2) return;
      var pts = seg.map(function (s) { return X(s.t).toFixed(1) + "," + Y(s.count).toFixed(1); }).join(" ");
      line += '<polyline points="' + pts + '" fill="none" stroke="url(#onlineGrad)" ' +
        'stroke-width="1.6" stroke-linejoin="round"></polyline>';
    });

    // patch markers
    var marks = "";
    (events || []).forEach(function (e) {
      if (e.kind !== "patch" || e.at == null || e.at < t0 || e.at > t1) return;
      var mx = X(e.at);
      marks += '<line x1="' + mx.toFixed(1) + '" y1="' + padT + '" x2="' + mx.toFixed(1) +
        '" y2="' + (padT + plotH) + '" stroke="' + ONLINE_KIND.patch.stroke +
        '" stroke-width="1.2" stroke-dasharray="3 3"></line>' +
        '<circle cx="' + mx.toFixed(1) + '" cy="' + (padT + 4) + '" r="3.4" fill="' +
        ONLINE_KIND.patch.stroke + '"><title>' + esc(e.label + "\n" + fmtDateTime(e.at)) +
        "</title></circle>";
    });

    // one label per day boundary, thinned so they cannot collide
    var axis = "";
    var dayMs = 86400, days = Math.max(1, Math.round(span / dayMs));
    var everyN = Math.ceil(days / 12);
    var startDay = new Date(t0 * 1000); startDay.setHours(0, 0, 0, 0);
    for (var dd = 0; dd <= days; dd += everyN) {
      var tt = Math.floor(startDay.getTime() / 1000) + dd * dayMs;
      if (tt < t0 || tt > t1) continue;
      var ax = X(tt);
      axis += '<line x1="' + ax.toFixed(1) + '" y1="' + (padT + plotH) + '" x2="' + ax.toFixed(1) +
        '" y2="' + (padT + plotH + 4) + '" stroke="rgba(255,255,255,0.25)" stroke-width="1"></line>' +
        '<text x="' + ax.toFixed(1) + '" y="' + (H - 12) +
        '" text-anchor="middle" class="chart-axis-label">' + esc(fmtDay(tt)) + "</text>";
    }

    return '<svg class="chart-svg online-chart" viewBox="0 0 ' + W + " " + H +
      '" preserveAspectRatio="xMidYMid meet">' +
      '<defs><linearGradient id="onlineGrad" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0%" stop-color="#4f7cff"></stop>' +
      '<stop offset="100%" stop-color="#a06bff"></stop></linearGradient></defs>' +
      grid + bands + line + marks + axis + "</svg>";
  }

  function onlineLegend() {
    function key(swatch, label) {
      return '<span class="ol-key">' + swatch + esc(label) + "</span>";
    }
    return '<div class="ol-legend small">' +
      key('<i class="ol-sw" style="background:rgba(160,107,255,0.30);border-color:rgba(160,107,255,0.75)"></i>', "Ranked queue") +
      key('<i class="ol-sw ol-sw-line"></i>', "Patch") +
      "</div>";
  }

  var onlineRange = "playtest";   // "playtest" | "all"

  function fmtMonth(unixSec) {
    return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  function onlineBody(d) {
    var s = d[onlineRange] || d.playtest || d.all;
    if (!s || !s.points || s.points.length < 2) return '<p class="small">No player history yet.</p>';

    var wide = onlineRange === "all";
    var pt = (d.events || []).filter(function (e) { return e.kind === "playtest"; })[0];
    var next = (d.events || []).filter(function (e) { return e.kind === "upcoming"; })[0];
    var head = "";
    if (pt && !wide) {
      var ext = (pt.extended || []).length;
      var over = pt.end && pt.end * 1000 < Date.now();
      head = '<p class="small" style="margin:-4px 0 10px">All of this is one playtest, ' +
        esc(fmtDay(pt.start)) + " to " + esc(fmtDay(pt.end)) +
        (ext ? ", extended " + (ext === 1 ? "once" : ext === 2 ? "twice" : fmtNum(ext) + " times") : "") +
        "." +
        // Without this the line simply stops and reads like a broken collector.
        (over ? " It has closed, so the line ends there rather than the counter failing." : "") +
        (next && next.at ? " The next one starts " + esc(fmtDay(next.at)) + "." : "") +
        "</p>";
    }

    var span = wide
      ? fmtMonth(s.first_unix) + " to " + fmtMonth(s.last_unix)
      : fmtDay(s.first_unix) + " to " + fmtDay(s.last_unix);

    var chips = '<div class="maplegend" style="margin-bottom:12px">' +
      '<button class="mchip' + (onlineRange === "playtest" ? "" : " off") +
      '" data-online="playtest" type="button">This playtest</button>' +
      '<button class="mchip' + (onlineRange === "all" ? "" : " off") +
      '" data-online="all" type="button">All time</button></div>';

    return chips + head + onlineLegend() + onlineChart(s, d.events) +
      '<p class="small" style="margin-top:10px">Peak ' + fmtNum(s.peak) + ". " + esc(span) + "." +
      (d.steamdb_samples
        ? " Our own counter samples every couple of minutes; SteamDB fills the stretches it missed."
        : "") +
      ((s.gaps || []).length
        ? " Breaks in the line are where neither had a number."
        : "") +
      "</p>";
  }

  function renderOnline() {
    APP.innerHTML =
      '<div class="page-head"><h1>Players online</h1></div>' +
      '<div class="panel" id="online-slot"><p class="small">Loading…</p></div>';

    function paint(d) {
      var slot = document.getElementById("online-slot");
      if (!slot) return;
      slot.innerHTML = onlineBody(d);
      slot.querySelectorAll("[data-online]").forEach(function (b) {
        b.addEventListener("click", function () {
          onlineRange = b.getAttribute("data-online");
          paint(d);
        });
      });
    }

    if (ONLINE) { paint(ONLINE); return; }
    var ticket = ++deepFill;
    loadJson("players_online.json").then(function (d) {
      if (ticket !== deepFill) return;
      var slot = document.getElementById("online-slot");
      if (!slot) return;
      if (!d || (!d.playtest && !d.all)) {
        slot.innerHTML = '<p class="small">No player history recorded yet.</p>';
        return;
      }
      ONLINE = d;
      paint(d);
    });
  }

  // ---- leaderboard ----

  var lbState = { key: "games", dir: "desc", q: "", minGames: 0, map: "", tank: "", build: "" };

  // Map/tank filters swap each row's games/avg for that map/tank's own
  // numbers (via playerRowsForFilters below) -- but winrate has no per-
  // map/tank equivalent (no per-scope win/loss is tracked), so it stays the
  // player's OVERALL figure. This caption is the only thing that makes that
  // non-obvious distinction clear.
  function lbFilterCaption() {
    if (!lbState.map && !lbState.tank) return "";
    var scope = lbState.map ? "map" : "tank";
    return '<p class="small" style="margin:-8px 0 12px">Games and averages are for this ' + scope +
      ' only. Winrate stays each player’s overall figure. There is no per-' + scope + ' version of it.</p>';
  }

  // A player's numbers for one game version, rebuilt from the per-match rows.
  // site_data carries career totals rather than a split per build, and doing
  // this here keeps that file the size it is. Per-map and per-tank entries are
  // built alongside so the map and tank filters keep working under a version.
  function playersForBuild(build) {
    var canon = {};
    (DATA.players || []).forEach(function (p) { if (p.id) canon[p.id] = p; });

    var agg = {};
    (DATA.matches || []).forEach(function (m) {
      if (matchBuild(m) !== build) return;
      var won = m.winning_team;
      (m.players || []).forEach(function (p) {
        var id = p.id || p.label;
        if (!id) return;
        var e = agg[id];
        if (!e) {
          var src = canon[p.id] || {};
          e = agg[id] = {
            id: p.id, label: p.label || src.label || "",
            short_id: p.short_id || src.short_id, clan: p.clan || src.clan,
            // carried from the canonical record, so a player's privacy choice
            // still applies to a row this function rebuilt
            hiddenFields: src.hiddenFields,
            games: 0, wins: 0, losses: 0, unknown: 0,
            dmg: 0, assist: 0, blocked: 0, kills: 0, surv: 0, survN: 0,
            maps: {}, tanks: {},
          };
        }
        e.games++;
        e.dmg += p.dmg || 0;
        e.assist += p.assist || 0;
        e.blocked += p.blocked || 0;
        e.kills += p.kills || 0;
        if (p.survival_pct != null && isFinite(p.survival_pct)) {
          e.surv += p.survival_pct; e.survN++;
        }
        if (won === null || won === undefined) e.unknown++;
        else if (p.team === won) e.wins++;
        else e.losses++;

        function bucket(store, key) {
          if (!key) return;
          var b = store[key] || (store[key] = { games: 0, dmg: 0, assist: 0, blocked: 0, kills: 0 });
          b.games++;
          b.dmg += p.dmg || 0;
          b.assist += p.assist || 0;
          b.blocked += p.blocked || 0;
          b.kills += p.kills || 0;
        }
        bucket(e.maps, m.map_slug);
        bucket(e.tanks, p.tank_id);
      });
    });

    function flatten(store, keyName, extra) {
      return Object.keys(store).map(function (k) {
        var b = store[k], row = { games: b.games, avg: {
          dmg: b.dmg / b.games, assist: b.assist / b.games,
          blocked: b.blocked / b.games, kills: b.kills / b.games } };
        row[keyName] = k;
        if (extra) extra(row, k);
        return row;
      });
    }

    return Object.keys(agg).map(function (k) {
      var e = agg[k], g = e.games || 1, decided = e.wins + e.losses;
      return {
        id: e.id, label: e.label, short_id: e.short_id, clan: e.clan,
        hiddenFields: e.hiddenFields,
        games: e.games, wins: e.wins, losses: e.losses, unknown_results: e.unknown,
        winrate: decided ? (e.wins / decided) * 100 : null,
        avg_survival_pct: e.survN ? e.surv / e.survN : null,
        avg: { dmg: e.dmg / g, assist: e.assist / g,
               blocked: e.blocked / g, kills: e.kills / g },
        maps: flatten(e.maps, "map_slug"),
        tanks: flatten(e.tanks, "tank_id"),
      };
    });
  }

  // The list the leaderboard is built from: everyone, or everyone as they
  // played on one version.
  function lbSourcePlayers() {
    return lbState.build ? playersForBuild(lbState.build) : (DATA.players || []);
  }

  // One line, only when a version is picked.
  function lbBuildCaption() {
    if (!lbState.build) return "";
    var e = null;
    buildList().forEach(function (x) { if (x.build === lbState.build) e = x; });
    if (!e) return "";
    return '<p class="small" style="margin:-8px 0 12px">Version ' + esc(e.build) +
      ", " + fmtNum(e.matches) + (e.matches === 1 ? " match" : " matches") +
      (buildSpan(e) ? ", " + esc(buildSpan(e)) : "") + ".</p>";
  }

  function playerRowsForFilters(players) {
    if (!lbState.map && !lbState.tank) return players;
    var out = [];
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      var entry = lbState.map
        ? findByKey(p.maps, "map_slug", lbState.map)
        : findByKey(p.tanks, "tank_id", lbState.tank);
      if (entry) out.push(withOverride(p, { games: entry.games, avg: entry.avg }));
    }
    return out;
  }

  function renderLeaderboard() {
    if (!DATA.players || !DATA.players.length) { renderEmptyState(); return; }
    var players = lbSourcePlayers();
    var maps = (DATA.maps || []).slice().sort(function (a, b) { return b.games - a.games; });
    var tanks = (DATA.tanks || []).slice().sort(function (a, b) { return b.games - a.games; });
    var mapOptions = maps.map(function (m) {
      return '<option value="' + esc(m.slug) + '"' + (lbState.map === m.slug ? " selected" : "") + ">" + esc(m.map) + "</option>";
    }).join("");
    var tankOptions = tanks.map(function (t) {
      return '<option value="' + esc(t.tank_id) + '"' + (lbState.tank === t.tank_id ? " selected" : "") + ">" + esc(t.tank) + "</option>";
    }).join("");

    APP.innerHTML =
      steamChartSection() +
      '<div class="page-head"><h1>Players</h1>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<input type="search" class="search-box" id="lb-search" placeholder="Search player name or ID…" value="' + esc(lbState.q) + '">' +
      '<input type="number" min="0" class="search-box" id="lb-min-games" placeholder="Min games" style="width:110px" value="' + (lbState.minGames || "") + '">' +
      '<select class="search-box" id="lb-build-filter"><option value="">All versions</option>' + buildOptions(lbState.build) + "</select>" +
      '<select class="search-box" id="lb-map-filter"><option value="">All maps</option>' + mapOptions + "</select>" +
      '<select class="search-box" id="lb-tank-filter"><option value="">All tanks</option>' + tankOptions + "</select>" +
      "</div></div>" +
      lbBuildCaption() +
      lbFilterCaption() +
      '<div class="panel"><div class="table-scroll"><table id="lb-table"><thead><tr>' +
      "<th>#</th><th>Player</th>" +
      '<th class="sortable" data-key="games">Games<span class="arrow"></span></th>' +
      '<th class="sortable" data-key="avg.dmg">Avg DMG<span class="arrow"></span></th>' +
      '<th class="sortable" data-key="avg.assist">Avg AST<span class="arrow"></span></th>' +
      '<th class="sortable" data-key="avg.blocked">Avg BLK<span class="arrow"></span></th>' +
      '<th class="sortable" data-key="avg.kills">Avg Kills<span class="arrow"></span></th>' +
      '</tr></thead><tbody id="lb-body"></tbody></table></div></div>';

    renderLeaderboardBody(players);

    document.getElementById("lb-search").addEventListener("input", function (e) {
      lbState.q = e.target.value;
      renderLeaderboardBody(players);
    });
    document.getElementById("lb-min-games").addEventListener("input", function (e) {
      lbState.minGames = parseInt(e.target.value, 10) || 0;
      renderLeaderboardBody(players);
    });
    document.getElementById("lb-build-filter").addEventListener("change", function (e) {
      lbState.build = e.target.value;
      renderLeaderboard(); // the whole page: rows, caption and both other filters
    });
    document.getElementById("lb-map-filter").addEventListener("change", function (e) {
      lbState.map = e.target.value;
      if (lbState.map) lbState.tank = "";
      renderLeaderboard(); // full re-render: caption + tank-select reset need to show
    });
    document.getElementById("lb-tank-filter").addEventListener("change", function (e) {
      lbState.tank = e.target.value;
      if (lbState.tank) lbState.map = "";
      renderLeaderboard();
    });
    var ths = APP.querySelectorAll("th.sortable");
    for (var i = 0; i < ths.length; i++) {
      ths[i].addEventListener("click", function () {
        var key = this.dataset.key;
        if (lbState.key === key) lbState.dir = lbState.dir === "desc" ? "asc" : "desc";
        else { lbState.key = key; lbState.dir = "desc"; }
        renderLeaderboardBody(players);
      });
    }
  }

  // Progressive rendering for the players table. LB_PAGE rows at a time,
  // extended when a sentinel row scrolls into view.
  var LB_PAGE = 60;
  var lbRows = [], lbShown = 0, lbObserver = null;

  function renderLbSlice(slice, startIndex) {
    return slice.map(function (p, i) {
      return "<tr>" +
        '<td class="rank num">' + (startIndex + i + 1) + "</td>" +
        "<td>" + playerLink(p.id, p.label, p.short_id) + "</td>" +
        '<td class="num">' + hideAware(p, "games", fmtNum(p.games)) + "</td>" +
        '<td class="num">' + hideAware(p, "damage", fmtNum(p.avg.dmg)) + "</td>" +
        '<td class="num">' + hideAware(p, "assist", fmtNum(p.avg.assist)) + "</td>" +
        '<td class="num">' + hideAware(p, "blocked", fmtNum(p.avg.blocked)) + "</td>" +
        '<td class="num">' + hideAware(p, "kills", fmtNum(p.avg.kills)) + "</td>" +
        "</tr>";
    }).join("");
  }

  function attachLbSentinel() {
    if (lbObserver) { lbObserver.disconnect(); lbObserver = null; }
    var body = document.getElementById("lb-body");
    if (!body || lbShown >= lbRows.length) return;
    var sentinel = document.createElement("tr");
    sentinel.id = "lb-sentinel";
    sentinel.innerHTML = '<td colspan="7" class="small" style="padding:14px;text-align:center;color:var(--dim)">' +
      "Loading more (" + fmtNum(lbShown) + " of " + fmtNum(lbRows.length) + ")…</td>";
    body.appendChild(sentinel);
    // no IntersectionObserver (very old browser): fall back to showing
    // everything rather than stranding the user with a partial list
    if (typeof IntersectionObserver !== "function") { showMoreLbRows(true); return; }
    lbObserver = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) showMoreLbRows(false);
    }, { rootMargin: "300px" });
    lbObserver.observe(sentinel);
  }

  function showMoreLbRows(all) {
    var body = document.getElementById("lb-body");
    if (!body) return;
    var sentinel = document.getElementById("lb-sentinel");
    if (sentinel) sentinel.remove();
    var next = all ? lbRows.length : Math.min(lbShown + LB_PAGE, lbRows.length);
    body.insertAdjacentHTML("beforeend", renderLbSlice(lbRows.slice(lbShown, next), lbShown));
    lbShown = next;
    attachLbSentinel();
  }

  function renderLeaderboardBody(players) {
    var scoped = playerRowsForFilters(players);
    var q = lbState.q.trim().toLowerCase();
    var minGames = lbState.minGames || 0;
    var rows = scoped.filter(function (p) {
      if ((p.games || 0) < minGames) return false;
      return !q || p.label.toLowerCase().indexOf(q) !== -1 || (p.id || "").toLowerCase().indexOf(q) !== -1;
    });
    var key = lbState.key, dir = lbState.dir;
    rows = rows.slice().sort(function (a, b) {
      var av = getPath(a, key), bv = getPath(b, key);
      var an = av === null || av === undefined, bn = bv === null || bv === undefined;
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });

    var body = document.getElementById("lb-body");
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="small" style="padding:20px;text-align:center">No players match these filters.</td></tr>';
    } else {
      // Render in chunks as the user scrolls instead of dumping 1600+ rows at
      // once: the full list is already in memory, this is purely about not
      // handing someone a wall of rows (and not building that much DOM up
      // front). lbPage resets on every filter/sort change via the caller.
      lbRows = rows;
      lbShown = Math.min(LB_PAGE, rows.length);
      body.innerHTML = renderLbSlice(rows.slice(0, lbShown), 0);
      attachLbSentinel();
      return;
    }

    var ths = document.querySelectorAll("#lb-table th.sortable");
    for (var j = 0; j < ths.length; j++) {
      var arrow = ths[j].querySelector(".arrow");
      arrow.textContent = ths[j].dataset.key === lbState.key ? (lbState.dir === "asc" ? " ▲" : " ▼") : "";
    }
  }

  // ---- player page ----

  // How much better/worse a player does in one tank than overall. Signed on
  // purpose -- "+1.4" reads as an edge, "1.4" reads as a rate.
  function wrDiffChip(diff) {
    if (diff == null) return "&mdash;";
    var color = diff > 0 ? "#35674a" : (diff < 0 ? "#8a4444" : "var(--dim)");
    return '<span style="color:' + color + ';font-weight:700">' +
      (diff > 0 ? "+" : "") + fmtNum(diff) + "%</span>";
  }

  // Who this player actually queues with, from the validated partyId (see
  // squadmates_by_player). Solo players have no partyId at all, so an empty
  // list genuinely means "always queues alone", not "no data".
  function squadmatesPanel(p) {
    if (isHidden(p, "squadmates")) return "";
    var mates = p.squadmates || [];
    if (!mates.length) return "";
    var rows = mates.map(function (m) {
      return "<tr><td>" + playerLink(m.id, m.label, m.short_id) + "</td>" +
        '<td class="num">' + fmtNum(m.games) + "</td></tr>";
    }).join("");
    return '<div class="panel"><h2>Plays with</h2><div class="table-scroll"><table><thead><tr>' +
      "<th>Player</th><th>Games together</th></tr></thead><tbody>" + rows +
      "</tbody></table></div></div>";
  }

  function renderPlayer(id) {
    var p = null;
    // #/player/<n> is normally the short, stable "first spotted" sequence
    // number (see playerLink's comment) -- try that first. Still accepts a
    // raw SteamID64 too (17 digits, so it never collides with a short id
    // in practice) so any link built before this existed keeps working.
    if (/^\d+$/.test(id)) {
      var shortNum = parseInt(id, 10);
      for (var i = 0; i < DATA.players.length; i++) { if (DATA.players[i].short_id === shortNum) { p = DATA.players[i]; break; } }
    }
    if (!p) {
      for (var j = 0; j < DATA.players.length; j++) { if (DATA.players[j].id === id) { p = DATA.players[j]; break; } }
    }
    if (!p) {
      APP.innerHTML =
        '<div class="panel not-found"><h2 style="border:none">Player not found</h2>' +
        '<p class="small">No player with ID <span class="mono">' + esc(id) + "</span>.</p>" +
        '<p><a href="#/players">&larr; Back to players</a></p></div>';
      return;
    }

    // Everything below keys off the player's REAL id (SteamID64), never the
    // route param: #/player/<n> passes a short id, which matches no match-row
    // id at all and silently emptied the whole match history.
    var pid = p.id;

    var matches = pid == null ? [] : DATA.matches.filter(function (m) {
      return m.players.some(function (mp) { return mp.id === pid; });
    }).sort(function (a, b) { return (b.captured_unix || 0) - (a.captured_unix || 0); });

    var tanksRows = p.tanks.length ? p.tanks.map(function (t) {
      return "<tr>" +
        '<td class="tank">' + tankCell(t.tank, t.tank_id) + "</td>" +
        '<td class="num">' + fmtNum(t.games) + "</td>" +
        '<td class="num">' + fmtPct(t.winrate) + "</td>" +
        '<td class="num">' + fmtNum(t.avg.dmg) + "</td>" +
        '<td class="num">' + fmtNum(t.avg.assist) + "</td>" +
        '<td class="num">' + fmtNum(t.avg.blocked) + "</td>" +
        '<td class="num">' + fmtNum(t.avg.kills) + "</td>" +
        '<td class="num">' + fmtClock(t.avg_survival_sec) + "</td>" +
        '<td class="num">' + fmtPct(t.avg_survival_pct) + "</td>" +
        '<td class="num">' + fmtNum(t.best_dmg) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="10" class="small">No tank data.</td></tr>';

    // Compact on purpose: clicking a row opens the full end-game report
    // (#/match/<id>), which already shows DMG/AST/BLK for every player -- no
    // need to repeat them here. Kept: date, map, result, tank, kills.
    var historyRows = matches.length ? matches.map(function (m) {
      var row = null;
      for (var k = 0; k < m.players.length; k++) { if (m.players[k].id === pid) { row = m.players[k]; break; } }
      var outcome = personalOutcome(m, pid);
      var mapCell = m.map ? mapImgTag(m.map, "map-thumb") + esc(m.map) : '<span class="small">UNKNOWN MAP</span>';
      var href = m.match_id ? "#/match/" + encodeURIComponent(m.match_id) : null;
      // map/tank cells link to their own general pages (#/map/<slug>,
      // #/tank/<slug>) -- the delegated row click-through below already
      // ignores clicks inside any <a>, so these take priority over the
      // row's default "open this match" navigation. The rest of the row
      // (date, result, kills) still opens the match.
      var mapLink = m.map_slug ? '<a href="#/map/' + encodeURIComponent(m.map_slug) + '">' + mapCell + "</a>" : mapCell;
      var tankLink = row && row.tank
        ? '<a href="#/tank/' + encodeURIComponent(slugify(row.tank_id || row.tank)) + '">' + tankCell(row.tank, row.tank_id) + "</a>"
        : "-";
      // full map art (assets/maps/<slug>.png -- the plain map, not the
      // tactical minimap) washed behind each row, tomato.gg style
      var bg = m.map_slug
        ? ' style="background-image:url(assets/maps/' + encodeURIComponent(m.map_slug) + '.png)"'
        : "";
      return '<tr class="history-row map-bg-row' + (href ? " clickable-row" : "") + '"' + bg +
        (href ? ' data-href="' + esc(href) + '"' : "") + ">" +
        "<td>" + esc(fmtDateTime(m.captured_unix)) + "</td>" +
        "<td>" + mapLink + "</td>" +
        "<td>" + personalChip(outcome) + "</td>" +
        '<td class="tank">' + tankLink + "</td>" +
        '<td class="num">' + fmtNum(row ? row.kills : null) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="5" class="small">No matches recorded.</td></tr>';

    // "aka" (past display names) is not produced by site_build yet — render only if present.
    var akaLine = (p.aka && p.aka.length && !isHidden(p, "pastNames")) ?
      '<div class="past-names small">Past names: ' + p.aka.map(esc).join(", ") + "</div>" : "";

    // Steam ID text is hidden by default for everyone (server-enforced, see
    // cloudflare/src/redact.js's hideUnshownSteamIds) unless the player
    // opted in via "Show my Steam ID" in settings -- p.steamIdRevealed says
    // so explicitly. NOT the same check as "is p.id present": a signed-in
    // viewer still gets a real p.id (so playerLink() elsewhere on the site
    // can route to this profile at all) even when it's not revealed here.
    var idBadge = p.steamIdRevealed
      ? '<button class="id-copy" id="copy-id" type="button" title="Click to copy full ID">' +
        '<span class="mono">' + esc(p.id) + "</span>" +
        '<span class="copied" id="copy-id-status"></span>' +
        "</button>"
      : '<span class="id-copy small" style="opacity:.55" title="Steam IDs are hidden by default; this player hasn’t chosen to show theirs">Steam ID hidden</span>';
    var tanksPanel = isHidden(p, "tanksWinrate")
      ? '<div class="panel"><h2>Tanks</h2><p class="small">' + hiddenLabel() + "</p></div>"
      : '<div class="panel"><h2>Tanks</h2><div class="table-scroll"><table><thead><tr>' +
        "<th>Tank</th><th>Games</th><th>Winrate</th><th>Avg DMG</th><th>Avg AST</th><th>Avg BLK</th><th>Avg Kills</th><th>Avg Survival</th><th>Surv %</th><th>Best DMG</th>" +
        "</tr></thead><tbody>" + tanksRows + "</tbody></table></div></div>";

    APP.innerHTML =
      '<div class="player-head"><div class="player-label">' + esc(p.label) + "</div>" +
      idBadge + akaLine + "</div>" +
      '<div class="stat-grid">' +
      '<div class="stat-card"><div class="label">Clan</div><div class="stat-value">' + hideAware(p, "clan", p.clan ? esc(p.clan) : '<span class="small" style="opacity:.55">None</span>') + "</div></div>" +
      '<div class="stat-card"><div class="label">Games</div><div class="stat-value num">' + hideAware(p, "games", fmtNum(p.games)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Ranked</div><div class="stat-value num">' +
        hideAware(p, "games", fmtNum(rankedGamesOf(p.id))) + "</div></div>" +
      '<div class="stat-card"><div class="label">Winrate</div><div class="stat-value num">' + hideAware(p, "winrate", fmtPct(p.winrate)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg DMG</div><div class="stat-value num">' + hideAware(p, "damage", fmtNum(p.avg.dmg)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg Assist</div><div class="stat-value num">' + hideAware(p, "assist", fmtNum(p.avg.assist)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg Blocked</div><div class="stat-value num">' + hideAware(p, "blocked", fmtNum(p.avg.blocked)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg Kills</div><div class="stat-value num">' + hideAware(p, "kills", fmtNum(p.avg.kills)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg Survival</div><div class="stat-value num">' + hideAware(p, "survival", fmtClock(p.avg_survival_sec)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Survival %</div><div class="stat-value num">' + hideAware(p, "survival", fmtPct(p.avg_survival_pct)) + "</div></div>" +
      "</div>" +
      squadmatesPanel(p) +
      '<div class="panel"><h2>Career totals</h2><div class="stat-grid">' +
      '<div class="stat-card"><div class="label">Total DMG</div><div class="stat-value num">' + hideAware(p, "damage", fmtNum(p.total.dmg)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Total Assist</div><div class="stat-value num">' + hideAware(p, "assist", fmtNum(p.total.assist)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Total Blocked</div><div class="stat-value num">' + hideAware(p, "blocked", fmtNum(p.total.blocked)) + "</div></div>" +
      '<div class="stat-card"><div class="label">Total Kills</div><div class="stat-value num">' + hideAware(p, "kills", fmtNum(p.total.kills)) + "</div></div>" +
      "</div></div>" +
      tanksPanel +
      '<div class="panel"><h2>Match history</h2><div class="table-scroll"><table id="history-table"><thead><tr>' +
      "<th>Date</th><th>Map</th><th>Result</th><th>Tank</th><th>Kills</th>" +
      "</tr></thead><tbody>" + historyRows + "</tbody></table></div></div>";

    var copyBtn = document.getElementById("copy-id");
    if (copyBtn) copyBtn.addEventListener("click", function () { copyId(p.id); });

    // whole row navigates to the full end-game report; a click on the
    // nested map/tank links goes to THEIR OWN pages instead (the "e.target
    // .closest('a')" bail-out below lets any real <a> inside the row win).
    var historyTable = document.getElementById("history-table");
    if (historyTable) historyTable.addEventListener("click", function (e) {
      if (e.target.closest("a")) return;
      var tr = e.target.closest("tr[data-href]");
      if (tr) location.hash = tr.dataset.href;
    });
  }

  // ---- matches page (list; each row links to its full #/match/<id> page) ----

  function rosterTable(title, rows, rowClass) {
    var body = rows.length ? rows.map(function (p) {
      var tank = p.tank
        ? '<a href="#/tank/' + encodeURIComponent(slugify(p.tank_id || p.tank)) + '">' + tankCell(p.tank, p.tank_id) + "</a>"
        : tankCell(p.tank, p.tank_id);
      return '<tr class="' + rowClass + '">' +
        "<td>" + playerLink(p.id, p.label, p.short_id) + "</td>" +
        '<td class="tank">' + tank + "</td>" +
        '<td class="num">' + fmtNum(p.kills) + "</td>" +
        '<td class="num">' + fmtNum(p.dmg) + "</td>" +
        '<td class="num">' + fmtNum(p.assist) + "</td>" +
        '<td class="num">' + fmtNum(p.blocked) + "</td>" +
        '<td class="num">' + fmtClock(p.survival_sec) + "</td>" +
        '<td class="num">' + fmtPct(p.survival_pct) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="8" class="small">No players.</td></tr>';
    return "<h4>" + esc(title) + '</h4><div class="table-scroll"><table class="roster-table">' +
      '<colgroup><col class="c-player"><col class="c-tank"><col class="c-stat"><col class="c-stat"><col class="c-stat"><col class="c-stat"><col class="c-stat"><col class="c-stat"></colgroup>' +
      "<thead><tr><th>Player</th><th>Tank</th><th>Kills</th><th>DMG</th><th>AST</th><th>BLK</th><th>Survival</th><th>Surv %</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  // deathEvents come from the per-match deep-data file (site/matches/<id>.json,
  // see tools/replay_site.py); "match" (the lightweight site_data.json record)
  // supplies the name->id lookup so killer/victim can link to their profile.
  // Match Pulse: both teams' health pools over the match as filled lines, with
  // every kill marked on the line of the team that LOST the tank. One picture
  // of how the match actually went -- a slow bleed, a sudden collapse, or a
  // comeback -- from teamHealthSeries, which the decoder already produced but
  // nothing rendered.
  function matchPulsePanel(deep) {
    if (!PREVIEW_FEATURES) return "";
    var m = deep.match || {};
    var ths = m.teamHealthSeries || {};
    var a = ths["0"] || [], b = ths["1"] || [];
    if (a.length < 2 && b.length < 2) return "";
    var dur = m.durationSec || Math.max(
      a.length ? a[a.length - 1][0] : 0, b.length ? b[b.length - 1][0] : 0) || 1;

    var W = 900, H = 300, padL = 44, padR = 16, padT = 16, padB = 34;
    var iw = W - padL - padR, ih = H - padT - padB;
    var X = function (t) { return padL + Math.max(0, Math.min(1, t / dur)) * iw; };
    var Y = function (v) { return padT + (1 - Math.max(0, Math.min(100, v)) / 100) * ih; };

    var parts = [];
    // horizontal gridlines every 25%
    for (var g = 0; g <= 100; g += 25) {
      parts.push('<line x1="' + padL + '" y1="' + Y(g).toFixed(1) + '" x2="' + (W - padR) +
        '" y2="' + Y(g).toFixed(1) + '" stroke="rgba(255,255,255,.07)" stroke-width="1"/>');
      parts.push('<text class="chart-axis-label" x="' + (padL - 8) + '" y="' + (Y(g) + 3).toFixed(1) +
        '" text-anchor="end">' + g + "%</text>");
    }
    // time axis ticks at quarters of the match
    for (var q = 0; q <= 4; q++) {
      var tt = (dur * q) / 4;
      parts.push('<text class="chart-axis-label" x="' + X(tt).toFixed(1) + '" y="' + (H - 10) +
        '" text-anchor="middle">' + fmtClock(tt) + "</text>");
    }

    [[a, TEAM_HEX[0], "Team A"], [b, TEAM_HEX[1], "Team B"]].forEach(function (spec) {
      var series = spec[0], color = spec[1];
      if (series.length < 2) return;
      var d = series.map(function (p, i) {
        return (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1);
      }).join(" ");
      // fill down to the baseline so the two pools read as volumes, not just lines
      var fill = d + " L" + X(series[series.length - 1][0]).toFixed(1) + " " + Y(0).toFixed(1) +
        " L" + X(series[0][0]).toFixed(1) + " " + Y(0).toFixed(1) + " Z";
      parts.push('<path d="' + fill + '" fill="' + color + '" opacity="0.13"/>');
      parts.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.5" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>');
    });

    var legend = '<div class="chart-legend">' +
      '<span class="chart-legend-item"><span class="chart-legend-dot" style="background:' + TEAM_HEX[0] + '"></span>Team A health</span>' +
      '<span class="chart-legend-item"><span class="chart-legend-dot" style="background:' + TEAM_HEX[1] + '"></span>Team B health</span>' +
      "</div>";

    return '<div class="panel"><h2>Team health</h2>' + legend +
      '<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">' +
      parts.join("") + "</svg>" +
      '<div class="small" style="margin-top:8px">Each team’s shared health pool over the match. ' +
      "A team loses when its pool hits zero.</div></div>";
  }

  function killFeedPanel(deep, match) {
    var events = deep && deep.deathEvents;
    if (!events || !events.length) return "";
    var nameToId = {}, nameToShortId = {};
    (match.players || []).forEach(function (p) { nameToId[p.label] = p.id; nameToShortId[p.label] = p.short_id; });
    function who(name, tank, tankId) {
      // "no killer resolved" is mislabeled as an environmental death in
      // earlier builds -- in practice it's almost always the decoder
      // failing to capture that death's Instigator field (a real, ~15% per
      // match rate on this net-stream, not rare "fell off a cliff" deaths),
      // so the honest label is "Unknown", not "Environment".
      if (!name) return '<span class="small" title="The decoder could not determine who got this kill">Unknown</span>';
      var label = playerLink(nameToId[name], name, nameToShortId[name]); // playerLink already falls back to plain text for a null/missing id
      if (!tank) return label;
      var tankBit = tankId
        ? '<a href="#/tank/' + encodeURIComponent(slugify(tankId)) + '">' + esc(tank) + "</a>"
        : esc(tank);
      return label + ' <span class="small">(' + tankBit + ")</span>";
    }
    var rows = events.map(function (e) {
      return "<tr>" +
        '<td class="mono small">' + fmtClock(e.t) + "</td>" +
        "<td>" + who(e.killer, e.killerTank, e.killerTankId) + "</td>" +
        '<td class="small">&rarr;</td>' +
        "<td>" + who(e.victim, e.victimTank, e.victimTankId) + "</td>" +
        // Gap between the two tanks when the kill landed, from both
        // trajectories. Blank when either side had no position near that
        // second, which is most kills on a player the recorder never saw.
        '<td class="small num" title="How far apart the two tanks were">' +
          (e.rangeM != null ? fmtNum(e.rangeM) + " m" : "") + "</td>" +
        "</tr>";
    }).join("");
    return '<div class="panel"><h3 style="margin-top:0">Kill Feed</h3>' +
      '<div class="table-scroll"><table><tbody>' + rows + "</tbody></table></div></div>";
  }

  // One lane per player, running left to right for the length of the match,
  // ending where that tank died. Arrows point from the killer's lane to the
  // moment they got the kill, so a whole match reads as one picture: who went
  // first, who traded, who was left standing.
  // tracks carry the internal codename (Bush, CanOpener); site_data carries
  // the display name and slug. Match them through the slug, which is the one
  // field both agree on.
  var TANK_CODE_MAP = null;
  // A single match against what a match here usually looks like. Scaled to the
  // busiest match on record rather than to percentiles, so a quiet game reads
  // as a small shape instead of being stretched to fill the web.
  // Damage taken is on no scoreboard, but every player's health trace is in
  // the deep view and the sum of its downward steps is exactly what they ate.
  // Health only ever falls from damage, so an upward step is a repair, which
  // is the only place on this site healing is recorded at all.
  function scoreText(m) {
    if (m.score_ally === null || m.score_ally === undefined ||
        m.score_enemy === null || m.score_enemy === undefined) return "-";
    return fmtNum(m.score_ally) + " : " + fmtNum(m.score_enemy);
  }

  // reused by the Matches page and each per-map page's "matches on this map" list
  function matchesTableHtml(matches, emptyLabel) {
    if (!matches.length) {
      return '<div class="panel empty-state"><div class="big">No matches yet</div>' +
        '<div class="sub">' + esc(emptyLabel || "Upload a replay to see it here.") + "</div></div>";
    }
    var rows = matches.map(function (m) {
      // map cell -> that map's general aggregate page; "Details" -> this
      // specific match's page. Two different destinations, kept distinct.
      // Details is dropped entirely when match-detail pages are hidden
      // (SHOW_PLAYER_PAGES=false) -- it would otherwise be a dead link.
      var mapHref = m.map_slug ? "#/map/" + encodeURIComponent(m.map_slug) : null;
      var mapCell = '<span class="tank-cell">' + mapImgTag(m.map, "map-thumb") +
        "<span>" + (m.map ? esc(m.map) : "UNKNOWN MAP") + "</span></span>";
      var detailsCell = SHOW_PLAYER_PAGES
        ? '<td><a href="#/match/' + encodeURIComponent(m.match_id) + '">Details &rarr;</a></td>'
        : "";
      return '<tr class="match-row">' +
        "<td>" + esc(fmtDateTime(m.captured_unix)) + "</td>" +
        "<td>" + (mapHref ? '<a class="match-link" href="' + mapHref + '">' + mapCell + "</a>" : mapCell) + "</td>" +
        "<td>" + resultChip(m.win_type) + "</td>" +
        '<td class="num">' + scoreText(m) + "</td>" +
        '<td class="num">' + fmtNum(m.players.length) + "</td>" +
        "<td>" + typeChip(m) + "</td>" +
        detailsCell +
        "</tr>";
    }).join("");
    return '<div class="panel"><div class="table-scroll"><table><thead><tr>' +
      "<th>Date</th><th>Map</th><th>Result</th><th>Final HP</th><th>Players</th><th>Type</th>" +
      (SHOW_PLAYER_PAGES ? "<th></th>" : "") +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  // ---- matches -------------------------------------------------------
  //
  // A grid of boxes rather than a table. Every control below narrows the same
  // list, and the count under the heading is what survived, so an empty grid
  // is always explained by the controls above it.

  var mState = { q: "", build: "", map: "", mode: "", from: "", to: "", sort: "date-desc" };

  var M_PAGE = 24;
  var mRows = [], mShown = 0, mObserver = null;

  // Everything a free-text search should be able to find in one string.
  function matchHaystack(m) {
    if (m._hay) return m._hay;
    var bits = [m.map || "", matchBuild(m), m.type || ""];
    (m.uploaded_by || []).forEach(function (u) { bits.push(u); });
    (m.recorded_by || []).forEach(function (u) { bits.push(u); });
    (m.players || []).forEach(function (p) {
      bits.push(p.label || "");
      if (p.clan) bits.push(p.clan);
      if (p.tank) bits.push(p.tank);
    });
    m._hay = bits.join(" ").toLowerCase();
    return m._hay;
  }

  // "YYYY-MM-DD" from a date input -> unix seconds, local midnight.
  function dayStart(s) {
    if (!s) return null;
    var p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!p) return null;
    return new Date(+p[1], +p[2] - 1, +p[3], 0, 0, 0).getTime() / 1000;
  }

  function matchModeOf(m) {
    if (m.type === "RANKED") return "ranked";
    if (m.type ? m.type === "CUSTOM" : !!m.is_custom) return "custom";
    return "standard";
  }

  function matchesForState() {
    var q = mState.q.trim().toLowerCase();
    var from = dayStart(mState.from);
    var to = dayStart(mState.to);
    if (to != null) to += 86400;   // "to" is inclusive of that whole day
    var out = ((DATA && DATA.matches) || []).filter(function (m) {
      if (mState.build && matchBuild(m) !== mState.build) return false;
      if (mState.map && m.map_slug !== mState.map) return false;
      if (mState.mode && matchModeOf(m) !== mState.mode) return false;
      var t = m.captured_unix || 0;
      if (from != null && t < from) return false;
      if (to != null && t >= to) return false;
      if (q && matchHaystack(m).indexOf(q) === -1) return false;
      return true;
    });
    var s = mState.sort;
    out.sort(function (a, b) {
      if (s === "date-asc") return (a.captured_unix || 0) - (b.captured_unix || 0);
      if (s === "length-desc") return (b.duration_sec || 0) - (a.duration_sec || 0);
      if (s === "length-asc") return (a.duration_sec || 0) - (b.duration_sec || 0);
      if (s === "version-desc") {
        var d = (+matchBuild(b) || 0) - (+matchBuild(a) || 0);
        return d || (b.captured_unix || 0) - (a.captured_unix || 0);
      }
      return (b.captured_unix || 0) - (a.captured_unix || 0);
    });
    return out;
  }

  function matchCard(m) {
    var href = SHOW_PLAYER_PAGES ? "#/match/" + encodeURIComponent(m.match_id) : null;
    // Who this match came from. Most of the archive was copied off the site
    // owner's own disk rather than uploaded, so "from <name>" appeared on some
    // cards and nothing at all on the rest, which read as missing data. Fall
    // back to who recorded it (see _attach_recorders) so every card says where
    // it came from, and keep the two wordings distinct because they are
    // different claims.
    var uploader = (m.uploaded_by || [])[0];
    var recorder = uploader ? null : (m.recorded_by || [])[0];
    var len = fmtDuration(m.duration_sec);
    var meta = [];
    if (len) meta.push('<span class="mc-meta-item">' + esc(len) + "</span>");
    meta.push('<span class="mc-meta-item">' + fmtNum((m.players || []).length) + " players</span>");
    if (matchBuild(m)) meta.push('<span class="mc-meta-item">v' + esc(matchBuild(m)) + "</span>");

    var inner =
      '<div class="mc-top">' + mapImgTag(m.map, "mc-thumb") +
        '<div class="mc-head"><div class="mc-map">' + esc(m.map || "Unknown map") + "</div>" +
        '<div class="mc-when">' + esc(fmtDateTime(m.captured_unix)) + "</div></div>" +
        '<div class="mc-type">' + typeChip(m) + "</div></div>" +
      '<div class="mc-mid">' + resultChip(m.win_type) +
        '<span class="mc-score" title="Final HP, both teams">' + scoreText(m) + "</span></div>" +
      '<div class="mc-foot">' + meta.join("") +
        (uploader
          ? '<span class="mc-up">from ' + esc(uploader) + "</span>"
          : recorder
            ? '<span class="mc-up" title="Recorded on this machine, not uploaded">recorded by ' +
              esc(recorder) + "</span>"
            : "") +
      "</div>";
    return href
      ? '<a class="match-card" href="' + href + '">' + inner + "</a>"
      : '<div class="match-card">' + inner + "</div>";
  }

  function renderMatchGrid() {
    var grid = document.getElementById("m-grid");
    var head = document.getElementById("m-count");
    if (!grid) return;
    mRows = matchesForState();
    mShown = 0;
    grid.innerHTML = "";
    if (head) {
      head.textContent = mRows.length === 1 ? "1 match" : fmtNum(mRows.length) + " matches";
    }
    if (!mRows.length) {
      grid.innerHTML = '<div class="panel empty-state" style="grid-column:1/-1">' +
        '<div class="big">Nothing matches those filters</div>' +
        '<div class="sub">Widen the search or clear a filter.</div></div>';
      return;
    }
    showMoreMatches(false);
  }

  function attachMatchSentinel() {
    if (mObserver) { mObserver.disconnect(); mObserver = null; }
    var grid = document.getElementById("m-grid");
    if (!grid || mShown >= mRows.length) return;
    var s = document.createElement("div");
    s.id = "m-sentinel";
    s.className = "mc-more";
    s.textContent = "Loading more (" + fmtNum(mShown) + " of " + fmtNum(mRows.length) + ")…";
    grid.appendChild(s);
    if (typeof IntersectionObserver !== "function") { showMoreMatches(true); return; }
    mObserver = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) showMoreMatches(false);
    }, { rootMargin: "300px" });
    mObserver.observe(s);
  }

  function showMoreMatches(all) {
    var grid = document.getElementById("m-grid");
    if (!grid) return;
    var s = document.getElementById("m-sentinel");
    if (s) s.remove();
    var next = all ? mRows.length : Math.min(mShown + M_PAGE, mRows.length);
    grid.insertAdjacentHTML("beforeend", mRows.slice(mShown, next).map(matchCard).join(""));
    mShown = next;
    attachMatchSentinel();
  }

  function renderMatches() {
    if (!DATA.matches || !DATA.matches.length) { renderEmptyState(); return; }

    var maps = (DATA.maps || []).slice().sort(function (a, b) { return b.games - a.games; });
    var mapOptions = maps.map(function (m) {
      return '<option value="' + esc(m.slug) + '"' +
        (mState.map === m.slug ? " selected" : "") + ">" + esc(m.map) + "</option>";
    }).join("");

    // Only offer a mode that exists in the archive.
    var modes = {};
    (DATA.matches || []).forEach(function (m) { modes[matchModeOf(m)] = true; });
    var modeOptions = [["standard", "Standard"], ["ranked", "Ranked"], ["custom", "Custom"]]
      .filter(function (p) { return modes[p[0]]; })
      .map(function (p) {
        return '<option value="' + p[0] + '"' +
          (mState.mode === p[0] ? " selected" : "") + ">" + p[1] + "</option>";
      }).join("");

    var sorts = [["date-desc", "Newest first"], ["date-asc", "Oldest first"],
                 ["version-desc", "Version"], ["length-desc", "Longest"],
                 ["length-asc", "Shortest"]];

    APP.innerHTML =
      '<div class="page-head"><h1>Matches</h1><div class="m-count" id="m-count"></div></div>' +
      '<div class="m-controls">' +
        '<input type="search" class="search-box m-search" id="m-q" placeholder="Search player, clan, map or uploader…" value="' + esc(mState.q) + '">' +
        '<select class="search-box" id="m-build"><option value="">All versions</option>' + buildOptions(mState.build) + "</select>" +
        '<select class="search-box" id="m-map"><option value="">All maps</option>' + mapOptions + "</select>" +
        (modeOptions ? '<select class="search-box" id="m-mode"><option value="">All modes</option>' + modeOptions + "</select>" : "") +
        '<label class="m-date">From <input type="date" class="search-box" id="m-from" value="' + esc(mState.from) + '"></label>' +
        '<label class="m-date">To <input type="date" class="search-box" id="m-to" value="' + esc(mState.to) + '"></label>' +
        '<select class="search-box" id="m-sort">' + sorts.map(function (p) {
          return '<option value="' + p[0] + '"' + (mState.sort === p[0] ? " selected" : "") + ">" + p[1] + "</option>";
        }).join("") + "</select>" +
        '<button class="mchip" id="m-reset" type="button">Reset</button>' +
      "</div>" +
      '<div class="match-grid" id="m-grid"></div>';

    renderMatchGrid();

    function bind(id, ev, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    }
    bind("m-q", "input", function (e) { mState.q = e.target.value; renderMatchGrid(); });
    bind("m-build", "change", function (e) { mState.build = e.target.value; renderMatchGrid(); });
    bind("m-map", "change", function (e) { mState.map = e.target.value; renderMatchGrid(); });
    bind("m-mode", "change", function (e) { mState.mode = e.target.value; renderMatchGrid(); });
    bind("m-from", "change", function (e) { mState.from = e.target.value; renderMatchGrid(); });
    bind("m-to", "change", function (e) { mState.to = e.target.value; renderMatchGrid(); });
    bind("m-sort", "change", function (e) { mState.sort = e.target.value; renderMatchGrid(); });
    bind("m-reset", "click", function () {
      mState = { q: "", build: "", map: "", mode: "", from: "", to: "", sort: "date-desc" };
      renderMatches();
    });
  }

  // ---- full match page (#/match/<id>) ----

  // Detail pages fill a slot from a second fetch. The slot ids are the same
  // strings on every match and every map, so "is the slot still there" is not
  // a guard: open one match, click straight to another, and the first
  // response lands in the second page's slots. It showed the wrong duration,
  // heatmap and kill feed under the right heading, with no error. Every
  // render takes a ticket; a fill whose ticket is stale drops its result.
  var deepFill = 0;

  function findMatch(id) {
    var list = (DATA && DATA.matches) || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].match_id) === id) return list[i];
    }
    return null;
  }

  // Back link for a match page. Returns you to the profile you came from
  // when that is where you came from, and to the match list otherwise.
  function backFromMatch() {
    var m = /^#\/player\/([^/?]+)/.exec(prevHash || "");
    if (m) {
      var who = null;
      var pid = decodeURIComponent(m[1]);
      (DATA.players || []).forEach(function (p) {
        if (String(p.short_id) === pid || String(p.id) === pid) who = p;
      });
      var label = who && who.label ? who.label : "player";
      // Both links, because either can be the one you want. You arrived from a
      // profile, but this page also links out to tanks and maps, and after
      // following one of those a single back link no longer matched where you
      // actually started.
      return '<p class="backnav"><a href="' + esc(prevHash) + '">&larr; Back to ' +
        esc(label) + '</a><a href="#/matches">Go to matches</a></p>';
    }
    return '<p class="backnav"><a href="#/matches">&larr; Back to matches</a></p>';
  }

  function renderMatch(id) {
    var m = findMatch(id);
    if (!m) {
      APP.innerHTML =
        '<div class="panel not-found"><h2 style="border:none">Match not found</h2>' +
        '<p class="small">No match with ID <span class="mono">' + esc(id) + "</span>.</p>" +
        '<p><a href="#/matches">&larr; Back to matches</a></p></div>';
      return;
    }
    // Team A = team id 0, Team B = team id 1 -- a stable, non-relative split
    // (unlike "side", which is phrased relative to whoever recorded the
    // replay and flips between matches).
    var teamA = m.players.filter(function (p) { return p.team === 0; });
    var teamB = m.players.filter(function (p) { return p.team === 1; });
    var others = m.players.filter(function (p) { return p.team !== 0 && p.team !== 1; });

    // Credit whoever sent this match in. A list, because two players on
    // opposite teams can each upload their own recording of the same match,
    // and that pairing is exactly what gets it corroborated.
    var upBy = m.uploaded_by || [];
    var recBy = m.recorded_by || [];
    var credit = "";
    if (upBy.length) {
      credit = ' &middot; <span class="match-credit">Uploaded by ' +
        upBy.map(esc).join(" and ") + "</span>";
    } else if (recBy.length) {
      credit = ' &middot; <span class="match-credit">Recorded by ' +
        recBy.map(esc).join(" and ") + "</span>";
    }

    APP.innerHTML =
      '<div class="page-head"><h1>' + (m.map ? esc(m.map) : "Unknown map") + "</h1>" +
      '<div class="small">' + esc(fmtDateTime(m.captured_unix, true)) +
      ' &middot; <span class="mono">' + esc(m.match_id) + "</span>" + credit + "</div></div>" +
      '<div class="match-head panel"><div class="match-head-row">' +
      mapImgTag(m.map, "match-head-map") +
      '<div class="match-head-facts">' +
      "<div>" + resultChip(m.win_type) + " " + typeChip(m) + "</div>" +
      (m.win_type ? "" :
        '<div class="small" style="margin-top:4px;color:var(--dim)">The decoder could not confirm ' +
        "how this match ended. The rest of the data is real.</div>") +
      '<div class="score" style="margin-top:6px">Final HP ' + scoreText(m) + "</div>" +
      '<div class="small" style="margin-top:6px">' + teamA.length + " v " + teamB.length +
      ' &middot; <span id="match-duration">-</span></div>' +
      '<div style="margin-top:10px">' +
      '<a class="replay-dl" href="replays/' + encodeURIComponent(m.match_id) +
      '.replay" download="' + esc(slugify(m.map || "match")) + "-" + esc(m.match_id) + '.replay">' +
      "&#11015; Download replay</a>" +
      "</div>" +
      "</div></div></div>" +
      '<div class="roster-wrap panel">' +
      rosterTable("Team A", teamA, "side-a") +
      rosterTable("Team B", teamB, "side-b") +
      (others.length ? rosterTable("Other", others, "") : "") +
      "</div>" +
      '<div id="match-pulse-slot"></div>' +
      '<div id="match-map-slot"><div class="panel"><p class="small">Loading map…</p></div></div>' +
      '<div id="match-kills-slot"></div>' +
      backFromMatch() + "";

    // deep per-match data (heat/shots + calibration + kill feed) -> map + kills panels
    var ticket = ++deepFill;
    loadJson("matches/" + encodeURIComponent(m.match_id) + ".json").then(function (deep) {
      // the user may have navigated away, or on to another match, while the
      // fetch was in flight
      if (ticket !== deepFill) return;
      var slot = document.getElementById("match-map-slot");
      if (!slot) return;
      if (!deep) {
        slot.innerHTML = '<div class="panel"><p class="small">No map data for this match yet.</p></div>';
        return;
      }
      var dur = document.getElementById("match-duration");
      if (dur && deep.match && deep.match.durationSec) dur.textContent = fmtClock(deep.match.durationSec);
      var pulseSlot = document.getElementById("match-pulse-slot");
      if (pulseSlot) {
        pulseSlot.innerHTML = matchPulsePanel(deep);
      }
      slot.innerHTML = mapPanel(deep);
      initMapPanel(deep);
      var killSlot = document.getElementById("match-kills-slot");
      if (killSlot) killSlot.innerHTML = killFeedPanel(deep, m);
    });
  }

  // ---- best battles: the single best individual-match performance by any
  // player, per stat category -- NOT an average (that's the leaderboard's
  // job). DATA.best_battles.{dmg,kills,assist,blocked} are pre-sorted,
  // pre-capped lists built at build time (tools/replay_to_site.py's
  // aggregate()), so this is just picking a category and rendering rows,
  // no client-side scanning of every match. ----

  var BEST_BATTLE_CATEGORIES = [
    { key: "dmg", label: "Damage" },
    { key: "kills", label: "Kills" },
    { key: "assist", label: "Assist" },
    { key: "blocked", label: "Blocked" },
  ];
  var bbState = { key: "dmg" };

  function renderBestBattles() {
    var tabs = BEST_BATTLE_CATEGORIES.map(function (c) {
      return '<button class="mchip' + (c.key === bbState.key ? "" : " off") + '" data-bb-key="' + c.key + '">' + esc(c.label) + "</button>";
    }).join("");
    APP.innerHTML =
      '<div class="page-head"><h1>Best Battles</h1></div>' +
      '<p class="small" style="margin:-8px 0 12px">One player, one match, the highest anyone has gone in each category.</p>' +
      '<div class="maplegend" id="bb-tabs" style="margin-bottom:14px">' + tabs + "</div>" +
      '<div class="panel"><div class="table-scroll"><table><thead><tr>' +
      '<th>#</th><th>Player</th><th>Tank</th><th>Map</th><th>Date</th><th>Result</th>' +
      '<th class="num">DMG</th><th class="num">Kills</th><th class="num">AST</th>' +
      '<th class="num">BLK</th><th class="num">Survival</th><th class="num">Surv %</th>' +

      "</tr></thead><tbody id=\"bb-body\"></tbody></table></div></div>";

    document.getElementById("bb-tabs").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-bb-key]");
      if (!btn || btn.dataset.bbKey === bbState.key) return;
      bbState.key = btn.dataset.bbKey;
      renderBestBattles(); // list is capped at 100 rows server-side -- a full re-render is cheap
    });
    renderBestBattlesBody();
  }

  function renderBestBattlesBody() {
    var cat = BEST_BATTLE_CATEGORIES.filter(function (c) { return c.key === bbState.key; })[0];
    var rows = (DATA.best_battles && DATA.best_battles[bbState.key]) || [];
    var body = document.getElementById("bb-body");
    body.innerHTML = rows.length ? rows.map(function (r, i) {
      var mapLink = r.map_slug
        ? '<a href="#/map/' + encodeURIComponent(r.map_slug) + '">' + esc(r.map || "?") + "</a>"
        : esc(r.map || "-");
      // A private row keeps its numbers and loses the match link, the date and
      // the result, so nothing here leads back to the person. See
      // BEST_BATTLE_KEEP_FIELDS in cloudflare/src/redact.js.
      var dateCell = r.match_id
        ? '<a href="#/match/' + encodeURIComponent(r.match_id) + '">' + esc(fmtDateTime(r.captured_unix)) + "</a>"
        : (r.captured_unix == null
            ? '<span class="dim">-</span>'
            : esc(fmtDateTime(r.captured_unix)));
      var bg = r.map_slug
        ? ' style="background-image:url(assets/maps/' + encodeURIComponent(r.map_slug) + '.png)"'
        : "";
      return '<tr class="map-bg-row"' + bg + ">" +
        '<td class="rank num">' + (i + 1) + "</td>" +
        "<td>" + playerLink(r.id, r.label, r.short_id) + "</td>" +
        '<td class="tank">' + tankCell(r.tank, r.tank_id) + "</td>" +
        "<td>" + mapLink + "</td>" +
        "<td>" + dateCell + "</td>" +
        "<td>" + (r.result ? personalChip(r.result) : '<span class="dim">-</span>') + "</td>" +
        '<td class="num' + (bbState.key === "dmg" ? " bb-active" : "") + '">' + fmtNum(r.dmg) + "</td>" +
        '<td class="num' + (bbState.key === "kills" ? " bb-active" : "") + '">' + fmtNum(r.kills) + "</td>" +
        '<td class="num' + (bbState.key === "assist" ? " bb-active" : "") + '">' + fmtNum(r.assist) + "</td>" +
        '<td class="num' + (bbState.key === "blocked" ? " bb-active" : "") + '">' + fmtNum(r.blocked) + "</td>" +
        '<td class="num">' + fmtClock(r.survival_sec) + "</td>" +
        '<td class="num">' + fmtPct(r.survival_pct) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="12" class="small" style="padding:20px;text-align:center">No matches recorded yet.</td></tr>';
  }

  // ---- tanks page ----

  var tanksState = { key: "games", dir: "desc" };

  // tank name -> measured kill range, filled from stats.json by renderTanks.
  // Outside DATA so the 20 second site_data poll cannot wipe it.
  var TANK_KILL_RANGE = {};

  function killRangeOf(t) {
    var v = TANK_KILL_RANGE[t.tank];
    return v == null ? null : v;
  }

  // Comparison charts under the tanks table. Bars, not lines: tanks are
  // discrete categories, and a line between them implies a progression that
  // does not exist. Each chart sorts by its own value so the ranking is the
  // point.

  function renderTanks() {
    // Tanks was the effective homepage when player pages were hidden (see
    // SHOW_PLAYER_PAGES) -- the popular-tanks strip + live player count
    // used to live on the Players page; neither names a player, so they
    // stay here rather than disappearing.
    APP.innerHTML =
      (SHOW_PLAYER_PAGES ? "" : popularTanksStrip() + steamChartSection()) +
      '<div class="page-head"><h1>Tanks</h1></div>' +
      '<div class="panel"><div class="table-scroll"><table id="tanks-table"><thead><tr>' +
      '<th class="sortable" data-key="tank">Tank<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="games">Games<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="winrate">Winrate<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="winrate_diff">WR Diff<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="avg.dmg">Avg DMG<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="avg.assist">Avg AST<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="avg.blocked">Avg BLK<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="avg.kills">Avg Kills<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="avg_survival_sec">Avg Survival<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="avg_survival_pct">Surv %<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="reload_sec">Reload<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="burst_sec">Burst<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="dpm">DPM<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="kill_range">Kill range<span class="arrow"></span></th>' +
      '<th class="sortable num" data-key="pick_rate">Pick rate<span class="arrow"></span></th>' +
      "</tr></thead><tbody id=\"tanks-body\"></tbody></table></div></div>" +
      '<div id="tanks-roster"></div>';

    renderTanksBody();
    var ths = APP.querySelectorAll("#tanks-table th.sortable");
    for (var i = 0; i < ths.length; i++) {
      ths[i].addEventListener("click", function () {
        var key = this.dataset.key;
        if (tanksState.key === key) tanksState.dir = tanksState.dir === "desc" ? "asc" : "desc";
        else { tanksState.key = key; tanksState.dir = key === "tank" ? "asc" : "desc"; }
        renderTanksBody();
      });
    }

    // The roster cards belong with the tanks, not three pages away on
    // Statistics. They need stats.json, which this page does not otherwise
    // load, so they arrive when it does.
    Promise.all([loadStats(), loadOfficial()]).then(function (both) {
      if (!both[0]) return;
      // Kill range is measured, so it comes from stats.json rather than from
      // DATA.tanks. It is kept in its own map on purpose: refreshLiveSteam()
      // replaces the whole DATA object every 20 seconds, so anything hung off
      // a tank record is silently dropped and the column empties out.
      TANK_KILL_RANGE = statByTank(both[0].kill_range_by_tank);
      renderTanksBody();
      var slot = document.getElementById("tanks-roster");
      if (slot) slot.innerHTML = rosterPanel(both[0], both[1]);
    });
  }

  function renderTanksBody() {
    var key = tanksState.key, dir = tanksState.dir;
    var tanks = DATA.tanks.slice().sort(function (a, b) {
      var av = key === "kill_range" ? killRangeOf(a) : getPath(a, key);
      var bv = key === "kill_range" ? killRangeOf(b) : getPath(b, key);
      var an = av === null || av === undefined, bn = bv === null || bv === undefined;
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      if (typeof av === "string" || typeof bv === "string") {
        av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
        return 0;
      }
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });
    var body = document.getElementById("tanks-body");
    if (!body) return;
    body.innerHTML = tanks.length ? tanks.map(function (t) {
      return "<tr>" +
        '<td class="tank"><span class="tank-cell">' + tankImgTag(t.tank_id, "tank-icon") +
        '<a href="' + tankHref(t) + '">' + esc(t.tank) + "</a></span></td>" +
        '<td class="num">' + fmtNum(t.games) + "</td>" +
        '<td class="num">' + fmtPct(t.winrate) + "</td>" +
        '<td class="num">' + wrDiffChip(t.winrate_diff) + "</td>" +
        '<td class="num">' + fmtNum(t.avg.dmg) + "</td>" +
        '<td class="num">' + fmtNum(t.avg.assist) + "</td>" +
        '<td class="num">' + fmtNum(t.avg.blocked) + "</td>" +
        '<td class="num">' + fmtNum(t.avg.kills) + "</td>" +
        '<td class="num">' + fmtClock(t.avg_survival_sec) + "</td>" +
        '<td class="num">' + fmtPct(t.avg_survival_pct) + "</td>" +
        '<td class="num">' + (t.reload_sec != null ? t.reload_sec + "s" : "-") + "</td>" +
        '<td class="num">' + (t.burst_sec != null ? t.burst_sec + "s" : "-") + "</td>" +
        '<td class="num">' + fmtNum(t.dpm) + "</td>" +
        '<td class="num">' + (killRangeOf(t) != null ? fmtNum(killRangeOf(t)) + " m" : "-") + "</td>" +
        '<td class="num">' + fmtPct(Math.round((t.pick_rate || 0) * 1000) / 10) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="15" class="small">No tank data yet.</td></tr>';

    var ths = document.querySelectorAll("#tanks-table th.sortable");
    for (var j = 0; j < ths.length; j++) {
      var arrow = ths[j].querySelector(".arrow");
      arrow.textContent = ths[j].dataset.key === key ? (dir === "asc" ? " ▲" : " ▼") : "";
    }
  }

  // ---- per-tank page ----

  // sort state for the "who played this tank" table below -- shared across
  // tank pages (like lbState is for the leaderboard) so switching sort
  // column feels consistent; resets to games/desc whenever you navigate to
  // a DIFFERENT tank (see renderTank) so it doesn't carry an odd column
  // choice from one tank onto an unrelated one.
  var tankPlayersState = { key: "games", dir: "desc", tank: null };

  // Keystone (build) split for one tank, as a share bar per option. Labels are
  // "Keystone 1/2" rather than real names: keystones replicate as GameplayTag
  // net indices and the game's tag->name table isn't in the replay, so naming
  // them would mean inventing names. Tanks with no keystone data decoded yet
  // render nothing at all instead of an empty panel.
  function keystonePanel(t) {
    if (!PREVIEW_FEATURES) return "";
    var rows = t.keystones || [];
    if (!rows.length) return "";
    var bars = rows.map(function (k, i) {
      var color = CHART_COLORS[i % CHART_COLORS.length];
      var pct = k.share == null ? 0 : k.share;
      return '<div class="keystone-row">' +
        '<div class="keystone-name">' + esc(k.label) + "</div>" +
        '<div class="keystone-track"><div class="keystone-fill" style="width:' + pct +
        "%;background:" + color + '"></div></div>' +
        '<div class="keystone-pct num">' + fmtPct(k.share) + '</div>' +
        '<div class="keystone-games small">' + fmtNum(k.games) + "</div>" +
        "</div>";
    }).join("");
    return '<div class="panel"><h2>Keystone usage</h2>' +
      '<div class="small" style="margin-bottom:10px">Which keystone players run on this tank. ' +
      "Replays do not carry their names, only numbers.</div>" +
      bars + "</div>";
  }

  function renderTank(idParam) {
    var t = findTank(idParam);
    if (!t) {
      APP.innerHTML =
        '<div class="panel not-found"><h2 style="border:none">Tank not found</h2>' +
        '<p class="small">No tank matching <span class="mono">' + esc(idParam) + "</span>.</p>" +
        '<p><a href="#/tanks">&larr; Back to tanks</a></p></div>';
      return;
    }
    if (tankPlayersState.tank !== t.tank) {
      tankPlayersState.key = "games"; tankPlayersState.dir = "desc"; tankPlayersState.tank = t.tank;
    }

    var onTank = [];
    for (var i = 0; i < DATA.players.length; i++) {
      var p = DATA.players[i];
      for (var j = 0; j < p.tanks.length; j++) {
        if (p.tanks[j].tank === t.tank) {
          onTank.push({ id: p.id, label: p.label, short_id: p.short_id, games: p.tanks[j].games, winrate: p.tanks[j].winrate, avg: p.tanks[j].avg });
          break;
        }
      }
    }

    // per-player breakdown is player-identifying (names + individual stats)
    // -- dropped entirely when SHOW_PLAYER_PAGES is off, unlike the
    // aggregate stat cards above (games/pick rate/avg across ALL players),
    // which stay since they don't name anyone.
    var playersPanel = SHOW_PLAYER_PAGES
      ? '<div class="panel"><h2>Players</h2><div class="table-scroll"><table id="tank-players-table"><thead><tr>' +
        '<th class="sortable" data-key="label">Player<span class="arrow"></span></th>' +
        '<th class="sortable num" data-key="games">Games<span class="arrow"></span></th>' +
        '<th class="sortable num" data-key="winrate">Winrate<span class="arrow"></span></th>' +
        '<th class="sortable num" data-key="avg.dmg">Avg DMG<span class="arrow"></span></th>' +
        '<th class="sortable num" data-key="avg.assist">Avg AST<span class="arrow"></span></th>' +
        '<th class="sortable num" data-key="avg.blocked">Avg BLK<span class="arrow"></span></th>' +
        '<th class="sortable num" data-key="avg.kills">Avg Kills<span class="arrow"></span></th>' +
        '</tr></thead><tbody id="tank-players-body"></tbody></table></div></div>'
      : "";

    var img = tankImgTag(t.tank_id, "tank-head-img");
    var pct = fmtPct(Math.round((t.pick_rate || 0) * 1000) / 10);

    APP.innerHTML =
      '<div class="player-head tank-head">' + img +
      '<div class="player-label">' + esc(t.tank) + "</div></div>" +
      '<div class="stat-grid">' +
      '<div class="stat-card"><div class="label">Games</div><div class="stat-value num">' + fmtNum(t.games) + "</div></div>" +
      '<div class="stat-card"><div class="label">Winrate</div><div class="stat-value num">' + fmtPct(t.winrate) + "</div></div>" +
      '<div class="stat-card"><div class="label">Pick rate</div><div class="stat-value num">' + pct + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg Survival</div><div class="stat-value num">' + fmtClock(t.avg_survival_sec) + "</div></div>" +
      '<div class="stat-card"><div class="label">Survival %</div><div class="stat-value num">' + fmtPct(t.avg_survival_pct) + "</div></div>" +
      '<div class="stat-card"><div class="label">Reload</div><div class="stat-value num">' + (t.reload_sec != null ? t.reload_sec + "s" : "-") + "</div></div>" +
      (t.burst_sec != null
        ? '<div class="stat-card"><div class="label">Burst</div><div class="stat-value num">' + t.burst_sec + 's</div><div class="small" style="color:var(--dim)">autoloader</div></div>'
        : "") +
      '<div class="stat-card"><div class="label">DPM</div><div class="stat-value num">' + fmtNum(t.dpm) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg DMG</div><div class="stat-value num">' + fmtNum(t.avg.dmg) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg Assist</div><div class="stat-value num">' + fmtNum(t.avg.assist) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg Blocked</div><div class="stat-value num">' + fmtNum(t.avg.blocked) + "</div></div>" +
      '<div class="stat-card"><div class="label">Avg Kills</div><div class="stat-value num">' + fmtNum(t.avg.kills) + "</div></div>" +
      "</div>" +
      '<div id="tank-fingerprint-slot"></div>' +
      keystonePanel(t) +
      playersPanel +
      '<p><a href="#/tanks">&larr; Back to tanks</a></p>';

    loadStats().then(function (s) {
      var slot = document.getElementById("tank-fingerprint-slot");
      // the user may have navigated away while the fetch was in flight
      if (slot) slot.innerHTML = tankFingerprintPanel(t, s);
    });

    if (!SHOW_PLAYER_PAGES) return;
    renderTankPlayersBody(onTank);
    var ths = APP.querySelectorAll("#tank-players-table th.sortable");
    for (var k = 0; k < ths.length; k++) {
      ths[k].addEventListener("click", function () {
        var key = this.dataset.key;
        if (tankPlayersState.key === key) tankPlayersState.dir = tankPlayersState.dir === "desc" ? "asc" : "desc";
        else { tankPlayersState.key = key; tankPlayersState.dir = "desc"; }
        renderTankPlayersBody(onTank);
      });
    }
  }

  // One tank's shape across six axes, every axis scaled to the highest value
  // any tank reaches. The point is comparison: flip between two tanks and the
  // outline changes shape, which a column of numbers never does.
  //
  // Only axes this tank actually has data for are drawn, and the whole panel
  // is dropped below three, rather than plotting a zero and implying the tank
  // is bad at something the replay simply never measured.
  function tankFingerprintPanel(t, s) {
    s = s || {};
    var AXES = [
      { label: "Damage", get: function (x) { return x.avg && x.avg.dmg; } },
      { label: "Kills", get: function (x) { return x.avg && x.avg.kills; } },
      { label: "Assist", get: function (x) { return x.avg && x.avg.assist; } },
      { label: "Survival", get: function (x) { return x.avg_survival_pct; } },
      { label: "Speed", get: function (x) { return x._speed; } },
      { label: "Kill range", get: function (x) { return x._range; } },
    ];
    var speedBy = statByTank(s.speed_by_tank), rangeBy = statByTank(s.kill_range_by_tank);
    var roster = (DATA.tanks || []).map(function (x) {
      return Object.assign({}, x, { _speed: speedBy[x.tank], _range: rangeBy[x.tank] });
    });
    var me = roster.filter(function (x) { return x.tank === t.tank; })[0];
    if (!me) return "";
    var axes = AXES.map(function (a) {
      var v = a.get(me);
      if (v == null || !isFinite(v)) return null;
      var max = Math.max.apply(null, roster.map(function (x) {
        var q = a.get(x); return (q != null && isFinite(q)) ? q : 0;
      }).concat([0.0001]));
      return { label: a.label, value: v, max: max,
               display: fmtNum(Math.round(v * 10) / 10) };
    }).filter(Boolean);
    if (axes.length < 3) return "";
    return '<div class="panel"><h2>Shape of this tank</h2>' +
      '<div class="fingerprint-wrap">' +
      svgRadar(axes, { color: tankColor(t.tank) || CHART_COLORS[0] }) +
      '<div class="fingerprint-key small">' +
      axes.map(function (a) {
        return "<div><span>" + esc(a.label) + "</span><b>" + esc(a.display) +
          '</b><span class="dim">' + Math.round(a.value / a.max * 100) + "% of best</span></div>";
      }).join("") + "</div></div>" +
      '<p class="small" style="margin-top:10px">Scaled to the best tank on each axis.</p></div>';
  }

  function renderTankPlayersBody(onTank) {
    var key = tankPlayersState.key, dir = tankPlayersState.dir;
    var rows = onTank.slice().sort(function (a, b) {
      var av = getPath(a, key), bv = getPath(b, key);
      var an = av === null || av === undefined, bn = bv === null || bv === undefined;
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      if (typeof av === "string" || typeof bv === "string") {
        av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
        return 0;
      }
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });

    var body = document.getElementById("tank-players-body");
    if (!body) return;
    body.innerHTML = rows.length ? rows.map(function (pt) {
      return "<tr>" +
        "<td>" + playerLink(pt.id, pt.label, pt.short_id) + "</td>" +
        '<td class="num">' + fmtNum(pt.games) + "</td>" +
        '<td class="num">' + fmtPct(pt.winrate) + "</td>" +
        '<td class="num">' + fmtNum(pt.avg.dmg) + "</td>" +
        '<td class="num">' + fmtNum(pt.avg.assist) + "</td>" +
        '<td class="num">' + fmtNum(pt.avg.blocked) + "</td>" +
        '<td class="num">' + fmtNum(pt.avg.kills) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="7" class="small">No players recorded on this tank.</td></tr>';

    var ths = document.querySelectorAll("#tank-players-table th.sortable");
    for (var j = 0; j < ths.length; j++) {
      var arrow = ths[j].querySelector(".arrow");
      arrow.textContent = ths[j].dataset.key === tankPlayersState.key ? (tankPlayersState.dir === "asc" ? " ▲" : " ▼") : "";
    }
  }

  // ---------------------------------------------------------------- replay debrief (deep .replay decode)

  var TEAMLABEL = ["A", "B"];

  function fmtClock(sec) {
    if (sec == null) return "-";
    var total = Math.round(sec); // round whole seconds first so e.g. 239.6 -> 4:00, not 3:60
    var m = Math.floor(total / 60), s = String(total % 60).padStart(2, "0");
    return m + ":" + s;
  }

  // ---- Debrief tab: match summary + operators (real names + health/KIA) + combat ----

  function card(label, value) {
    return '<div class="stat-card"><div class="label">' + esc(label) + '</div><div class="stat-value">' + value + "</div></div>";
  }

  // step-line HP sparkline (green if survived, pink if killed)
  function sparkline(series, max) {
    var W = 150, H = 26, pad = 2;
    var t0 = series[0][0], t1 = series[series.length - 1][0] || 1, span = Math.max(t1 - t0, 1);
    var pts = series.map(function (s) {
      return [pad + (s[0] - t0) / span * (W - pad * 2), pad + (1 - (max ? s[1] / max : 0)) * (H - pad * 2)];
    });
    var dp = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (var i = 1; i < pts.length; i++) {
      dp += " L" + pts[i][0].toFixed(1) + " " + pts[i - 1][1].toFixed(1) +
            " L" + pts[i][0].toFixed(1) + " " + pts[i][1].toFixed(1);
    }
    var died = series.some(function (s) { return s[1] === 0; });
    var col = died ? "#ff9db8" : "#8fb0ff";
    var area = dp + " L" + pts[pts.length - 1][0].toFixed(1) + " " + (H - pad) + " L" + pts[0][0].toFixed(1) + " " + (H - pad) + " Z";
    return '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">' +
      '<path d="' + area + '" fill="' + col + '" opacity="0.12"></path>' +
      '<path d="' + dp + '" fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round"></path></svg>';
  }

  // ---- general-purpose SVG chart helpers (Statistics page) ----
  // Hand-rolled, no external charting library -- matches how sparkline()
  // above already does it, keeps the site dependency-free.

  // Slightly muted versions of the site palette: at full saturation several
  // of these vibrate against the dark background when used as large fills.
  // Per-tank chart colour, derived from each tank's own artwork by
  // tools/tank_palette.py. Charts used a fixed eight colour cycle, so a bar's
  // colour depended on where the tank happened to sort and repeated past the
  // eighth tank. Finding one tank meant reading every label.
  var TANK_COLORS = {
    "stealth": "#944e42",
    "helio": "#945a42",
    "tricera": "#945b42",
    "ranger": "#946742",
    "drone": "#a8712e",
    "deadeye": "#947f42",
    "bush": "#799442",
    "ikarus": "#429477",
    "healer": "#429485",
    "fortis": "#42948f",
    "tempest": "#427f94",
    "blink": "#426894",
    "ram": "#454294",
    "rook": "#674294",
    "arbalest": "#94424b",
    "sonar": "#944245",
    "vanguard": "#944243"
  };

  // Contextual hue per chart subject, used for the GRID lines rather than the
  // bars. The bars say which tank; the background says what is being measured.
  // Previously the bars carried the context, which read backwards: the kills
  // chart was green and the deaths chart red.
  var CONTEXT_HUES = {
    kill: "rgba(190, 90, 90, 0.40)", death: "rgba(190, 90, 90, 0.40)",
    time: "rgba(120, 150, 210, 0.34)", neutral: "rgba(255, 255, 255, 0.10)",
  };

  function tankColor(name) {
    if (!name) return null;
    var k = slugify(String(name));
    if (TANK_COLORS[k]) return TANK_COLORS[k];
    // charts label by display name; site_data carries tank_id, so try that too
    var tanks = (DATA && DATA.tanks) || [];
    for (var i = 0; i < tanks.length; i++) {
      if (slugify(tanks[i].tank || "") === k && TANK_COLORS[tanks[i].tank_id]) {
        return TANK_COLORS[tanks[i].tank_id];
      }
    }
    return null;
  }

  var CHART_COLORS = ["#42588d", "#65508a", "#35674a", "#8a4444", "#8c6739", "#436f83", "#8a6169", "#5a6d39"];

  // seriesList: [{label, color, values:[v0,v1,...]}] sharing one 0..n-1 x-axis
  // (e.g. normalized 0-100% match progress). null values are gapped, not
  // drawn as 0. xLabels (optional): labels for the first/mid/last x ticks.
  // Smooth a polyline through its points with Catmull-Rom converted to cubic
  // beziers. Passes exactly through every real data point (unlike a spline
  // that averages them), so the curve is easier to read without misstating a
  // single value.
  // rows: [{label, value}]. Horizontal bars -- reads better than vertical
  // for long/many labels (histograms, squad size, win type).
  // axes: [{label, value, max, display}]. One shape per subject, drawn against
  // the same outline every time so two of them can be compared by eye. Every
  // axis is scaled to the roster maximum rather than to itself, or each shape
  // would fill the web and say nothing.
  function svgRadar(axes, opts) {
    opts = opts || {};
    axes = (axes || []).filter(function (a) { return a && isFinite(a.value) && a.max > 0; });
    if (axes.length < 3) return "";
    var size = opts.size || 320, cx = size / 2, cy = size / 2 + 6;
    var R = size / 2 - 46;
    var color = opts.color || CHART_COLORS[0];
    function pt(i, frac) {
      var ang = -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
      return [cx + Math.cos(ang) * R * frac, cy + Math.sin(ang) * R * frac];
    }
    var rings = "";
    for (var r = 1; r <= 4; r++) {
      var poly = axes.map(function (_, i) {
        return pt(i, r / 4).map(function (n) { return n.toFixed(1); }).join(",");
      }).join(" ");
      rings += '<polygon points="' + poly + '" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="1"></polygon>';
    }
    var spokes = axes.map(function (_, i) {
      var e = pt(i, 1);
      return '<line x1="' + cx + '" y1="' + cy + '" x2="' + e[0].toFixed(1) + '" y2="' + e[1].toFixed(1) +
        '" stroke="rgba(255,255,255,0.09)" stroke-width="1"></line>';
    }).join("");
    function polyFor(list) {
      return list.map(function (a, i) {
        return pt(i, Math.max(0.03, Math.min(1, a.value / a.max)))
          .map(function (n) { return n.toFixed(1); }).join(",");
      }).join(" ");
    }
    var shape = polyFor(axes);
    var dots = axes.map(function (a, i) {
      var q = pt(i, Math.max(0.03, Math.min(1, a.value / a.max)));
      return '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="3" fill="' + color + '">' +
        "<title>" + esc(a.label + ": " + a.display) + "</title></circle>";
    }).join("");
    // An optional second shape on the same web. Two of these side by side
    // would make the reader hold one in their head; overlaid, the difference
    // is the picture.
    var second = "";
    if (opts.compare && opts.compare.length === axes.length) {
      second = '<polygon points="' + polyFor(opts.compare) + '" fill="' +
        (opts.compareColor || "#c98b3a") + '" fill-opacity="0.16" stroke="' +
        (opts.compareColor || "#c98b3a") +
        '" stroke-width="2" stroke-dasharray="5 4"></polygon>' +
        opts.compare.map(function (a, i) {
          var q = pt(i, Math.max(0.03, Math.min(1, a.value / a.max)));
          return '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) +
            '" r="3" fill="' + (opts.compareColor || "#c98b3a") + '">' +
            "<title>" + esc(a.label + ": " + a.display) + "</title></circle>";
        }).join("");
    }
    var labels = axes.map(function (a, i) {
      var q = pt(i, 1.19);
      var anchor = q[0] < cx - 6 ? "end" : (q[0] > cx + 6 ? "start" : "middle");
      return '<text x="' + q[0].toFixed(1) + '" y="' + (q[1] + 4).toFixed(1) + '" text-anchor="' + anchor +
        '" class="chart-axis-label">' + esc(a.label) + "</text>";
    }).join("");
    return '<svg class="chart-svg" width="100%" viewBox="0 0 ' + size + " " + (size + 12) +
      '" preserveAspectRatio="xMidYMin meet">' + rings + spokes +
      second +
      '<polygon points="' + shape + '" fill="' + color + '" fill-opacity="0.30" stroke="' +
      color + '" stroke-width="2"></polygon>' + dots + labels + "</svg>";
  }

  // rows: [{label, p10, p25, p50, p75, p90, color}]. A bar says where the
  // middle is; this says how wide the thing is around it, which for something
  // like engagement range is most of the story. Box covers the middle half,
  // whiskers reach the tenth and ninetieth, the tick is the median.
  // rows/cols of labels with a value per cell, coloured by how far the cell
  // sits from the column's own average rather than by the raw number. Raw
  // numbers would just show which tanks are popular everywhere; the deviation
  // shows where a tank is unusually liked or ignored.
  // values: 24 numbers, one per hour. A day is a loop, and a line chart cuts
  // it at midnight so the quietest hours land at both ends and the evening
  // peak looks like a wall. A circle keeps the day continuous.
  // Same relationships, drawn round a circle instead of along a line. Every
  // pair gets the same amount of room whichever way round it is, the curves
  // bow toward the middle so the busy ones read as a knot, and each label sits
  // at its own angle so nothing has to be rotated 40 degrees to fit.
  //
  // Curve colour is the killer's, and the curve fades toward the victim, so
  // direction is readable without arrowheads.
  // rows: [{label, a, b, aLabel, bLabel}]. Two numbers per row as two dots on
  // one line. Reading the gap is the point; two bar charts side by side make
  // you do that arithmetic in your head.
  // rows: [{label, value, color}] as a grid of squares, one square per unit.
  // Counting squares is something people can actually do; comparing the
  // lengths of two slices of a pie is not.
  // rows: [{label, bins, color}]. Overlapping filled curves, one per row. A box
  // plot gives five numbers per row; this gives the whole distribution, which
  // is the only way a tank that fights at two separate ranges looks different
  // from one that fights at the average of them.
  // left: [{label, color}], right: [{label, color}], flow(l, r) -> number.
  // Bands whose thickness is the count, so where the volume goes is the
  // picture rather than something to work out from two lists of numbers.
  // items: [{color, title, win}] in order. One thin band per match, left to
  // right, oldest first. A pie of somebody's tank usage says what they play;
  // this says what they played and when, so a switch shows up as a change of
  // colour partway along rather than being averaged away.
  // points: [{color, size, title}] in order. Everything laid on one spiral,
  // oldest at the middle. A spiral fits a few hundred things into a square
  // without the aspect ratio going silly the way a long strip does, and time
  // still runs in one direction the whole way round.
  // rows: [{label, value, sub}] where value can be negative. Bars grow both
  // ways from a line down the middle, which is the only honest way to draw
  // something centred on zero: a normal bar chart would put the worst pairing
  // at the same end as the best one and only the number would tell them apart.
  // rows: [{label, value, color, sub}]. Squarified treemap. Area is the value,
  // which is the one thing a bar chart cannot do: show seventeen shares and
  // their total at the same time, in a shape that fits the page.
  // rows: [{label, parts: [{n, color, name}]}]. One bar per row, split into
  // shares that add to 100%. For "how does this end" questions, where the
  // whole is fixed and only the split matters.
  // Win rate, pulled toward 50 by how little evidence there is behind it, then
  // cut into tiers. A tank with 90 games and 55% is a real 55%; one with 12
  // games and 65% is mostly luck, and shrinking it says so without hiding it.

  // rows: [{label, value}]. Simple pie (no donut hole) with a side legend.
  // ---- Statistics page ----

  // ---- Averages: population-level match data, all as big line charts ----
  // Every panel here is an average/distribution across every decoded match --
  // nothing names a player, so this page needs no privacy gating.

  // a histogram (from _histogram in replay_to_site) drawn as a frequency
  // polygon rather than bars -- same data, continuous shape
  // 0..23 -> "12am" / "1pm". The hours come from time.localtime at build
  // time, so they are already this machine's local clock, not UTC.
  // Kill matrix: rows are the killer, columns the victim, cell brightness is
  // that killer's share of kills against that victim. Shares rather than raw
  // counts because counts just re-rank tanks by how often they get played,
  // which buries the actual matchup. The diagonal is same-tank kills and is
  // dimmed so it stops dominating the grid.
  // Tank matchups.
  //
  // The grid alone was 289 red cells that needed a hover to read, and the
  // number in them was "share of this killer's kills", which is driven by how
  // often a tank gets PICKED rather than by whether it wins the fight. Ark
  // takes a big share of its kills from Ark because Ark is everywhere.
  //
  // The matrix carries counts in BOTH directions, so a real head to head
  // record is available: kills for versus kills against between exactly those
  // two tanks. Popularity cancels out, and it answers the question people
  // actually ask. The grid stays underneath as the dense reference.
  var MU_MIN_DUELS = 8;      // below this a percentage is noise, not a matchup

  var muTank = null;

  // The dense reference, kept but restyled: row labels carry the tank's own
  // colour so a row can be found without reading every label.
  // Pulls one number per tank out of a stats list keyed by display name.
  // stats.json is its own file (it is big and only two pages want it), so it
  // is fetched on demand and kept. Without the cache, clicking between tanks
  // refetches the whole aggregate every time.
  var STATS = null;
  function loadStats() {
    if (STATS) return Promise.resolve(STATS);
    return loadJson("stats.json").then(function (s) { STATS = s || {}; return STATS; });
  }

  // The game's own published numbers, from tyrhq.com. Everything else on this
  // site is measured from replays, so these are kept in a separate file and
  // never mixed in: a comparison has to have two independent sides or it is
  // just a number agreeing with itself.
  var OFFICIAL = null;
  function loadOfficial() {
    if (OFFICIAL) return Promise.resolve(OFFICIAL);
    return loadJson("tyrhq_official.json").then(function (o) {
      OFFICIAL = o || {};
      OFFICIAL.byTank = {};
      (OFFICIAL.tanks || []).forEach(function (x) { OFFICIAL.byTank[x.tank] = x; });
      return OFFICIAL;
    });
  }

  var CLASS_COLOR = { Light: "#6ea8fe", Medium: "#c9a227", Heavy: "#c0392b" };

  function statByTank(list, key) {
    var out = {};
    (list || []).forEach(function (r) { out[r.label] = key ? r[key] : r.value; });
    return out;
  }

  // ---- Data tab: the three panels that are not charts -----------------

  // Every tank as a card. The numbers are the ones that actually say how a
  // tank plays rather than how good it is, since the tier list above already
  // answers that.
  // Tank art plus its numbers. The published figures come from tyrhq; kill
  // range, average speed and abilities per game are not published anywhere and
  // are measured off the replays.
  function rosterPanel(s, official) {
    var tanks = (DATA.tanks || []).slice().sort(function (a, b) { return b.games - a.games; });
    if (tanks.length < 4) return "";
    var rangeBy = statByTank(s.kill_range_by_tank);
    var speedBy = statByTank(s.speed_by_tank);
    var castBy = statByTank(s.casts_by_tank);
    var spec = (official && official.byTank) || {};

    var cards = tanks.map(function (x) {
      var col = tankColor(x.tank) || CHART_COLORS[0];
      var o = spec[x.tank] || {};
      function bit(label, val) {
        return '<div class="rt-bit"><span>' + esc(label) + "</span><b>" +
          esc(val == null || val === "" ? "-" : val) + "</b></div>";
      }
      return '<a class="roster-card" href="' + tankHref(x) + '" style="--tc:' + col + '">' +
        '<div class="rt-art">' + tankImgTag(x.tank_id, "rt-img") + "</div>" +
        '<div class="rt-name">' + esc(x.tank) +
          (o["class"] ? ' <span class="rt-class">' + esc(o["class"]) + "</span>" : "") + "</div>" +
        '<div class="rt-games small">' + fmtNum(x.games) + " games  " +
          fmtPct(x.winrate) + "</div>" +
        '<div class="rt-bits small">' +
          bit("HP", o.hp != null ? fmtNum(o.hp) : null) +
          bit("Damage", o.dmg != null ? fmtNum(o.dmg) : null) +
          bit("Pen", o.pen != null ? fmtNum(o.pen) + " mm" : null) +
          bit("Top speed", o.spd != null ? fmtNum(o.spd) + " km/h" : null) +
          bit("Reverse", o.reverse_spd != null ? fmtNum(o.reverse_spd) + " km/h" : null) +
          bit("Reload", o.reload_s != null ? fmtNum(o.reload_s) + " s" : null) +
          bit("Kill range", rangeBy[x.tank] != null ? fmtNum(rangeBy[x.tank]) + " m" : null) +
          bit("Avg speed", speedBy[x.tank] != null ? fmtNum(speedBy[x.tank]) + " km/h" : null) +
          bit("Abilities", castBy[x.tank] != null ? fmtNum(castBy[x.tank]) + "/game" : null) +
        "</div>" +
        (o.ability && o.ability.name
          ? '<div class="rt-ability small">' + esc(o.ability.name) +
            (o.ability.text ? '<span class="rt-ability-text">' + esc(o.ability.text) + "</span>" : "") +
            "</div>"
          : "") +
        "</a>";
    }).join("");
    return '<div class="panel"><h2>The roster</h2><div class="roster-grid">' + cards +
      '</div><p class="small" style="margin-top:12px">HP, damage, pen, top speed and reload are ' +
      "tyrhq's published figures. Kill range, average speed and abilities per game are measured " +
      "from replays.</p></div>";
  }

  // One match, as it usually goes. Every marker is a real median from the
  // archive rather than a made up beat sheet.
  // Pick a team and see how the picks get on with each other. Everything here
  // is measured, not modelled: each pair's number is how that pair has
  // actually done side by side against what the two tanks manage apart.



  // Pick two tanks, see them against each other.
  var duelState = { a: null, b: null };

  // Win-rate banding for the roster cards.
  // Builds every panel on the old Data page and hands back the two halves
  // rather than writing them anywhere. Both stats.json and the official sheet
  // are memoised, so calling this a second time for the other half costs
  // nothing beyond rebuilding the strings.
  var DATA_SECTIONS = null;


  // ---- Map heat panel: shared by #/match/<id> (one match) and #/map/<slug> ----
  // (the aggregate of every decoded match on that map). Team heat is drawn
  // additively so cells both teams pass through render amber. No radar, no
  // grid, no per-tank routes: the map art sits underneath the overlay. The
  // renderer is dataset-driven (mapS.data = { match:{mapSlug,calibration},
  // heatTeam, shots, bounds, mapBounds }) -- one shape for both callers.

  // Features still under local review. deploy_site.py ships whatever is on
  // disk, so this is flipped to false for a public deploy and back to true for
  // the local preview server -- production only ever carries signed-off work.
  var PREVIEW_FEATURES = false;

  // The kill-line layer is finished and its data still ships in every match
  // view and map aggregate; it is only hidden while other things get looked
  // at first. Flip to true to bring it back, no rebuild needed.
  var SHOW_KILL_LAYER = false;

  var mapS = { cv: null, ctx: null, W: 0, H: 0, tf: null, active: false,
               data: null, rot: 0, flip: false,
               _cx: 0, _cy: 0, _s: 1,
               // playhead == null shows the static whole-match heat. A number
               // (0..1) is the animation position through match progress;
               // playing advances it each frame (see mapPlay/stopMap).
               playhead: null, playing: false, raf: null,
               layers: { heat: true, shots: false, kills: false,
                         team0: true, team1: true } };  // heatmap-first; the rest opt-in
  // fixed per-team colors (Team A / Team B), NOT relative to who recorded the
  // replay -- team 0 is always Team A, team 1 is always Team B. Additive
  // blend of the two heat clouds makes contested ground read amber/yellow
  // (green + red light = yellow).
  var TEAM_RGB = { 0: "34,197,94", 1: "239,68,68" };  // green / red
  // Line count the heat alpha is tuned against -- about what one match draws.
  // See mapHeatTeam: anything denser is scaled down so it stops clipping.
  var HEAT_REF_LINES = 40;
  // same two team colors as hex, for SVG charts (the canvas map builds
  // rgba() strings from TEAM_RGB instead). Kept in sync by hand -- two
  // representations of one pair of colors, so a change means editing both.
  var TEAM_HEX = { 0: "#35674a", 1: "#8a4444" };

  function stopMap() {
    mapS.active = false;
    mapS.data = null;
    if (mapS.raf) { cancelAnimationFrame(mapS.raf); mapS.raf = null; }
    mapS.playing = false;
    mapS.playhead = null;
  }

  // remember the user's orientation (rot/flip only) per map
  function orientKey() { return "tyrMapOrient:" + (mapS.data && mapS.data.match.mapSlug); }
  function loadOrient() {
    mapS.rot = 0; mapS.flip = false;
    var cal = mapS.data && mapS.data.match.calibration;
    // verified calibration is authoritative — drop any saved manual alignment.
    if (cal && cal.worldCenterX != null && cal.verified) {
      try { localStorage.removeItem(orientKey()); } catch (e) {}
      return;
    }
    // unverified/uncalibrated: remember the user's orientation (rot/flip only).
    try {
      var s = JSON.parse(localStorage.getItem(orientKey()) || "null");
      if (s) { mapS.rot = s.rot & 3; mapS.flip = !!s.flip; }
    } catch (e) {}
  }
  function saveOrient() {
    try { localStorage.setItem(orientKey(), JSON.stringify({ rot: mapS.rot, flip: mapS.flip })); } catch (e) {}
  }

  // map-heat panel markup for one dataset (stage + legend + key). Shared by
  // the per-match battle map and the per-map aggregate heatmap; pair it with
  // initMapPanel(d), which wires the canvas + controls to the same dataset.
  function mapPanel(d) {
    var m = d.match;
    var calibrated = !!(m.calibration && m.calibration.worldCenterX != null);
    var verified = calibrated && m.calibration.verified;
    // rotate/flip appear only while orientation isn't locked; no zoom/pan at
    // all (heat + map image stay locked together).
    var orientBtns = verified ? "" :
      '<div class="map-controls" style="margin-bottom:8px">' +
      '<button class="orient-btn" id="rotbtn" title="Rotate 90&deg;">&#8635; Rotate</button>' +
      '<button class="orient-btn" id="flipbtn" title="Flip / mirror">&#8646; Flip</button></div>';
    var alignNote = verified
      ? ""
      : calibrated
        ? "This map's orientation isn't locked yet (being verified from the game now). Tap <b>Flip</b>/<b>Rotate</b> if it looks mirrored."
        : "<b>Rotate</b>/<b>Flip</b> to orient it to the map.";
    return '<div class="panel map-panel">' + orientBtns +
      '<div class="map-stage" id="mapstage" data-mapslug="' + esc(m.mapSlug) + '">' +
        '<img class="mapbg" id="mapbg" alt="" src="assets/maps/minimap/' + esc(m.mapSlug) + '.png" ' +
        'onerror="this.style.display=\'none\'">' +
        '<canvas id="tacmap"></canvas>' +
      "</div>" +
      '<div class="maplegend" id="maplegend">' +
        legendChip("heat", "Heat") + legendChip("shots", "Shots") +
        (SHOW_KILL_LAYER && killLinesFor(d).length ? legendChip("kills", "Kills") : "") +
      "</div>" +
      timelineControls(d) +
      '<div class="small" style="margin-top:10px" id="mapteamkey">' +
      teamChip("team0", "a", "Team A") + " " + teamChip("team1", "b", "Team B") + " " +
      '<span class="tkey tkey-o" id="tkey-contested">contested</span>: the heat shows where each team spent time. ' +
      "Ground both teams crossed glows amber. " +
      (SHOW_KILL_LAYER && killLinesFor(d).length
        ? "<b>Kills</b> draws a line from each shooter to the tank it killed. The "
          + "dot marks the tank that died, in the colour of the team that lost it. "
        : "") + alignNote +
      "</div></div>";
  }

  // Timeline scrubber for the time-sliced heat. Only rendered when the dataset
  // actually carries heatPhases -- an older cached match file won't have it,
  // and showing dead controls is worse than showing none.
  function timelineControls(d) {
    if (!PREVIEW_FEATURES) return "";
    if (!flowLinesFor(d).length) return "";
    return '<details class="map-replay"><summary>Replay movement</summary>' +
      '<div class="map-timeline" id="map-timeline">' +
      '<button class="orient-btn" id="phase-play" type="button">&#9654; Play</button>' +
      '<input type="range" id="phase-range" min="-1" max="1000" value="-1" step="1">' +
      '<span class="phase-label small" id="phase-label">Whole match</span>' +
      "</div>" + flowSettingsHtml(d) + "</details>";
  }

  // playhead is a fraction of match PROGRESS, not wall-clock -- matches are
  // normalized to their own length so they animate together, so the honest
  // label is a percentage rather than a time.
  function setPlayhead(v) {
    mapS.playhead = (v == null || v < 0) ? null : Math.min(1, v);
    var lbl = document.getElementById("phase-label");
    if (lbl) {
      lbl.textContent = mapS.playhead == null
        ? "Whole match"
        : Math.round(mapS.playhead * 100) + "% into the match";
    }
    var range = document.getElementById("phase-range");
    if (range && !mapS.playing) range.value = mapS.playhead == null ? -1 : Math.round(mapS.playhead * 1000);
    mapDraw();
  }

  function mapPlay(on) {
    var btn = document.getElementById("phase-play");
    if (mapS.raf) { cancelAnimationFrame(mapS.raf); mapS.raf = null; }
    mapS.playing = on;
    if (btn) btn.innerHTML = on ? "&#10073;&#10073; Pause" : "&#9654; Play";
    if (!on) return;
    if (mapS.playhead == null) mapS.playhead = 0;
    var last = null;
    var step = function (now) {
      // navigating away nulls mapS.data before the next frame runs
      if (!mapS.active || !mapS.data) { mapPlay(false); return; }
      // advance by elapsed time, not per-frame, so the sweep runs at the same
      // speed on a 60Hz and a 144Hz display
      var dt = last == null ? 0 : (now - last) / 1000;
      last = now;
      var next = mapS.playhead + (dt * mapS.flow.speed) / FLOW_SWEEP_SECONDS;
      // loop with a short lead-in so trails clear before restarting
      setPlayhead(next > 1 + TRAIL ? 0 : next);
      var r = document.getElementById("phase-range");
      if (r) r.value = Math.round(Math.min(1, mapS.playhead) * 1000);
      mapS.raf = requestAnimationFrame(step);
    };
    mapS.raf = requestAnimationFrame(step);
  }

  var FLOW_SWEEP_SECONDS = 12;   // wall-clock length of one full sweep

  // wire the canvas/legend/orient controls rendered by mapPanel(d)
  function initMapPanel(d) {
    mapS.data = d;
    loadOrient();
    mapS.cv = document.getElementById("tacmap");
    if (!mapS.cv) return;
    mapS.ctx = mapS.cv.getContext("2d");
    mapS.active = true;
    mapResize();

    document.getElementById("maplegend").addEventListener("click", function (e) {
      var chip = e.target.closest(".mchip"); if (!chip) return;
      var L = chip.dataset.layer;
      mapS.layers[L] = !mapS.layers[L];
      chip.classList.toggle("off", !mapS.layers[L]);
      mapDraw();
    });
    var teamKey = document.getElementById("mapteamkey");
    if (teamKey) teamKey.addEventListener("click", function (e) {
      var chip = e.target.closest(".tkey[data-layer]"); if (!chip) return;
      var L = chip.dataset.layer;
      mapS.layers[L] = !mapS.layers[L];
      chip.classList.toggle("off", !mapS.layers[L]);
      chip.setAttribute("aria-pressed", mapS.layers[L] ? "true" : "false");
      syncContestedChip();
      mapDraw();
    });
    syncContestedChip();   // reflect state carried over from a previous map

    var rotb = document.getElementById("rotbtn");   // absent when auto-calibrated
    if (rotb) rotb.addEventListener("click", function () {
      mapS.rot = (mapS.rot + 1) & 3; saveOrient(); mapResize();
    });
    var flipb = document.getElementById("flipbtn");
    if (flipb) flipb.addEventListener("click", function () {
      mapS.flip = !mapS.flip; saveOrient(); mapResize();
    });

    var range = document.getElementById("phase-range");
    if (range) range.addEventListener("input", function () {
      mapPlay(false);                       // scrubbing takes over from playback
      var v = parseInt(this.value, 10);
      setPlayhead(v < 0 ? null : v / 1000);
    });
    var play = document.getElementById("phase-play");
    if (play) play.addEventListener("click", function () { mapPlay(!mapS.playing); });

    // flow settings: apply live, and start the animation if the user is
    // still on the static view so a change is immediately visible
    [["flow-keep", "keep"], ["flow-density", "density"],
     ["flow-width", "width"], ["flow-speed", "speed"]].forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      el.addEventListener("change", function () {
        var v = parseFloat(this.value);
        mapS.flow[pair[1]] = pair[1] === "keep" ? !!v : v;
        // Changing a flow setting from the static view used to jump the
        // playhead to 0, which draws an almost-empty map and reads as "the
        // setting did nothing". Start playing instead, so the effect is
        // immediately visible.
        if (!mapS.playing) mapPlay(true); else mapDraw();
      });
    });
  }

  // The Team A / Team B pills in the caption double as heat toggles: in
  // testing people instinctively clicked the coloured pills expecting them
  // to hide that team, so they now do.
  function teamChip(layer, tone, label) {
    var on = mapS.layers[layer];
    return '<button type="button" class="tkey tkey-' + tone + (on ? "" : " off") +
      '" data-layer="' + layer + '" aria-pressed="' + (on ? "true" : "false") +
      '">' + label + "</button>";
  }

  // "contested" is not a layer of its own -- it's the amber where the two
  // teams' heat overlaps, so it can only exist while BOTH teams are shown.
  // Dim it in step rather than leaving it looking like a third toggle that
  // does nothing when clicked.
  function syncContestedChip() {
    var el = document.getElementById("tkey-contested");
    if (el) el.classList.toggle("off", !(mapS.layers.team0 && mapS.layers.team1));
  }

  function legendChip(layer, label) {
    var off = mapS.layers[layer] ? "" : " off";   // reflect current on/off state
    return '<span class="mchip' + off + '" data-layer="' + layer + '"><span class="mdot mdot-' + layer + '"></span>' + label + "</span>";
  }

  function mapResize() {
    if (!mapS.cv || !mapS.data) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    // square stage: the tyrhq tactical minimaps are square (1024x1024) top-downs
    var cw = mapS.cv.clientWidth || 720, ch = cw;
    mapS.cv.width = cw * dpr; mapS.cv.height = ch * dpr; mapS.cv.style.height = ch + "px";
    var st = document.getElementById("mapstage"); if (st) st.style.height = ch + "px";
    mapS.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mapS.W = cw; mapS.H = ch;

    // world->minimap transform. NO zoom/pan: heat/shots stay locked to the
    // map image at all times (they share this one mapping).
    var cal = mapS.data.match.calibration;
    if (cal && cal.worldCenterX != null) {
      // GENERAL world->minimap: translate to center, rotate by the capture's
      // rotationDeg, optional axis flips, scale by worldSize. This can express
      // ANY orientation (the old version could only flip, so a rotated capture
      // was unreachable). verified => exact/no controls; unverified => user
      // rot/flip nudges on top.
      var th = (cal.rotationDeg || 0) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
      mapS.tf = function (x, y) {
        var dx = x - cal.worldCenterX, dy = y - cal.worldCenterY;
        var rx = dx * cs - dy * sn, ry = dx * sn + dy * cs;
        if (cal.flipX) rx = -rx;
        if (cal.flipY) ry = -ry;
        var u = 0.5 + rx / cal.worldSize, v = 0.5 + ry / cal.worldSize;
        if (!cal.verified) {
          if (mapS.flip) u = 1 - u;
          for (var k = 0; k < (mapS.rot & 3); k++) { var t = u; u = v; v = 1 - t; }
        }
        return [u * cw, v * ch];
      };
      mapDraw();
      return;
    }
    // --- no calibration at all: fit the play area, manual rot/flip for orientation ---
    var b = mapS.data.mapBounds || mapS.data.bounds, pad = 12;
    var hw = Math.max((b.maxX - b.minX) / 2, 1), hh = Math.max((b.maxY - b.minY) / 2, 1);
    var rot = mapS.rot & 3;
    var ehw = (rot & 1) ? hh : hw, ehh = (rot & 1) ? hw : hh;
    mapS._cx = (b.minX + b.maxX) / 2; mapS._cy = (b.minY + b.maxY) / 2;
    mapS._s = Math.min((cw - pad * 2) / (2 * ehw), (ch - pad * 2) / (2 * ehh));
    mapS.tf = function (x, y) {
      var dx = x - mapS._cx, dy = y - mapS._cy;
      if (mapS.flip) dx = -dx;
      for (var k = 0; k < (mapS.rot & 3); k++) { var t = dx; dx = dy; dy = -t; }  // 90 CW
      return [mapS.W / 2 + dx * mapS._s, mapS.H / 2 - dy * mapS._s];
    };
    mapDraw();
  }

  function mapDraw() {
    if (!mapS.ctx || !mapS.active) return;
    var C = mapS.ctx;
    C.clearRect(0, 0, mapS.W, mapS.H);
    if (mapS.layers.heat) {
      if (mapS.playhead != null) mapFlow(C); else mapHeatTeam(C);
    }
    if (mapS.layers.shots) mapShots(C);
    if (SHOW_KILL_LAYER && mapS.layers.kills) mapKills(C);
  }

  // Moving trails. At playhead p (0..1 through the match), each track draws
  // only the segment it travelled during [p - TRAIL, p], brightest at the
  // leading end and fading back along the tail -- so the strokes visibly
  // travel across the map instead of a static route lighting up.
  //
  // Points carry their own normalized progress (see _combine_flow_lines), so
  // every match animates on one shared clock regardless of its real length.
  var TRAIL = 0.09;   // how much match-progress the tail spans behind the head

  // user-adjustable flow rendering (see flowSettingsHtml). `keep` leaves the
  // travelled path on screen instead of fading it out, so a full sweep paints
  // the whole map; `density` draws every Nth line, which is the honest way to
  // trade completeness for legibility rather than silently shipping fewer.
  mapS.flow = { keep: false, density: 1, width: 1, speed: 1 };

  function mapFlow(C) {
    var lines = flowLinesFor(mapS.data);
    if (!lines.length) return;
    var head = mapS.playhead;
    var o = mapS.flow;
    C.save();
    C.globalCompositeOperation = "lighter";
    C.lineJoin = "round";
    C.lineCap = "round";
    for (var i = 0; i < lines.length; i += o.density) {
      var team = lines[i][0], pts = lines[i][1];
      if (!mapS.layers["team" + team]) continue;   // team hidden via its legend pill
      var col = TEAM_RGB[team];
      if (!col || !pts || pts.length < 2) continue;
      for (var j = 1; j < pts.length; j++) {
        var p = pts[j][0];
        var age = head - p;
        if (age < 0) break;                       // not travelled yet this sweep
        var lit = age <= TRAIL;
        if (!lit && !o.keep) continue;            // fade mode: only the window
        var fade = lit ? 1 - age / TRAIL : 0;
        var a = mapS.tf(pts[j - 1][1], pts[j - 1][2]);
        var b = mapS.tf(pts[j][1], pts[j][2]);
        // kept path sits at a low constant alpha so the moving head still
        // reads as the "now" against everything already travelled
        var alpha = lit ? 0.5 * fade * fade + 0.08 : 0.3;
        C.strokeStyle = "rgba(" + col + "," + alpha.toFixed(3) + ")";
        C.lineWidth = o.width * (lit ? 0.7 + 1.6 * fade : 0.7);
        C.beginPath();
        C.moveTo(a[0], a[1]);
        C.lineTo(b[0], b[1]);
        C.stroke();
      }
    }
    C.restore();
  }

  function flowSettingsHtml(d) {
    var total = flowLinesFor(d).length;
    return '<div class="flow-settings small">' +
      '<label>Trails <select id="flow-keep">' +
        '<option value="0">Fade out</option><option value="1">Keep on screen</option>' +
      "</select></label>" +
      '<label>Lines <select id="flow-density">' +
        '<option value="1">All (' + total + ")</option>" +
        '<option value="2">Half</option><option value="4">Quarter</option>' +
      "</select></label>" +
      '<label>Width <select id="flow-width">' +
        '<option value="0.7">Thin</option><option value="1" selected>Normal</option>' +
        '<option value="1.6">Thick</option>' +
      "</select></label>" +
      '<label>Speed <select id="flow-speed">' +
        '<option value="0.5">Slow</option><option value="1" selected>Normal</option>' +
        '<option value="2">Fast</option>' +
      "</select></label>" +
      "</div>";
  }

  // Map pages ship pooled flowLines; a single match's view doesn't, but its
  // raw tracks already carry [t,x,y], so derive the same shape from those
  // (normalized against that match's own span) and cache it on the dataset.
  function flowLinesFor(d) {
    if (!d) return [];
    if (d.flowLines) return d.flowLines;
    if (d._flowCache) return d._flowCache;
    var tracks = (d.tracks || []).filter(function (t) {
      return t.pts && t.pts.length > 1 && (t.team === 0 || t.team === 1);
    });
    var span = 0;
    tracks.forEach(function (t) { span = Math.max(span, t.pts[t.pts.length - 1][0]); });
    d._flowCache = span <= 0 ? [] : tracks.map(function (t) {
      return [t.team, t.pts.map(function (p) { return [p[0] / span, p[1], p[2]]; })];
    });
    return d._flowCache;
  }

  // Actual per-tank movement paths (not a binned density grid), rendered as
  // thin glowing lines with additive ("lighter") blending. Colored by fixed
  // team id (0=Team A, 1=Team B) -- never by which side recorded the
  // replay, so it means the same thing on every page.
  //
  // Deliberately simple: draw each team's real polylines directly onto the
  // map canvas, semi-transparent, with additive blending. Two passes per
  // line (a faint wide halo + a thin brighter core) give the glow; the
  // lines stay thin and the minimap stays visible underneath. Where green
  // and red strokes overlap, additive blending climbs toward yellow on its
  // own at busy crossings -- which reads as "contested" without needing a
  // heavier per-pixel recolor pass (an earlier attempt at that made the
  // whole thing thick and opaque, hiding the map).
  function mapHeatTeam(C) {
    var lines = mapS.data.trackLines || [];
    if (!lines.length) return;
    // One match draws about 40 track lines. A map aggregates every match ever
    // decoded on it and draws up to 6,000, through additive blending, so a
    // single fixed alpha cannot serve both ends. It was tuned at the match
    // end, where it looks right; at the map end the strokes piled up until 18%
    // of the canvas was flat white and the mean pixel sat at 158 against a
    // match's 10. Blowing out costs exactly the information the heatmap is for
    // -- once a spot clips to white it stops saying "busier than that one",
    // and the team colour is gone from the ground with the heaviest traffic.
    //
    // So alpha comes down as the line count climbs. sqrt rather than 1/n: an
    // aggregate really does hold more than one match and should still read
    // warmer, it just should not saturate. Counted over VISIBLE lines, so
    // hiding a team via its legend pill brightens what is left instead of
    // leaving it dimmed for traffic no longer on screen.
    var visible = 0;
    for (var k = 0; k < lines.length; k++) {
      if (mapS.layers["team" + lines[k][0]]) visible++;
    }
    if (!visible) return;
    var dim = Math.min(1, Math.sqrt(HEAT_REF_LINES / visible));
    C.save();
    C.globalCompositeOperation = "lighter";
    C.lineJoin = "round"; C.lineCap = "round";
    [[6, 0.05], [1.5, 0.22]].forEach(function (spec) {
      var width = spec[0], alpha = spec[1] * dim;
      lines.forEach(function (line) {
        var team = line[0], pts = line[1];
        if (!mapS.layers["team" + team]) return;   // team hidden via its legend pill
        var col = TEAM_RGB[team];
        if (!col || !pts || pts.length < 2) return;
        C.beginPath();
        for (var i = 0; i < pts.length; i++) {
          var xy = mapS.tf(pts[i][0], pts[i][1]);
          if (i === 0) C.moveTo(xy[0], xy[1]); else C.lineTo(xy[0], xy[1]);
        }
        C.strokeStyle = "rgba(" + col + "," + alpha + ")";
        C.lineWidth = width;
        C.stroke();
      });
    });
    C.restore();
  }

  function mapShots(C) {
    C.save(); C.fillStyle = "rgba(90,210,255,.9)";   // cyan, distinct from team/overlap hues
    mapS.data.shots.forEach(function (s) { var xy = mapS.tf(s[0], s[1]); C.beginPath(); C.arc(xy[0], xy[1], 1.6, 0, 7); C.fill(); });
    C.restore();
  }

  // A match view and a map aggregate both carry killLines; an older cached
  // file carries neither, and the chip is hidden rather than shown dead.
  function killLinesFor(d) { return (d && d.killLines) || []; }

  // Every kill as a line from whoever fired to whoever died, with a dot at
  // the dying end. The heatmap next to it shows where tanks SPENT time, which
  // is mostly driving; this shows where the fighting landed and which way it
  // was facing, so firing lanes and the ground people die on both stand out.
  function mapKills(C) {
    var lines = killLinesFor(mapS.data);
    if (!lines.length) return;
    C.save();
    C.lineCap = "round";
    // Each line is faint so that the lanes emerge from hundreds overlapping
    // rather than from any single kill. The floor matters: on a map with only
    // a handful of decoded matches the whole layer would otherwise be
    // invisible, and an empty looking layer reads as broken.
    var alpha = Math.max(0.16, Math.min(0.55, 70 / lines.length));

    // Dark underlay first, whole layer at once. The minimaps are busy
    // terrain art and a 1px coloured line on its own disappears into it;
    // this is the same trick as a text outline.
    C.strokeStyle = "rgba(0,0,0,0.5)";
    C.lineWidth = 3.2;
    C.beginPath();
    for (var j = 0; j < lines.length; j++) {
      var u = mapS.tf(lines[j][0], lines[j][1]), w = mapS.tf(lines[j][2], lines[j][3]);
      C.moveTo(u[0], u[1]); C.lineTo(w[0], w[1]);
    }
    C.stroke();

    C.lineWidth = 1.6;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      var a = mapS.tf(L[0], L[1]), b = mapS.tf(L[2], L[3]);
      var rgb = TEAM_RGB[L[4]] || "234,179,8";
      var grad = C.createLinearGradient(a[0], a[1], b[0], b[1]);
      // Warm at the shooter, team coloured at the victim, so a line reads
      // directionally without needing an arrowhead at this size.
      grad.addColorStop(0, "rgba(255,209,102," + (alpha * 0.75).toFixed(3) + ")");
      grad.addColorStop(1, "rgba(" + rgb + "," + Math.min(1, alpha * 2.4).toFixed(3) + ")");
      C.strokeStyle = grad;
      C.beginPath(); C.moveTo(a[0], a[1]); C.lineTo(b[0], b[1]); C.stroke();
      // the tank that died, ringed so it stays a dot rather than melting
      // into whatever it is sitting on
      C.beginPath(); C.arc(b[0], b[1], 3, 0, 7);
      C.fillStyle = "rgba(" + rgb + "," + Math.min(1, alpha * 3.2).toFixed(3) + ")";
      C.fill();
      C.strokeStyle = "rgba(0,0,0,0.55)"; C.lineWidth = 1; C.stroke();
      C.lineWidth = 1.6;
    }
    C.restore();
  }

  // The same radar for a map, against the other maps. Scaled to the highest
  // value any map reaches rather than to percentiles, because five or six maps
  // is too few for a percentile to mean much.

  // ---- Network (#/network): who has played with who ----
  //
  // Built in the browser from site_data's match rosters rather than shipped
  // as its own file. Two players share an edge if they were in the same
  // match, either side. 281 matches of 16 is about 34,000 pairs, which is a
  // few milliseconds of work and no extra download, where the finished graph
  // would have been another 600 KB.
  //
  // Everything here uses the same labels and ids as the rest of the site, so
  // a player who has set themselves private is redacted the same way.


  // Breadth first, so the first time a player is reached is by the fewest
  // hops. Ties are broken by the heavier edge, which makes the chain read as
  // the route you would actually recognise rather than an arbitrary one.

  // The web itself, every player, on canvas.
  //
  // Stars and satellites, not rings. The busiest players become stars, spread
  // evenly over the canvas; everybody else is parked next to the star they
  // actually play with, so a cluster is a group of people who share games.
  //
  // Which star somebody belongs to is decided on shared matches divided by the
  // square root of that star's own reach, not on shared matches alone. Without
  // that correction one player is the strongest connection for almost everyone
  // on the site, purely because most of the archive is their recordings, and
  // every cluster but theirs comes out empty.
  var netLayout = null;
  // A group smaller than this is not a cluster, it is a dot on its own.

  // which star a non-star already belongs to


  // View transform over the fixed layout. Layout coordinates are 0..1000; a
  // node lands at (lx * fit * k + tx) where fit maps the layout to the canvas
  // and k is the zoom. Kept as plain numbers rather than a canvas transform so
  // hit testing can invert it directly.
  var netView = { k: 1, tx: 0, ty: 0, base: null, key: "", box: 0 };
  var MAX_ZOOM = 14;



  // The static layer: every edge, every node, and the labels that fit. Drawn
  // once per view change into an offscreen canvas.

  // Blit the static layer, then whatever is moving on top of it.

  // One hop at a time, so a three step chain reads as three steps.
  var netAnim = null, netAnimEnd = null;
  var NET_HOP_MS = 620;




  // Two players' shapes on one web. The connection between them is a fact
  // about who they play with; this is the other half, how they play.



  // The raw token comes back exactly once, at creation, and is stored here
  // only as a hash, so it is shown loudly rather than listed quietly with the
  // others afterwards.
  function renderTokenList(list) {
    var box = document.getElementById("toklist");
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = '<span class="dim">No tokens yet.</span>';
      return;
    }
    box.innerHTML = '<table class="tok-table"><tbody>' + list.map(function (tk) {
      return "<tr><td><b>" + esc(tk.label || "Token") + "</b> " +
        '<span class="mono dim">' + esc(tk.id) + "</span></td>" +
        '<td class="dim">' + esc(fmtDateTime(Math.floor((tk.created || 0) / 1000))) + "</td>" +
        '<td><button class="orient-btn tok-revoke" data-id="' + esc(tk.id) +
        '">Revoke</button></td></tr>';
    }).join("") + "</tbody></table>";
    box.querySelectorAll(".tok-revoke").forEach(function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        fetch("/api/tokens", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "revoke", id: b.dataset.id }),
        }).then(function (r) { return r.json(); })
          .then(function (d) { renderTokenList(d.tokens || []); })
          .catch(function () { b.disabled = false; });
      });
    });
  }

  function wireTokens() {
    var box = document.getElementById("tokbox");
    if (!box) return;
    if (!currentUser.loggedIn) {
      box.innerHTML = '<p class="small" style="margin:0 0 10px">Sign in with Steam ' +
        "to make a token.</p>" +
        '<a class="up-dl" href="/auth/steam/login">Sign in with Steam</a>';
      return;
    }
    box.innerHTML =
      '<div id="toklist" class="small">Loading</div>' +
      '<div class="tok-new"><input id="toklabel" class="net-input" ' +
      'placeholder="What is it for, e.g. my PC" maxlength="40">' +
      '<button class="orient-btn" id="tokmake">Create token</button></div>' +
      '<div id="tokout"></div>';

    fetch("/api/tokens").then(function (r) { return r.json(); })
      .then(function (d) { renderTokenList(d.tokens || []); })
      .catch(function () {
        var l = document.getElementById("toklist");
        if (l) l.innerHTML = '<span class="dim">Could not load tokens.</span>';
      });

    document.getElementById("tokmake").addEventListener("click", function () {
      var btn = this;
      var label = (document.getElementById("toklabel") || {}).value || "Uploader";
      btn.disabled = true;
      fetch("/api/tokens", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", label: label }),
      }).then(function (r) { return r.json(); })
        .then(function (d) {
          btn.disabled = false;
          var out = document.getElementById("tokout");
          if (!out) return;
          if (d.error) {
            out.innerHTML = '<div class="tok-new-out">' + esc(d.error) + "</div>";
            return;
          }
          out.innerHTML = '<div class="tok-new-out"><b>Copy this now.</b> It is not ' +
            "shown again, and nothing here stores it in a form anyone can read back." +
            '<div class="tok-value mono">' + esc(d.token) + "</div></div>";
          fetch("/api/tokens").then(function (r) { return r.json(); })
            .then(function (dd) { renderTokenList(dd.tokens || []); })
            .catch(function () {});
        })
        .catch(function () { btn.disabled = false; });
    });
  }

  // ---- Explore (#/explore): the archive, filtered by hand ----------

  var exState = { map: "", winType: "", tank: "", minLen: 0, maxLen: 9999, result: "" };

  // ---- Play (#/play): two small games off the same numbers ---------




  // Deterministic-ish shuffle without Math.random being the only source, so a
  // question cannot repeat the previous one back to back.
  function pick(list, avoid) {
    for (var tries = 0; tries < 40; tries++) {
      var q = list[Math.floor(Math.random() * list.length)];
      if (!avoid || q !== avoid) return q;
    }
    return list[0];
  }




  // ---- Maps section: index (#/maps) + per-map page (#/map/<slug>) ----

  function findMap(slug) {
    var list = (DATA && DATA.maps) || [];
    var key = String(slug || "").toLowerCase();
    for (var i = 0; i < list.length; i++) { if (list[i].slug === key) return list[i]; }
    return null;
  }

  function renderMapsIndex() {
    var maps = (DATA.maps || []).slice().sort(function (a, b) { return b.games - a.games; });
    if (!maps.length) {
      APP.innerHTML = '<div class="page-head"><h1>Maps</h1></div>' +
        '<div class="panel empty-state"><div class="big">No map data yet</div>' +
        '<div class="sub">Upload a replay and the maps show up here.</div></div>';
      return;
    }
    var cards = maps.map(function (mp) {
      var href = "#/map/" + encodeURIComponent(mp.slug);
      return '<a class="map-card" href="' + href + '">' +
        mapHeroImgTag(mp.slug, "map-card-img") +
        '<div class="map-card-name">' + esc(mp.map) + "</div>" +
        '<div class="map-card-meta">' + fmtNum(mp.games) + (mp.games === 1 ? " match" : " matches") +
        " &middot; avg " + fmtClock(mp.avg_duration_sec) + "</div>" +
        "</a>";
    }).join("");
    APP.innerHTML = '<div class="page-head"><h1>Maps</h1>' +
      '<div class="small">' + maps.length + (maps.length === 1 ? " map" : " maps") + " with decoded match data</div></div>" +
      '<div class="maps-grid">' + cards + "</div>";
  }

  // A Tyr match ends one of three ways: Elimination (a team's health pool is
  // depleted), Capture (an objective is fully captured), or Tie (time runs
  // out with neither). Only categories the decoder actually populates with a
  // nonzero count are shown -- no "0 unknown" clutter, and no label invented
  // for a bucket the data can't back up.
  var WIN_TYPE_LABELS = [
    ["elimination", "chip-victory", "Elimination", "The losing team's health pool was recorded hitting 0"],
    ["capture", "chip-standard", "Capture", "An objective was fully captured"],
    ["tie", "chip-gray", "Tie", "Time ran out with neither team eliminated or capturing"],
  ];
  function winTypeChips(winType) {
    if (!winType) return '<span class="chip chip-gray">-</span>';
    var chips = WIN_TYPE_LABELS.map(function (row) {
      var key = row[0], cls = row[1], label = row[2], title = row[3];
      var n = winType[key] || 0;
      if (!n) return "";
      return '<span class="chip ' + cls + '" title="' + esc(title) + '">' +
        fmtNum(n) + " " + label + (n === 1 ? "" : "s") + "</span>";
    }).filter(Boolean);
    return chips.length ? chips.join(" ") : '<span class="chip chip-gray">-</span>';
  }

  function renderMapPage(slug) {
    var mp = findMap(slug);
    if (!mp) {
      APP.innerHTML =
        '<div class="panel not-found"><h2 style="border:none">Map not found</h2>' +
        '<p class="small">No map with slug <span class="mono">' + esc(slug) + "</span>.</p>" +
        '<p><a href="#/maps">&larr; Back to maps</a></p></div>';
      return;
    }
    var matches = DATA.matches.filter(function (m) {
      return (mp.match_ids || []).indexOf(m.match_id) !== -1;
    }).sort(function (a, b) { return (b.captured_unix || 0) - (a.captured_unix || 0); });

    var statCards =
      card("Matches", fmtNum(mp.games)) +
      card("Avg round time", fmtClock(mp.avg_duration_sec)) +
      card("Shortest round", fmtClock(mp.min_duration_sec)) +
      card("Longest round", fmtClock(mp.max_duration_sec)) +
      card("Team A winrate", fmtPct(mp.win_rate_a)) +
      card("Team B winrate", fmtPct(mp.win_rate_b)) +
      card("Avg DMG", fmtNum(mp.avg.dmg)) +
      card("Avg Kills", fmtNum(mp.avg.kills)) +
      card("Avg Assist", fmtNum(mp.avg.assist)) +
      card("Avg Blocked", fmtNum(mp.avg.blocked)) +
      card("Avg tanks destroyed", fmtNum(mp.avg_eliminations)) +
      card("Avg survival", fmtClock(mp.avg_survival_sec)) +
      card("Survival %", fmtPct(mp.avg_survival_pct));

    var tanksRows = (mp.tanks || []).length ? mp.tanks.map(function (t) {
      return "<tr>" +
        '<td class="tank"><span class="tank-cell">' + tankImgTag(t.tank_id, "tank-icon") +
        '<a href="' + tankHref(t) + '">' + esc(t.tank) + "</a></span></td>" +
        '<td class="num">' + fmtNum(t.games) + "</td>" +
        '<td class="num">' + fmtPct(Math.round((t.pick_rate || 0) * 1000) / 10) + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="3" class="small">No tank data.</td></tr>';

    APP.innerHTML =
      '<div class="page-head"><h1>' + esc(mp.map) + "</h1>" +
      '<div class="small">Aggregated from ' + fmtNum(mp.games) +
      (mp.games === 1 ? " decoded match" : " decoded matches") + "</div></div>" +
      '<div class="match-head panel"><div class="match-head-row">' +
      mapHeroImgTag(mp.slug, "match-head-map") +
      '<div class="match-head-facts small">' +
      "<div>Win type: " + winTypeChips(mp.win_type) + "</div>" +
      "</div></div></div>" +
      '<div class="stat-grid">' + statCards + "</div>" +
      '<div class="panel"><h2>Tanks played here</h2><div class="table-scroll"><table><thead><tr>' +
      "<th>Tank</th><th>Games</th><th>Pick rate</th>" +
      "</tr></thead><tbody>" + tanksRows + "</tbody></table></div></div>" +
      '<div id="map-heat-slot"><div class="panel"><p class="small">Loading heatmap…</p></div></div>' +
      '<div class="page-head" style="margin-top:4px"><h2 style="border:none;margin:0">Matches on this map</h2></div>' +
      matchesTableHtml(matches) +
      '<p><a href="#/maps">&larr; Back to maps</a></p>';

    // combined heatmap across every decoded match on this map
    var ticket = ++deepFill;
    loadJson("maps/" + encodeURIComponent(mp.slug) + ".json").then(function (deep) {
      if (ticket !== deepFill) return;
      var slot = document.getElementById("map-heat-slot");
      if (!slot) return;
      if (!deep || !deep.heatTeam || !deep.heatTeam.length) {
        slot.innerHTML = '<div class="panel"><p class="small">No heatmap data for this map yet.</p></div>';
        return;
      }
      slot.innerHTML = mapPanel(deep);
      initMapPanel(deep);
    });
  }

  // ---------------------------------------------------------------- router

  // The hash we were on before this one. A match opened from somebody's
  // profile used to send you back to ALL matches, which loses your place and
  // is the wrong destination: you were not browsing every match, you were
  // looking at that player.
  var prevHash = null;
  var currentHash = null;

  // ---- Data (#/data) --------------------------------------------------
  //
  // Six views of the archive, each built from DATA at render time. Nothing
  // here is written down as a figure in prose: a number that stops being true
  // stops being shown.

  function median(nums) {
    if (!nums.length) return null;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Every per-match player row in the archive, flattened once.
  // ---- Suites (#/data and #/data/<slug>) ---------------------------
  //
  // A suite is one themed page. The built in ones are declared here; anything
  // in site/suites/*.js pushes itself onto window.TYR_SUITES and shows up
  // alongside them with no change to this file. Each one supplies a preview,
  // which is a real miniature drawn from real numbers, because a wall of
  // identical icons tells you nothing about what is behind them.

  // The surface a suite file is allowed to use. Everything here is already
  // defined above; this just names what is supported, so a suite that sticks
  // to it keeps working when the internals move.
  // ---- preview drawing ------------------------------------------------
  //
  // A tile is 240x240, rendered at about 62% opacity behind a caption whose
  // scrim covers the bottom third. So: keep the subject in the upper two
  // thirds, and lean on shape rather than fine detail, because none of it
  // survives being shrunk and dimmed.

  var PV_UID = 0;
  // A vertical fade, used to give filled areas some depth.
  // values -> a smooth-ish polyline across the box, plus the same closed to
  // the floor so it can be filled.
  // Stable pseudo-random from a string, so a tile looks the same every visit.
  // Parked, not deleted. These still render, still work and still answer to
  // their own URL; they just do not sit on the front of the hub any more.
  // Everything here is one line away from coming back.
  // Parked on the main site, present on the WIP build. Explore is a filtering
  // tool rather than something to read, which is not what the four tiles are for.
  var PARKED = { explore: 1 };

  // The hub is a wall to be judged, so the tiles are grouped by what they are
  // rather than by script-tag order. A slug missing from here still shows up,
  // under Everything else, which is how a new suite appears without this list
  // needing to know about it first.
  // The main site shows four. Everything else is built and kept, and lives on
  // the WIP site; see tools/build_wip.py. A slug missing here still appears,
  // under Everything else, so a new suite shows up without editing this.
  var GROUPS = [
    { name: "", slugs: ["odd", "gallery", "stats", "deep"] },
  ];

  // Each suite may ship its own CSS. Injected once, on first use, so a suite
  // nobody opens costs nothing.
  var SUITE_CSS_DONE = {};
  // The strip under the header on a suite page: a way back and a way sideways.
  // It lives outside #app so it survives the page rewriting itself, which the
  // older pages do on every interaction.
  // stats.json and the official sheet are loaded lazily, and a suite reads
  // them straight off the object it is handed. Without this a suite opened
  // from a cold start, by a bookmark or a shared link, would find both null
  // and quietly render an almost empty page: not an error, just nothing. Both
  // calls are memoised, so this costs one fetch each per session.
  // The parked wall. Same tiles, same previews, just not on the front.
  // The hash a suite was opened at, so an async fill can tell whether the
  // reader is still on the page it was fetched for. It used to assume
  // "#/data/<slug>", which stopped being true when Statistics and More stats
  // became top-level tabs, and both then sat on their loading panel.
  var suiteHash = null;

  function router() {
    stopMap(); // cancel any running map-heat animation before leaving/re-rendering
    var hash = location.hash || "#/";
    if (hash !== currentHash) { prevHash = currentHash; currentHash = hash; }
    upRenderDock();
    var m;
    if (!DATA) {
      // LOAD_STATE tells these apart; !DATA alone cannot.
      if (LOAD_STATE === "error") renderLoadError();
      else if (LOAD_STATE === "loading") renderLoading();
      else renderEmptyState();
      setActiveTab(null);
      return;
    }
    // player-identifying routes are off for this deployment (see
    // SHOW_PLAYER_PAGES above) -- bounce straight to Maps, the default.
    // best-battles is included here too: every row links to a player.
    if (!SHOW_PLAYER_PAGES && (
        hash === "#/players" || hash === "#/matches" || hash === "#/best-battles" ||
        hash === "#/network" || hash === "#/explore" ||
        hash === "#/data/network" || hash === "#/data/explore" ||
        /^#\/match\//.test(hash) || /^#\/player\//.test(hash))) {
      location.hash = "#/maps";
      return;
    }
    // Everything that used to live behind a suite or the Data tab is gone.
    // Old links land on Maps rather than on nothing.
    if (/^#\/(network|explore|play|clans|sheet|stats|deep|averages|data)$/.test(hash) ||
        /^#\/data\/[a-z0-9-]+$/.test(hash)) {
      location.hash = "#/maps";
      return;
    }
    if (hash === "#/" || hash === "#" || hash === "" || hash === "#/maps" || hash === "#/map") {
      // "#/", "#/map" (the old Battle Map tab's URL) all land on the same
      // Maps index -- Maps is the site's home page.
      renderMapsIndex();
      setActiveTab("maps");
    } else if (hash === "#/players") {
      renderLeaderboard();
      setActiveTab("players");
    } else if (hash === "#/matches") {
      renderMatches();
      setActiveTab("matches");
    } else if ((m = hash.match(/^#\/match\/(.+)$/))) {
      renderMatch(decodeURIComponent(m[1]));
      setActiveTab("matches");
    } else if (hash === "#/tanks") {
      renderTanks();
      setActiveTab("tanks");
    } else if (hash === "#/best-battles") {
      renderBestBattles();
      setActiveTab("best-battles");
    } else if (hash === "#/online") {
      renderOnline();
      setActiveTab(null);
    } else if (hash === "#/upload" || hash === "#/uploader") {
      renderUpload();
      setActiveTab("upload");
    } else if (hash === "#/about") {
      renderAbout();
      setActiveTab(null);
    } else if ((m = hash.match(/^#\/player\/(.+)$/))) {
      renderPlayer(decodeURIComponent(m[1]));
      setActiveTab(null);
    } else if ((m = hash.match(/^#\/tank\/(.+)$/))) {
      renderTank(decodeURIComponent(m[1]));
      setActiveTab(null);
    } else if ((m = hash.match(/^#\/map\/(.+)$/))) {
      renderMapPage(decodeURIComponent(m[1]));
      setActiveTab("maps");
    } else {
      renderNotFoundRoute();
      setActiveTab(null);
    }
  }

  // ---------------------------------------------------------------- boot

  if (!SHOW_PLAYER_PAGES) {
    ["players", "matches", "best-battles"].forEach(function (route) {
      var a = TABS.querySelector('a[data-route="' + route + '"]');
      if (a) a.remove();
    });
  }

  // Upload ships hidden in the markup and is only revealed once /api/me
  // says the visitor is signed in, so it never flashes into view during
  // that round trip. Hiding it is presentation only: the edge is what
  // actually refuses an upload from a signed out visitor.
  function syncUploadTab() {
    var a = TABS.querySelector('a[data-route="upload"]');
    if (!a) return;
    if (currentUser.loggedIn) a.removeAttribute("hidden");
    else a.remove();
  }

  APP.innerHTML = '<div class="panel"><p class="small">Loading…</p></div>';

  // One failed fetch used to be fatal: any blip put "Could not load the data"
  // on the screen and left it there until the visitor thought to reload. There
  // are two ways to get that blip and neither is rare. A deploy rewrites
  // site_data.json in place, so a request landing mid-write reads a truncated
  // file and r.json() throws; and the file is 7 MB from a 1 GB box, so a slow
  // connection can simply give up.
  //
  // Both are transient by nature, which is exactly what a retry is for. Three
  // attempts with a short backoff, then give up and let the caller show the
  // error. The delay is deliberately longer than a deploy's write window.
  var LOAD_TRIES = 3;

  function loadJson(url, triesLeft) {
    var tries = triesLeft == null ? LOAD_TRIES : triesLeft;
    return fetch(url, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();          // throws on a half-written file
      })
      .catch(function () {
        if (tries <= 1) return null;
        var wait = (LOAD_TRIES - tries + 1) * 600;
        return new Promise(function (res) { setTimeout(res, wait); })
          .then(function () { return loadJson(url, tries - 1); });
      });
  }

  // Paint the loading state before the fetch, otherwise the page is simply
  // blank for however long site_data.json takes, which on a cold edge cache
  // is a couple of seconds.
  renderLoading();

  Promise.all([loadJson("site_data.json"), loadJson("match_data.json"), loadJson("/api/me")])
    .then(function (res) {
      DATA = res[0];
      REPLAY = res[1];
      // loadJson swallows failures into null, so null here means the fetch
      // did not come back, not that the site is empty.
      LOAD_STATE = res[0] ? "ready" : "error";
      if (res[2] && res[2].loggedIn) currentUser = res[2];
      syncUploadTab();
      updateUpdatedLabel();
      renderAuthWidget();
      router();
    })
    .catch(function () {
      LOAD_STATE = "error";
      router();
    });

  // Live-ish Steam player count: a scheduled job (tools/live_refresh.py, every
  // 1 min) keeps site_data.json fresh on disk; poll it and patch just the
  // #steam-panel DOM node in place so an open tab picks up new numbers
  // without disrupting whatever the visitor is doing (search text, table
  // sort, scroll position). Silently no-ops on any page that isn't currently
  // showing the panel (Leaderboard normally, or Tanks when player pages are
  // hidden -- see renderTanks/SHOW_PLAYER_PAGES).
  function refreshLiveSteam() {
    loadJson("site_data.json").then(function (fresh) {
      if (!fresh) return;
      DATA = fresh;
      updateUpdatedLabel();
      var panel = document.getElementById("steam-panel");
      if (panel) panel.outerHTML = steamChartSection();
    });
  }

  window.addEventListener("hashchange", router);
  window.addEventListener("resize", function () { if (mapS.active) mapResize(); });
  setInterval(updateUpdatedLabel, 30000);
  setInterval(refreshLiveSteam, 20000);
})();
