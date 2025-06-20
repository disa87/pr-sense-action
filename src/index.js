import * as core from "@actions/core";
import * as github from "@actions/github";
import OpenAI from "openai";

try {
  const openai = new OpenAI({ apiKey: core.getInput("openai_key") });
  const octo   = github.getOctokit(process.env.GITHUB_TOKEN);
  const { owner, repo, number } = github.context.issue;

  // Diff holen
  const { data: diff } = await octo.rest.pulls.get({
    owner, repo, pull_number: number,
    mediaType: { format: "diff" }
  });

  // Zusammenfassung erzeugen
  const chat = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content:
        `Fasse dieses Git-Diff in DE+EN (max 250 Zeichen) ` +
        `und liste Breaking Changes:\n\n${diff}`
    }],
    max_tokens: 300
  });

  // Kommentar zurück in den PR
  await octo.rest.issues.createComment({
    owner, repo, issue_number: number,
    body: chat.choices[0].message.content
  });

} catch (err) {
  core.setFailed(err.message);
}
