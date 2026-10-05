// Claude Bridge: long-poll verso il server locale, esegue comandi di SOLA LETTURA.
const DEFAULTS = { port: 8765, token: "" };
const MAX_BODY_DEFAULT = 8000;

async function cfg() {
  return browser.storage.local.get(DEFAULTS);
}

// ---------- helper ----------
async function allFolders() {
  const out = [];
  const accounts = await browser.accounts.list();
  for (const acc of accounts) {
    let roots = acc.folders;
    if (!roots && acc.rootFolder) {
      try { roots = await browser.folders.getSubFolders(acc.rootFolder, true); } catch (e) { roots = []; }
    }
    const walk = (list) => {
      for (const f of list || []) {
        out.push({ ref: `${f.accountId}|${f.path}`, account: acc.name, accountId: f.accountId, path: f.path, name: f.name, type: f.type || null, folder: f });
        if (f.subFolders) walk(f.subFolders);
      }
    };
    walk(roots);
  }
  return out;
}

async function resolveFolder(ref) {
  const all = await allFolders();
  const hit = all.find((f) => f.ref === ref) ||
    all.find((f) => f.path === ref) ||
    all.find((f) => f.type && f.type === ref);
  if (!hit) throw new Error("Cartella non trovata: " + ref);
  return hit.folder;
}

function folderQuery(folder) {
  return folder.id ? { folderId: folder.id } : { folder };
}

function brief(m) {
  return {
    id: m.id,
    date: m.date ? new Date(m.date).toISOString() : null,
    from: m.author,
    to: m.recipients,
    cc: m.ccList,
    subject: m.subject,
    read: m.read,
    flagged: m.flagged,
    folder: m.folder ? `${m.folder.accountId}|${m.folder.path}` : null,
  };
}

async function collect(listPromise, limit) {
  let page = await listPromise;
  const msgs = page.messages.slice();
  while (page.id && msgs.length < limit) {
    page = await browser.messages.continueList(page.id);
    if (!page.messages.length) break;
    msgs.push(...page.messages);
  }
  return msgs.slice(0, limit);
}

