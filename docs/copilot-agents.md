# Copilot agent system

This repository ships a reusable [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli) configuration: custom agents and skills that encode how we want work done on Bender.

It was ported from a large collection of Claude Code subagents. This document explains what exists, how to use it, how to extend it, and what did **not** map cleanly from the Claude setup.

---

## Where things live

| Kind | Location | Scope |
|---|---|---|
| Custom agents | `.github/agents/*.md` | This repository |
| Skills | `.github/skills/<name>/SKILL.md` | This repository |
| Repo instructions | `.github/copilot-instructions.md` | This repository |
| Personal agents | `~/.copilot/agents/*.md` | All your repositories |
| Personal skills | `~/.copilot/skills/<name>/SKILL.md` | All your repositories |

Project-level configuration takes precedence over personal configuration with the same name.

---

## Using an agent

Interactively:

```
/agent                      # browse the picker
/agent typescript-pro       # select directly
```

Non-interactively:

```bash
copilot --agent preset-safety-reviewer -p "Review the staged diff" --allow-all-tools
```

Agents without `disable-model-invocation: true` may also be selected automatically by Copilot when your request matches their `description`. That is why every agent's description starts with **"Use when …"** — the description *is* the routing signal.

To see what the CLI actually loaded:

```
/env
```

---

## Agents

### Bender-specific

These did not exist in the Claude collection. They encode this project's hard-won constraints.

| Agent | Use it when |
|---|---|
| `helix-preset-engineer` | Working on the `.hlx` parser, serializer, IR, or validation. Enforces round-trip safety and evidence discipline over guesswork. |
| `preset-safety-reviewer` | Reviewing any change that touches preset data. Read-only. Hunts round-trip corruption, lost unknown fields, missing audit entries, and unvalidated AI-driven writes. |
| `tone-eval-curator` | Adding or triaging cases in `evals/`. Turns a real-world failure into a permanent regression. |
| `signal-chain-analyst` | Reasoning about guitar signal chains, shaping model context, or writing tool descriptions. Explicitly forbids hardcoded tone rule tables. |

### Ported from the Claude collection

| Agent | Origin category | Use it when |
|---|---|---|
| `typescript-pro` | language-specialists | Advanced typing, generics, end-to-end type safety |
| `react-specialist` | language-specialists | React 18 components, hooks, rendering behavior |
| `node-specialist` | language-specialists | Node 20 ESM backend work |
| `api-designer` | core-development | Designing the HTTP surface between frontend and backend |
| `frontend-developer` | core-development | Building UI in the Vite/Tailwind app |
| `build-engineer` | developer-experience | Vite, pnpm workspace, TS project references, bundle size |
| `refactoring-specialist` | developer-experience | Structural refactors that must not change behavior |
| `code-reviewer` | quality-security | General review; includes a Bender preset-safety section |
| `test-automator` | quality-security | Vitest coverage, round-trip and property tests |
| `debugger` | quality-security | Root-causing a failure |
| `performance-engineer` | quality-security | Latency and bundle/runtime performance |
| `accessibility-tester` | quality-security | Keyboard, contrast, screen-reader behavior |
| `security-auditor` | quality-security | Secret handling, bundle credential leaks, log redaction |
| `llm-architect` | data-ai | Azure OpenAI Responses API, tool-calling loop design |
| `prompt-engineer` | data-ai | System prompts and tool descriptions |
| `deployment-engineer` | infrastructure | GitHub Actions, Pages, backend rollout |
| `azure-infra-engineer` | infrastructure | Azure OpenAI resource/deployment configuration |
| `documentation-engineer` | developer-experience | `docs/`, README, format notes |
| `agent-organizer` | meta-orchestration | Planning which agents to use for a multi-part task |
| `product-manager` | business-product | Scope control, writing crisp issues |

---

## Skills

Skills are task workflows rather than personas. Copilot loads them automatically when a request matches, or you can manage them with `/skills`.

