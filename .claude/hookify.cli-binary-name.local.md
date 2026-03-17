---
name: cli-binary-name
enabled: true
event: all
action: warn
conditions:
  - field: content
    operator: regex_match
    pattern: \b(claudeinsight|codeinsight|code-insight)\s+(init|sync|status|reset|open|dashboard|stats|reflect|config|telemetry|install-hook|uninstall-hook)\b
---

**Wrong CLI Binary Name Detected!**

The CLI binary is **`code-insights`** (with hyphen, plural), NOT `claudeinsight`, `codeinsight`, or `code-insight`.

**Correct usage:**
```bash
code-insights init
code-insights sync
code-insights open
code-insights dashboard
code-insights stats
code-insights reflect
code-insights config
code-insights telemetry
code-insights install-hook
code-insights uninstall-hook
code-insights reset
```

**Also note:**
- Package name is `@code-insights/cli`
- Config directory is `~/.code-insights/`

**Common mistakes:**
- ❌ `claudeinsight sync` → ✅ `code-insights sync`
- ❌ `codeinsight stats` → ✅ `code-insights stats`
- ❌ `code-insight reflect` → ✅ `code-insights reflect`
