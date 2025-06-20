import * as core from "@actions/core";
import * as github from "@actions/github";
import OpenAI from "openai";

// PR‑Sense: bilingual (DE & EN) pull‑request summariser with token‑cost guard.
// ‑ Limits TL;DR length, provides optional bullet list of breaking changes.
// ‑ Sends max 400 diff lines to the model (≈ few‑k tokens).
// ‑ Falls Diff länger, Modell mit erweitertem Kontextfenster verwenden.

async function run() {
  try {
    // === 1. Config ===
    const MAX_DIFF_LINES = 400;          // hard cap for model input
    const OPENAI_KEY     = core.getInput("openai_key", { required: true });
    const octo           = github.getOctokit(process.env.GITHUB_TOKEN);
    const { owner, repo, number } = github.context.issue;

    // === 2. Pull request diff holen ===
    const { data: diff } = await octo.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
      mediaType: { format: "diff" }
    });

    // === 3. Diff kürzen, um Tokens zu sparen ===
    const diffLines   = diff.split("\n");
    const slicedDiff  = diffLines.slice(0, MAX_DIFF_LINES).join("\n");

    // === 4. Prompt vorbereiten ===
    const userPrompt = `Erstelle ein zweisprachiges TL;DR (Deutsch & English) für den folgenden Git‑Diff.\n\n**Richtlinien**\n• Je Sprache max. 150 Zeichen.\n• Danach, falls Breaking Changes erkennbar sind, liste sie als Markdown‑Bullets.\n• Gibt es keine Breaking Changes, schreibe "Keine Breaking Changes."\n\n--- BEGIN DIFF ---\n${slicedDiff}\n--- END DIFF ---`;

    // Modellwahl je nach Diff‑Größe
    const modelChoice = slicedDiff.length > 15000 ? "gpt-4o-mini-200k" : "gpt-4o-mini";

    const openai = new OpenAI({ apiKey: OPENAI_KEY });
    const chat = await openai.chat.completions.create({
      model: modelChoice,
      messages: [
        { role: "system", content: "You are PR‑Sense, an assistant that writes concise bilingual pull‑request summaries." },
        { role: "user",   content: userPrompt }
      ],
      max_tokens: 350
    });

    const summary = chat.choices?.[0]?.message?.content?.trim() ||
                    "⚠️ Zusammenfassung konnte nicht generiert werden.";

    // === 5. Kommentar zurück in den PR schreiben ===
    await octo.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: summary
    });

  } catch (err) {
    core.setFailed(err.message);
  }
}

run();