| Skill | What it does |
|---|---|
| `bender-preset-intake` | Onboards a new real `.hlx` file: observe bytes, round-trip, record evidence by confidence level, leave a regression behind. |
| `bender-eval-case` | Turns an observed failure into a replayable eval case or unit regression, with guidance on calibrating specificity. |

---

## Adding another agent

1. Create `.github/agents/<name>.md`.
2. Write valid YAML frontmatter:

```yaml
---
name: my-agent
description: "Use when <specific trigger condition>."
tools: [read, edit, search, execute]
---

You are …
```

3. Write the prompt body in Markdown (max 30,000 characters).
4. Verify it loads:

```bash
copilot --agent my-agent -p "Describe your role in one sentence." --allow-all-tools
```

### Frontmatter reference

| Property | Type | Notes |
|---|---|---|
| `description` | string | **Required.** Drives both the picker and automatic selection. |
| `name` | string | Display name. Defaults to the filename. |
| `tools` | list or comma-separated string | Omit for all tools. `[]` for none. |
| `model` | string | Omit to inherit the session model. |
| `disable-model-invocation` | boolean | `true` = manual selection only. |
| `user-invocable` | boolean | `false` = hidden from the picker. |

### Tool aliases

Copilot CLI uses a small set of aliases, not raw tool names:

| Alias | Grants |
|---|---|
| `read` | Reading files |
| `edit` | Creating and modifying files |
| `search` | Glob and grep |
| `execute` | Shell commands |
| `web` | Web fetch and search |
| `agent` | Delegating to another custom agent |
| `todo` | Structured task lists |

Conventions we follow, inherited from the Claude collection:

- Reviewers and auditors: `[read, search]`
- Researchers: `[read, search, web]`
- Implementers: `[read, edit, search, execute]`
- Orchestrators: add `agent` and `todo`

---

## What was ported, and what was not

### Ported

- The **agent-per-specialty model** and the tool-permission-by-role-type convention.
- The opinionated **checklists, quality bars, and workflow phases** that made the Claude agents useful. These are the substance and they survived largely intact.
- The `description` field as the **auto-selection signal**, rewritten in "Use when …" form.

### Deliberately not ported

- **158+ agents.** We ported ~20 that match this stack. A picker full of `blockchain-developer`, `wordpress-master`, and `hipaa-compliance` is noise in a guitar-tone repository. The source collection remains available if we need more later.
- **`model:` values.** Claude agents pinned `sonnet` / `haiku` / `opus`. Those are not valid Copilot model identifiers, and hardcoding one would break the agent or silently pin a bad choice. All ported agents omit `model:` and inherit the session model. Per-agent model preferences can instead be set at runtime with `/subagents`.
- **The inter-agent "Communication Protocol" JSON blocks.** Claude agents contained handshake payloads like `{"requesting_agent": …}` and instructions to "query the context manager". Copilot CLI has no such protocol and no context-manager agent. These sections were replaced with a concrete **"How to start"** section telling the agent to read the actual repository files it needs.
- **`agent-installer`** and anything that installed agents from the upstream GitHub repository into `~/.claude/agents/`. Not applicable.
- **Kubernetes, Terraform, AWS, and Docker content** in the infrastructure agents. This repository has none of those. Keeping the material "just in case" would dilute the agents with irrelevant advice.

### Could not map 1:1

| Claude concept | Copilot CLI status |
|---|---|
| `model: sonnet` | No equivalent literal. Omitted; configure via `/subagents` if needed. |
| Context-manager handoff protocol | No equivalent. Replaced with direct repository inspection. |
| Claude tool names (`Bash`, `Glob`, `WebFetch`, …) | Mapped to Copilot aliases (`execute`, `search`, `web`, …). |
| `.claude/agents/` precedence rules | Equivalent behavior via `.github/agents/` over `~/.copilot/agents/`. |
| Marketplace plugin packaging (`.claude-plugin/marketplace.json`) | Copilot CLI has its own plugin system (`copilot plugin`). Not used here; repository-level agents are sufficient. |

---

## Source

The Claude collection lives outside this repository and was treated as read-only during the port. Nothing in this repository depends on it at runtime.
