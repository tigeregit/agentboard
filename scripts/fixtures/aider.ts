import path from "node:path";
import type { Fixture } from "../demo-lib";

/** Aider: one multi-session `.aider.chat.history.md` per project under ~/code/<project>. */
export const aider: Fixture = (d) => {
  const header = (t: number) => `# aider chat started at ${d.iso(t).slice(0, 10)} ${d.iso(t).slice(11, 19)}`;
  const byProject = new Map<string, string[]>();
  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const project = path.join(d.HOME, "code", path.basename(s < 2 ? d.PROJECTS[0] : cwd));
    const lines: string[] = [header(start), "", "> /usr/local/bin/aider --model gpt-4o", "> Aider v0.86.1", "> Main model: gpt-4o with diff edit format", "> Weak model: gpt-4o-mini", `> Git repo: .git with ${120 + i} files`, "> Repo-map: using 1024 tokens, auto refresh", ""];
    for (const [k, t] of d.turns(i, start).entries()) {
      const prompt = k === 0 ? `Aider: ${t.user}` : t.user;
      for (const l of k === 0 ? [prompt, "Keep the diff small."] : [prompt]) lines.push(`#### ${l}`);
      lines.push("", t.reply, "");
      if (k === 0) {
        lines.push("```python", "def fix():", "    #### not a prompt, inside a fence", "    pass", "```", "");
      }
      lines.push(`> Tokens: ${1200 + k * 300} sent, ${400 + k * 50} received. Cost: $0.0${k + 1} message, $0.1${k} session.`);
      lines.push(`> Applied edit to ${t.tool === "Bash" ? "scripts/run.sh" : "src/main.py"}`);
      lines.push(`> Commit a1b2c3${k} ${t.user.slice(0, 40)}`, "");
    }
    const list = byProject.get(project) ?? [];
    list.push(lines.join("\n"));
    byProject.set(project, list);
  }
  for (const [project, sessions] of byProject) {
    d.write(path.join(project, ".aider.chat.history.md"), sessions.join("\n") + "\n");
    d.write(path.join(project, ".aider.input.history"), `# ${d.iso(d.now).slice(0, 19).replace("T", " ")}\n+hello\n`);
  }
};