function stripHtml(h) {
  return h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

function extractBody(part) {
  let plain = "", html = "";
  (function walk(p) {
    if (p.body && !p.name) {
      if (/^text\/plain/i.test(p.contentType)) plain += p.body + "\n";
      else if (/^text\/html/i.test(p.contentType)) html += p.body + "\n";
    }
    (p.parts || []).forEach(walk);
  })(part);
  return plain.trim() || stripHtml(html);
}


async function identityByEmail(email) {
  for (const a of await browser.accounts.list()) {
    for (const i of a.identities || []) if (i.email.toLowerCase() === email.toLowerCase()) return i.id;
  }
  throw new Error("Identita' non trovata: " + email);
}

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function prependText(tab, text) {
  const d = await browser.compose.getComposeDetails(tab.id);
  if (d.isPlainText) {
    await browser.compose.setComposeDetails(tab.id, { plainTextBody: text + "\n\n" + (d.plainTextBody || "") });
  } else {
    const block = "<div>" + esc(text).replace(/\n/g, "<br>") + "</div><br>";
    const html = d.body || "";
    const m = html.match(/<body[^>]*>/i);
    const out = m ? html.replace(m[0], m[0] + block) : block + html;
    await browser.compose.setComposeDetails(tab.id, { body: out });
  }
}

async function finishCompose(tab, saveOnly) {
  if (!saveOnly) return { status: "finestra di scrittura aperta in Thunderbird, da rileggere e inviare a mano" };
  await browser.compose.saveMessage(tab.id, { mode: "draft" });
  try { await browser.windows.remove(tab.windowId); } catch (e) {}
  return { status: "bozza salvata nella cartella Bozze" };
}

// ---------- comandi ----------
const handlers = {
  async status() {
    const v = await browser.runtime.getBrowserInfo();
    const accs = await browser.accounts.list();
    return { app: v.name, version: v.version, accounts: accs.length };
  },

  async list_accounts() {
    return (await browser.accounts.list()).map((a) => ({ id: a.id, name: a.name, type: a.type }));
  },

  async list_folders() {
    return (await allFolders()).map(({ folder, ...rest }) => rest);
  },

  async list_messages({ folder, limit = 25, unreadOnly = false }) {
    const f = await resolveFolder(folder);
    const q = { ...folderQuery(f) };
    if (unreadOnly) q.unread = true;
    const msgs = await collect(browser.messages.query(q), limit);
    msgs.sort((a, b) => b.date - a.date);
    return msgs.map(brief);
  },

  async search({ query, from, to, subject, folder, fromDate, toDate, unreadOnly, flagged, hasAttachment, limit = 25 }) {
    const q = {};
    if (query) q.fullText = query;
    if (from) q.author = from;
    if (to) q.recipients = to;
    if (subject) q.subject = subject;
    if (fromDate) q.fromDate = new Date(fromDate);
    if (toDate) q.toDate = new Date(toDate);
    if (unreadOnly) q.unread = true;
    if (flagged) q.flagged = true;
    if (hasAttachment) q.attachment = true;
    if (folder) Object.assign(q, folderQuery(await resolveFolder(folder)));
    const msgs = await collect(browser.messages.query(q), limit);
    msgs.sort((a, b) => b.date - a.date);
    return msgs.map(brief);
  },

  async get_message({ id, maxChars = MAX_BODY_DEFAULT }) {
    const header = await browser.messages.get(id);
    const full = await browser.messages.getFull(id);
    let body = extractBody(full);
    const truncated = body.length > maxChars;
    if (truncated) body = body.slice(0, maxChars);
    let attachments = [];
    try {
      attachments = (await browser.messages.listAttachments(id)).map((a) => ({ name: a.name, type: a.contentType, size: a.size }));
    } catch (e) {}
    return { ...brief(header), attachments, truncated, body };
  },
  // ---------- scrittura (mai invio diretto) ----------
  async list_identities() {
    const out = [];
    for (const a of await browser.accounts.list()) {
      for (const i of a.identities || []) out.push({ identityId: i.id, email: i.email, name: i.name, account: a.name });
    }
    return out;
  },

  async list_tags() {
    return browser.messages.tags.list();
  },

  // Apre una finestra di scrittura precompilata (o salva solo la bozza). NON invia.
  async create_draft({ to, cc, bcc, subject, body = "", html = false, from, saveOnly = false }) {
    const d = { subject: subject || "" };
    if (to) d.to = to;
    if (cc) d.cc = cc;
    if (bcc) d.bcc = bcc;
    if (html) { d.body = body; d.isPlainText = false; } else { d.plainTextBody = body; d.isPlainText = true; }
    if (from) d.identityId = await identityByEmail(from);
    const tab = await browser.compose.beginNew(d);
    return finishCompose(tab, saveOnly);
  },

  async create_reply({ id, text, replyAll = false, saveOnly = false }) {
    const tab = await browser.compose.beginReply(id, replyAll ? "replyToAll" : "replyToSender");
    await prependText(tab, text);
    return finishCompose(tab, saveOnly);
  },

  async create_forward({ id, to, text = "", saveOnly = false }) {
    const tab = await browser.compose.beginForward(id, "forwardInline", to ? { to } : undefined);
    if (text) await prependText(tab, text);
    return finishCompose(tab, saveOnly);
  },

  async update_messages({ ids, read, flagged, junk, addTags, removeTags }) {
    const done = [];
    for (const id of ids) {
      const upd = {};
      if (read !== undefined) upd.read = read;
      if (flagged !== undefined) upd.flagged = flagged;
      if (junk !== undefined) upd.junk = junk;
      if (addTags || removeTags) {
        const cur = new Set((await browser.messages.get(id)).tags || []);
        (addTags || []).forEach((t) => cur.add(t));
        (removeTags || []).forEach((t) => cur.delete(t));
        upd.tags = [...cur];
      }
      await browser.messages.update(id, upd);
      done.push(id);
    }
    return { updated: done };
  },

  async move_messages({ ids, folder, copy = false }) {
    const f = await resolveFolder(folder);
    const dest = f.id ? f.id : f;
    if (copy) await browser.messages.copy(ids, dest); else await browser.messages.move(ids, dest);
    return { [copy ? "copied" : "moved"]: ids, to: folder };
  },

  // Solo verso il Cestino (nessuna cancellazione permanente).
  async trash_messages({ ids }) {
    await browser.messages.delete(ids);
    return { trashed: ids };
  },
};

// ---------- loop di polling ----------
async function loop() {
  let backoff = 1000;
  for (;;) {
    const { port, token } = await cfg();
    const base = `http://127.0.0.1:${port}`;
    const headers = { "X-Bridge-Token": token, "Content-Type": "application/json" };
    try {
      const r = await fetch(`${base}/poll`, { headers });
      if (r.status === 401) throw new Error("token non valido (aprire le opzioni dell'estensione)");
      if (r.status === 204 || !r.ok) { backoff = 1000; continue; }
      backoff = 1000;
      const cmd = await r.json();
      let payload;
      try {
        const h = handlers[cmd.method];
        if (!h) throw new Error("Metodo sconosciuto: " + cmd.method);
        payload = { id: cmd.id, ok: true, result: await h(cmd.params || {}) };
      } catch (e) {
        payload = { id: cmd.id, ok: false, error: String((e && e.message) || e) };
      }
      await fetch(`${base}/result`, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (e) {
      await new Promise((res) => setTimeout(res, backoff));
      backoff = Math.min(backoff * 2, 15000);
    }
  }
}

loop();
