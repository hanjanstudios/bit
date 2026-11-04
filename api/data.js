// Bit Drawer sync API. Keeps the GitHub key on the server; the page only sends your password.
const crypto = require("crypto");
const REPO = process.env.GITHUB_REPO || "hanjanstudios/bit-data";
const FILE = "data.json";

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function gh(path, opts = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bit-drawer",
      ...(opts.headers || {}),
    },
  });
}
async function readContent(j) {
  if (j.content) return Buffer.from(j.content, "base64").toString("utf8");
  const r = await fetch(j.git_url, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "bit-drawer" } });
  const b = await r.json();
  return Buffer.from(b.content || "", "base64").toString("utf8");
}
function itemsOf(text) {
  const d = JSON.parse(text || "{}");
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d)) return d;
  throw new Error("not a Bit Drawer file");
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.BIT_PASSWORD || !process.env.GITHUB_TOKEN) return res.status(503).json({ error: "setup" });
  if (!same(req.headers["x-bit-password"] || "", process.env.BIT_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 800));
    return res.status(401).json({ error: "password" });
  }
  try {
    if (req.method === "GET") {
      const r = await gh(FILE, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        try { return res.json({ items: itemsOf(await readContent(j)), sha: j.sha }); }
        catch { return res.json({ items: [], sha: j.sha, note: "data.json isn't readable. Use Backup & export → Restore to replace it." }); }
      }
      if (r.status !== 404) return res.status(502).json({ error: "github", status: r.status });
      // No data.json: look for a renamed copy like "data (1).json".
      const lr = await gh("");
      const list = lr.ok ? await lr.json() : [];
      const jsons = (Array.isArray(list) ? list : []).filter((f) => f.type === "file" && /\.json$/i.test(f.name)).sort((a, b) => b.size - a.size);
      for (const f of jsons) {
        try {
          const fr = await gh(encodeURIComponent(f.name));
          if (!fr.ok) continue;
          return res.json({ items: itemsOf(await readContent(await fr.json())), sha: null, note: `Loaded your ideas from "${f.name}".` });
        } catch {}
      }
      return res.json({ items: [], sha: null, note: "Your drawer is empty. Use Backup & export → Restore to load a backup." });
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      if (!Array.isArray(body.items)) return res.status(400).json({ error: "items" });
      const payload = { message: "Update ideas", content: Buffer.from(JSON.stringify({ version: 1, items: body.items }, null, 1)).toString("base64") };
      if (body.sha) payload.sha = body.sha;
      const r = await gh(FILE, { method: "PUT", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } });
      if (r.status === 409 || r.status === 422) return res.status(409).json({ error: "conflict" });
      if (!r.ok) return res.status(502).json({ error: "github", status: r.status });
      const j = await r.json();
      return res.json({ sha: j.content.sha });
    }
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server" });
  }
};
