import * as core from "@actions/core";
import * as github from "@actions/github";
import OpenAI from "openai";

// ------------------------------------------------------------
// PR‑Sense (v1.1)  –  bilingual summary + org‑wide usage counter
// * Zählt Pull‑Requests org‑weit in einem **privaten Gist**
// * Limits:  free=100  team=1 000  pro=10 000  enterprise=100 000 / Monat
// * Monats‑Reset erfolgt automatisch, weil Schlüssel "YYYY‑MM" genutzt werden
// * Secrets, die du im Repo anlegen musst:
//     ORG_GIST_ID     – die ID des privaten Gists   (z.B. "abcdef1234...")
//     ORG_GIST_TOKEN  – Fine‑grained PAT mit Gist read+write
// ------------------------------------------------------------

// ---------- Helper: org‑wide Gist store ---------------------------------
//  • Ein einziges Gist enthält **pro Kunde genau eine Datei**:
//    usage-<ACCOUNT_ID>.json  (z. B. usage-12345678.json)
//  • ACCOUNT_ID ist github.context.payload.repository.owner.id  ⇒ eindeutig pro Org/User
// -----------------------------------------------------------------------
const GIST_ID   = process.env.ORG_GIST_ID;
const GIST_HDR  = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${process.env.ORG_GIST_TOKEN}`
};

// gibt { plan, [YYYY-MM]: n } zurück (neu = {plan:"free"})
async function loadUsage(fileName) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: GIST_HDR });
  if (!res.ok) throw new Error("Gist‑Load fehlgeschlagen: " + res.status);
  const json = await res.json();
  const file = json.files[fileName];
  return file ? JSON.parse(file.content) : { plan: "free" };
}
// speichert Objekt in die kunden­bezogene Datei
async function saveUsage(fileName, obj) {
  const body = JSON.stringify({
    files: { [fileName]: { content: JSON.stringify(obj) } }
  });
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { ...GIST_HDR, "Content-Type": "application/json" },
    body
  });
  if (!res.ok) throw new Error("Gist‑Save fehlgeschlagen: " + res.status);
}
// -----------------------------------------------------------------------

async function run() {
  try {
    // === 0. Limits & Usage ===
    const planLimits = { free: 100, team: 1000, pro: 10000, enterprise: 100000 };

    // customer‑spezifische Datei bestimmen
    const accountId  = github.context.payload.repository.owner.id || "anon";
    const fileName   = `usage-${accountId}.json`;

    const usage      = await loadUsage(fileName);
    const monthKey   = new Date().toISOString().slice(0, 7);   // "YYYY‑MM"
    const plan       = usage.plan || "free";
    const prCount    = usage[monthKey] ?? 0;


    const MAX_DIFF_LINES = 400;
    const OPENAI_KEY     = core.getInput("openai_key", { required: true });
    const octo           = github.getOctokit(process.env.GITHUB_TOKEN);
    const { owner, repo, number } = github.context.issue;

    // Stoppen, wenn Limit erreicht
    if (prCount >= planLimits[plan]) {
      await octo.rest.issues.createComment({
        owner, repo, issue_number: number,
        body: `⚠️ **Plan‑Limit erreicht** – ${planLimits[plan]} PR/Monat für Plan **${plan}**.\n👉 Bitte Marketplace‑Upgrade durchführen.`
      });
      return;
    }

    // === 1. Diff holen & kürzen ===
    const { data: diff } = await octo.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
      mediaType: { format: "diff" }
    });

    const slicedDiff = diff.split("\n").slice(0, MAX_DIFF_LINES).join("\n");

    // === 2. Prompt zusammenbauen ===
const prompt = `
### Aufgabe
Gib exakt **drei** Zeilen zurück:

1. \`DE: …\`  (max 150 Zeichen, kurze Zusammenfassung auf Deutsch)
2. \`EN: …\`  (max 150 characters, same summary in English)
3. Eine Zeile für Breaking Changes:
   • <Deutsch> | <English>
   Wenn es keine Breaking Changes gibt, schreibe **genau**:
   • Keine Breaking Changes. | No breaking changes.

### Diff
${slicedDiff}
`;


    const model = slicedDiff.length > 15000 ? "gpt-4o-mini-200k" : "gpt-4o-mini";
    const openai = new OpenAI({ apiKey: OPENAI_KEY });
    const chat = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are PR‑Sense, an assistant that writes concise bilingual pull‑request summaries." },
        { role: "user", content: prompt }
      ],
      max_tokens: 350
    });

    const summary = chat.choices?.[0]?.message?.content?.trim() ||
                    "⚠️ Zusammenfassung konnte nicht generiert werden.";

    // === 3. Kommentar in den PR schreiben ===
    await octo.rest.issues.createComment({ owner, repo, issue_number: number, body: summary });

    // === 4. Usage hochzählen & speichern ===
    usage[monthKey] = (usage[monthKey] || 0) + 1;
    await saveUsage(fileName, usage);

  } catch (err) {
    core.setFailed(err.message);
  }
}

run();
