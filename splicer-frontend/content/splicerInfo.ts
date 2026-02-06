/**
 * Splicer info modal content (markdown).
 * Used by SplicerInfoModal for "How it works" / limitations / usage.
 */
export const SPLICER_INFO_MARKDOWN = `
## How To Use

All migrations are written to a **\`splice\`** branch (not \`main\`/\`master\`). To use the updated version you can either:

**Merge on GitHub**

- Open the repo on GitHub, create a Pull Request from \`splice\` → \`main\`, then merge.

**Clone the splice branch locally**

\`\`\`bash
git clone -b splice https://github.com/OWNER/REPO.git
\`\`\`

- Replace \`OWNER\` with your GitHub username.
- Replace \`REPO\` with your repository name.

---

## Live Preview (WebContainer)

The in-app preview only works for **Node.js** projects.

**Supported:** npm, yarn, pnpm; frameworks like Vite, Next.js, Nuxt, SvelteKit, Angular, Svelte, Vue, React.

**Python, Java, Go, etc.:** The agent still runs and migrates code; you just won't get a live preview in the browser. Use your repo locally or in CI to verify.

---

## How It Works

Splicer uses a multi-agent pipeline built on LangGraph to migrate code from a **source** repository into a **target** repository.

\`\`\`mermaid
flowchart TD
    START([START])
    START --> SplicerSetup
    START --> PlannerAPI

    SplicerSetup["<b>Splicer Setup</b><br/>Creates splice branch in target repo"]
    PlannerAPI["<b>Planner API</b><br/>Normalizes user input into a structured plan"]

    PlannerAPI --> TargetAgent
    PlannerAPI --> SourceAgent

    TargetAgent["<b>Target Agent</b><br/>Analyzes WHERE to put the code (paths, styles)"]
    SourceAgent["<b>Source Agent</b><br/>Identifies WHAT code to copy (files, deps)"]

    SplicerSetup --> PasterAgent
    TargetAgent --> PasterAgent
    SourceAgent --> PasterAgent

    PasterAgent["<b>Paster Agent</b><br/>Copies files to target paths in single commit"]
    PasterAgent --> IntegratorAgent

    IntegratorAgent["<b>Integrator Agent</b><br/>Adapts code: fix imports, add deps, wire into app"]
    IntegratorAgent --> CheckNode

    CheckNode["<b>Check Node</b><br/>Validates: syntax, dependencies, JSON configs"]
    CheckNode --> CleanUp

    CleanUp["<b>Clean Up</b><br/>Finalizes state"]
    CleanUp --> END([END])
\`\`\`

`.trim();
