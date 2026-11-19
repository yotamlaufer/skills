# Skills

Agent skills for Claude Code and other coding agents, following the open [Agent Skills](https://agentskills.io) format.

| Skill | What it does |
| --- | --- |
| [guided-review](skills/guided-review) | Read a pull request in chapters, with Explain and comments answered on the page by a review session of its own |

## Install

Pick whichever fits how you work. Each method installs the same skill files.

### Claude Code plugin marketplace

In Claude Code:

```text
/plugin marketplace add yotamlaufer/skills
/plugin install guided-review@yotamlaufer-skills
```

Or from your shell:

```bash
claude plugin marketplace add yotamlaufer/skills
```

```bash
claude plugin install guided-review@yotamlaufer-skills
```

To update, refresh the marketplace and then the plugin:

```bash
claude plugin marketplace update yotamlaufer-skills
```

```bash
claude plugin update guided-review@yotamlaufer-skills
```

A skill installed as a plugin is invoked with the plugin's prefix, such as `/guided-review:guided-review`, and Claude also uses it whenever a request matches its description.

### The `skills` CLI

The [`skills`](https://github.com/vercel-labs/skills) CLI installs into Claude Code, Codex, Cursor and many other agents:

```bash
npx skills add yotamlaufer/skills --skill guided-review
```

Add `-g` to install for every project instead of the current one, or `-a claude-code` to pick the agent. `pnpm dlx`, `yarn dlx` and `bunx` work in place of `npx`.

### By hand

Clone the repository and copy, or link, a skill's folder into your agent's skills folder:

```bash
git clone https://github.com/yotamlaufer/skills.git
```

```bash
ln -s "$PWD/skills/skills/guided-review" ~/.claude/skills/guided-review
```

A link keeps the skill current with `git pull`.

## Layout

```text
.claude-plugin/marketplace.json   the Claude Code marketplace: one plugin per skill
skills/<name>/SKILL.md            the skill itself, read by the agent
skills/<name>/README.md           the skill's documentation, read by people
skills/<name>/scripts/            code the skill runs
```

Every skill follows the [Agent Skills specification](https://agentskills.io/specification): a folder named after the skill, a `SKILL.md` whose `name` matches the folder, and a `description` that says what the skill does and when to use it.

## Adding a skill

1. Create `skills/<name>/SKILL.md`, with `name` matching the folder: lowercase letters, digits and single hyphens, at most 64 characters.
2. Write `skills/<name>/README.md` for people: what the skill does, how to use it, what it needs, and how it works.
3. Add an entry to `.claude-plugin/marketplace.json`, in the same shape as `guided-review`'s: `"source": "./"`, `"strict": false`, and `"skills": ["./skills/<name>"]`.
4. Add a row to the table at the top of this file.
5. Check it:

   ```bash
   claude plugin validate .
   ```

When you change a skill, raise its version in both places, `metadata.version` in its `SKILL.md` and `version` in its marketplace entry. Plugin installs only pick up a change when the version moves.

## License

[MIT](LICENSE)
