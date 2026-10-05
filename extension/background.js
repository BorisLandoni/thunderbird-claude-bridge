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

// ---------- comandi (solo lettura) ----------
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
