# King Bob's Kingdom — Plugins & Skills

These are the **publicly available** Claude Code plugins that power the kingdom experience. None are
required by the dashboard itself — it runs on the hooks alone — but together they're roughly the
toolset King Bob's kingdom uses day to day. Any private or employer-internal plugins have been
deliberately left out; everything below installs from public GitHub marketplaces.

> Run these commands **inside a Claude Code session** (they're slash commands). Integration plugins
> (Linear, Stripe, Supabase, …) connect to third-party services and need *your own* accounts and
> API keys — add only the ones you use.

## 1. Add the marketplaces

```
/plugin marketplace add anthropics/claude-plugins-official
/plugin marketplace add anthropics/claude-code
/plugin marketplace add wshobson/agents
/plugin marketplace add usernametron/claude-code-arsenal
/plugin marketplace add obra/superpowers
/plugin marketplace add leonxlnx/taste-skill
```

(You can also browse everything interactively with just `/plugin`.)

## 2. Core kingdom experience

The persona, skill system, and output styles that define how King Bob works.

```
/plugin install superpowers@claude-plugins-official          # skill-driven workflows (brainstorming, debugging, ...)
/plugin install everything-claude-code@everything-claude-code # broad agent + skill harness (many dashboard agent types)
/plugin install skill-creator@claude-plugins-official         # author your own skills
/plugin install claude-md-management@claude-plugins-official  # manage CLAUDE.md files
/plugin install claude-code-setup@claude-plugins-official     # guided environment setup
/plugin install ralph-loop@claude-plugins-official            # autonomous task loops
/plugin install taste-skill@taste-skill                       # design taste / UI judgment
/plugin install explanatory-output-style@claude-code-plugins  # "explanatory" mode
/plugin install learning-output-style@claude-code-plugins     # "learning" mode
```

## 3. Development & review workflow

The agents and commands behind planning, reviewing, and refactoring.

```
/plugin install code-review@claude-code-plugins
/plugin install pr-review-toolkit@claude-code-plugins
/plugin install code-simplifier@claude-plugins-official
/plugin install code-refactoring@claude-code-workflows
/plugin install agent-teams@claude-code-workflows
/plugin install feature-dev@claude-code-plugins
/plugin install commit-commands@claude-code-plugins
/plugin install hookify@claude-code-plugins
/plugin install frontend-design@claude-code-plugins
/plugin install security-guidance@claude-code-plugins
/plugin install agent-sdk-dev@claude-code-plugins
/plugin install plugin-dev@claude-code-plugins
```

## 4. Language servers (optional, per language)

Install only the ones for languages you work in.

```
/plugin install typescript-lsp@claude-plugins-official
/plugin install pyright-lsp@claude-plugins-official
/plugin install gopls-lsp@claude-plugins-official
/plugin install rust-analyzer-lsp@claude-plugins-official
/plugin install jdtls-lsp@claude-plugins-official
/plugin install kotlin-lsp@claude-plugins-official
/plugin install csharp-lsp@claude-plugins-official
/plugin install php-lsp@claude-plugins-official
/plugin install clangd-lsp@claude-plugins-official
/plugin install lua-lsp@claude-plugins-official
/plugin install swift-lsp@claude-plugins-official
```

## 5. Service integrations (optional — bring your own accounts/keys)

```
/plugin install context7@claude-plugins-official    # live library documentation
/plugin install playwright@claude-plugins-official   # browser automation
/plugin install linear@claude-plugins-official
/plugin install asana@claude-plugins-official
/plugin install gitlab@claude-plugins-official
/plugin install stripe@claude-plugins-official
/plugin install supabase@claude-plugins-official
/plugin install firebase@claude-plugins-official
/plugin install greptile@claude-plugins-official
```

---

*Install what serves you, my lord — the kingdom stands with none of these, and thrives with the ones
you actually use.*
