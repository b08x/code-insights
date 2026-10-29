#!/usr/bin/env node

/**
 * ci-report.js - Zero-dependency CLI reporting runner for Code Insights SQLite DB.
 * 
 * Safely analyzes and queries ~/.code-insights/data.db in strict read-only mode
 * using Node.js v22+ built-in node:sqlite (DatabaseSync).
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const process = require('node:process');

// ============================================================================
// Configuration & Argument Parsing
// ============================================================================

function printUsage() {
  console.log(`
Code Insights Reporting Runner (ci-report.js)

USAGE:
  ci-report.js <command> [options]

COMMANDS:
  summary          High-level database volume, date windows, token and cost overview
  reflection       Cross-session narrative summaries, architectural decisions, and learnings
  cost             Token economics and cost breakdown by source tool, model, and project
  friction         Friction taxonomy, failure loops, course corrections, and satisfaction
  prompt-quality   Prompt quality scores, SFL metafunction breakdowns, and takeaways
  benchmarks       Cross-tool comparison across Claude Code, Antigravity, OpenCode, etc.
  timeline         Chronological ADR graph tracing, decision trade-offs, and step milestones
  query <sql>      Execute safe, read-only ad-hoc SQL query against data.db
  verify           Run automated self-test verifying database integrity and all subcommands

OPTIONS:
  --db <path>      Path to SQLite database (default: ~/.code-insights/data.db)
  --project <name> Filter results by project name (substring match)
  --days <number>  Filter results to sessions within the last N days (e.g. 7, 30)
  --limit <number> Limit the number of returned rows / records (default: 10 or 15)
  --json           Output raw JSON instead of formatted Markdown
  --output, -o <f> Write report output directly to a file (Markdown or JSON)
  --mermaid        Include or output Mermaid causal diagrams (for timeline command)
  --help, -h       Display this manual
`);
}

function parseArgs(rawArgs) {
  const options = {
    command: null,
    querySql: null,
    dbPath: process.env.CODE_INSIGHTS_DB || path.join(os.homedir(), '.code-insights', 'data.db'),
    project: null,
    days: null,
    limit: null,
    json: false,
    output: null,
    mermaid: false,
    help: false,
    silent: false,
  };

  const args = [...rawArgs];
  let cmdFound = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--mermaid') {
      options.mermaid = true;
    } else if (arg === '--db') {
      options.dbPath = args[++i];
    } else if (arg === '--project') {
      options.project = args[++i];
    } else if (arg === '--days') {
      options.days = parseInt(args[++i], 10);
    } else if (arg === '--limit') {
      options.limit = parseInt(args[++i], 10);
    } else if (arg === '--output' || arg === '-o') {
      options.output = args[++i];
    } else if (!arg.startsWith('-') && !cmdFound) {
      options.command = arg;
      cmdFound = true;
      if (arg === 'query' && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.querySql = args[++i];
      }
    } else if (options.command === 'query' && !options.querySql && !arg.startsWith('-')) {
      options.querySql = arg;
    }
  }

  return options;
}

// ============================================================================
// Database Connection & Safety
// ============================================================================

function openDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found at: ${dbPath}`);
  }

  // Open in strict read-only mode
  const db = new DatabaseSync(dbPath, { readOnly: true });

  // Enforce busy timeout and read-only query mode
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA query_only = ON;');

  return db;
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatNum(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '0';
  return Number(num).toLocaleString('en-US');
}

function formatCurrency(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '$0.00';
  return '$' + Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '0.0%';
  return Number(num).toFixed(1) + '%';
}

function formatDate(isoStr) {
  if (!isoStr) return 'N/A';
  return isoStr.replace('T', ' ').slice(0, 19);
}

function truncate(str, maxLen = 60) {
  if (!str) return '';
  const clean = String(str).replace(/[\r\n]+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + '...';
}

function renderMarkdownTable(headers, rows) {
  if (!rows || rows.length === 0) {
    return '_No records found._\n';
  }

  const colWidths = headers.map((h, i) => {
    let max = h.length;
    for (const r of rows) {
      const cell = r[i] !== undefined && r[i] !== null ? String(r[i]) : '';
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  let out = '| ' + headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ') + ' |\n';
  out += '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |\n';

  for (const r of rows) {
    out += '| ' + r.map((cell, i) => {
      const val = cell !== undefined && cell !== null ? String(cell) : '';
      return val.padEnd(colWidths[i]);
    }).join(' | ') + ' |\n';
  }

  return out + '\n';
}

function writeOutput(content, jsonContent, options) {
  const result = options.json ? JSON.stringify(jsonContent, null, 2) : content;

  if (options.output) {
    const resolvedPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, result, 'utf8');
    if (!options.silent) {
      console.log(`[ci-report] Report written to: ${resolvedPath}`);
    }
  }

  if (!options.silent) {
    console.log(result);
  }

  return { content, jsonContent };
}

// ============================================================================
// SQL Filter Helper
// ============================================================================

function buildWhereClause(options, sessionAlias = 's') {
  const conditions = [`${sessionAlias}.deleted_at IS NULL`];
  const params = [];

  if (options.project) {
    conditions.push(`${sessionAlias}.project_name LIKE ?`);
    params.push(`%${options.project}%`);
  }

  if (options.days) {
    conditions.push(`datetime(${sessionAlias}.started_at) >= datetime('now', '-' || ? || ' days')`);
    params.push(options.days);
  }

  return {
    where: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

// ============================================================================
// Command: summary
// ============================================================================

function runSummary(db, options) {
  const globalStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects) AS total_projects,
      (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL) AS total_sessions,
      (SELECT COUNT(*) FROM messages) AS total_messages,
      (SELECT COUNT(*) FROM insights) AS total_insights,
      (SELECT COUNT(*) FROM session_steps) AS total_steps,
      (SELECT MIN(started_at) FROM sessions WHERE deleted_at IS NULL AND started_at > '2020-01-01') AS earliest_session,
      (SELECT MAX(ended_at) FROM sessions WHERE deleted_at IS NULL) AS latest_session,
      (SELECT SUM(COALESCE(total_input_tokens, 0)) FROM sessions WHERE deleted_at IS NULL) AS total_input_tokens,
      (SELECT SUM(COALESCE(total_output_tokens, 0)) FROM sessions WHERE deleted_at IS NULL) AS total_output_tokens,
      (SELECT SUM(COALESCE(cache_read_tokens, 0)) FROM sessions WHERE deleted_at IS NULL) AS total_cache_read_tokens,
      (SELECT SUM(COALESCE(cache_creation_tokens, 0)) FROM sessions WHERE deleted_at IS NULL) AS total_cache_creation_tokens,
      (SELECT ROUND(SUM(COALESCE(estimated_cost_usd, 0)), 2) FROM sessions WHERE deleted_at IS NULL) AS total_cost_usd
  `).get();

  const windowStats = db.prepare(`
    SELECT
      SUM(CASE WHEN datetime(started_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS sessions_24h,
      SUM(CASE WHEN datetime(started_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS sessions_7d,
      SUM(CASE WHEN datetime(started_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS sessions_30d
    FROM sessions
    WHERE deleted_at IS NULL
  `).get();

  const toolStats = db.prepare(`
    SELECT
      source_tool,
      COUNT(*) AS session_count,
      SUM(message_count) AS total_messages,
      SUM(COALESCE(total_input_tokens, 0)) AS input_tokens,
      ROUND(SUM(COALESCE(estimated_cost_usd, 0)), 2) AS cost_usd
    FROM sessions
    WHERE deleted_at IS NULL
    GROUP BY source_tool
    ORDER BY session_count DESC
  `).all();

  const topProjects = db.prepare(`
    SELECT
      project_name,
      COUNT(*) AS session_count,
      SUM(message_count) AS total_messages,
      ROUND(SUM(COALESCE(estimated_cost_usd, 0)), 2) AS cost_usd,
      MAX(started_at) AS last_active
    FROM sessions
    WHERE deleted_at IS NULL
    GROUP BY project_name
    ORDER BY session_count DESC
    LIMIT 8
  `).all();

  // Render Markdown
  let md = `# Code Insights Database Summary Report\n\n`;
  md += `**Database Path**: \`${options.dbPath}\`  \n`;
  md += `**Date Range**: ${formatDate(globalStats.earliest_session)} to ${formatDate(globalStats.latest_session)}  \n`;
  md += `**Active Window Activity**: **${formatNum(windowStats.sessions_24h)}** in last 24h · **${formatNum(windowStats.sessions_7d)}** in last 7d · **${formatNum(windowStats.sessions_30d)}** in last 30d\n\n`;

  md += `## Global Volume & Economics\n\n`;
  const volumeHeaders = ['Metric', 'Count / Value'];
  const volumeRows = [
    ['Total Projects', formatNum(globalStats.total_projects)],
    ['Total Sessions', formatNum(globalStats.total_sessions)],
    ['Total Messages', formatNum(globalStats.total_messages)],
    ['Total Insights Extracted', formatNum(globalStats.total_insights)],
    ['Total Session Steps (FCA)', formatNum(globalStats.total_steps)],
    ['Input Tokens', formatNum(globalStats.total_input_tokens)],
    ['Output Tokens', formatNum(globalStats.total_output_tokens)],
    ['Cache Read Tokens', formatNum(globalStats.total_cache_read_tokens)],
    ['Cache Creation Tokens', formatNum(globalStats.total_cache_creation_tokens)],
    ['Total Estimated API Cost', formatCurrency(globalStats.total_cost_usd)],
  ];
  md += renderMarkdownTable(volumeHeaders, volumeRows);

  md += `## Activity by AI Coding Tool\n\n`;
  const toolHeaders = ['Source Tool', 'Sessions', 'Messages', 'Input Tokens', 'Estimated Cost'];
  const toolRows = toolStats.map(t => [
    t.source_tool,
    formatNum(t.session_count),
    formatNum(t.total_messages),
    formatNum(t.input_tokens),
    formatCurrency(t.cost_usd),
  ]);
  md += renderMarkdownTable(toolHeaders, toolRows);

  md += `## Top Projects by Volume\n\n`;
  const projHeaders = ['Project Name', 'Sessions', 'Messages', 'Estimated Cost', 'Last Active'];
  const projRows = topProjects.map(p => [
    p.project_name,
    formatNum(p.session_count),
    formatNum(p.total_messages),
    formatCurrency(p.cost_usd),
    formatDate(p.last_active),
  ]);
  md += renderMarkdownTable(projHeaders, projRows);

  const jsonPayload = {
    globalStats,
    windowStats,
    toolStats,
    topProjects,
  };

  return writeOutput(md, jsonPayload, options);
}

// ============================================================================
// Command: reflection
// ============================================================================

function runReflection(db, options) {
  const limit = options.limit || 10;
  const { where, params } = buildWhereClause(options, 's');

  const sessionQuery = `
    SELECT
      s.id,
      s.project_name,
      s.source_tool,
      COALESCE(s.custom_title, s.generated_title, s.summary, 'Untitled') AS title,
      s.summary,
      s.session_character,
      s.started_at,
      s.message_count,
      ROUND(COALESCE(s.estimated_cost_usd, 0), 2) AS cost_usd,
      sf.outcome_satisfaction,
      sf.workflow_pattern
    FROM sessions s
    LEFT JOIN session_facets sf ON sf.session_id = s.id
    ${where}
    ORDER BY s.started_at DESC
    LIMIT ?
  `;

  const sessions = db.prepare(sessionQuery).all(...params, limit);

  // Extract recent decisions
  const decisionQuery = `
    SELECT
      i.id,
      i.session_id,
      i.project_name,
      i.title,
      i.summary,
      i.timestamp,
      i.metadata
    FROM insights i
    JOIN sessions s ON s.id = i.session_id
    ${where} AND i.type = 'decision' AND i.timestamp > '2020-01-01'
    ORDER BY i.timestamp DESC
    LIMIT ?
  `;
  const decisions = db.prepare(decisionQuery).all(...params, limit);

  // Extract recent learnings
  const learningQuery = `
    SELECT
      i.id,
      i.session_id,
      i.project_name,
      i.title,
      i.summary,
      i.timestamp,
      i.metadata
    FROM insights i
    JOIN sessions s ON s.id = i.session_id
    ${where} AND i.type = 'learning' AND i.timestamp > '2020-01-01'
    ORDER BY i.timestamp DESC
    LIMIT ?
  `;
  const learnings = db.prepare(learningQuery).all(...params, limit);

  let md = `# Session Reflection & Developer Digest\n\n`;
  if (options.project) md += `**Project Filter**: \`${options.project}\`  \n`;
  if (options.days) md += `**Time Window**: Last ${options.days} days  \n`;
  md += `**Sessions Analyzed**: ${sessions.length}\n\n`;

  md += `## Recent Coding Sessions\n\n`;
  const sessionHeaders = ['Date', 'Project', 'Tool', 'Title', 'Messages', 'Character', 'Satisfaction'];
  const sessionRows = sessions.map(s => [
    formatDate(s.started_at).slice(0, 16),
    truncate(s.project_name, 20),
    s.source_tool,
    truncate(s.title, 35),
    formatNum(s.message_count),
    s.session_character || 'N/A',
    s.outcome_satisfaction || 'unknown',
  ]);
  md += renderMarkdownTable(sessionHeaders, sessionRows);

  md += `## Key Architectural Decisions\n\n`;
  if (decisions.length === 0) {
    md += `_No decision insights found for the selected scope._\n\n`;
  } else {
    for (const d of decisions) {
      let meta = {};
      try { meta = JSON.parse(d.metadata || '{}'); } catch (_) {}
      md += `### ${d.title}\n`;
      md += `- **Project**: \`${d.project_name}\` · **Date**: ${formatDate(d.timestamp)} · **Decided By**: \`${meta.decided_by || 'unknown'}\`\n`;
      if (meta.situation) md += `- **Situation**: ${meta.situation}\n`;
      if (meta.choice) md += `- **Choice**: ${meta.choice}\n`;
      if (meta.trade_offs) md += `- **Trade-offs**: ${meta.trade_offs}\n`;
      if (meta.reasoning) md += `- **Reasoning**: ${meta.reasoning}\n`;
      md += `\n`;
    }
  }

  md += `## Key Technical Learnings & Takeaways\n\n`;
  if (learnings.length === 0) {
    md += `_No learning insights found for the selected scope._\n\n`;
  } else {
    for (const l of learnings) {
      let meta = {};
      try { meta = JSON.parse(l.metadata || '{}'); } catch (_) {}
      md += `### ${l.title}\n`;
      md += `- **Project**: \`${l.project_name}\` · **Date**: ${formatDate(l.timestamp)}\n`;
      if (meta.symptom) md += `- **Symptom**: ${meta.symptom}\n`;
      if (meta.root_cause) md += `- **Root Cause**: ${meta.root_cause}\n`;
      if (meta.takeaway) md += `- **Takeaway**: ${meta.takeaway}\n`;
      md += `\n`;
    }
  }

  const jsonPayload = {
    sessions,
    decisions: decisions.map(d => ({ ...d, metadata: JSON.parse(d.metadata || '{}') })),
    learnings: learnings.map(l => ({ ...l, metadata: JSON.parse(l.metadata || '{}') })),
  };

  return writeOutput(md, jsonPayload, options);
}

// ============================================================================
// Command: cost
// ============================================================================

function runCost(db, options) {
  const { where, params } = buildWhereClause(options, 's');

  const toolStats = db.prepare(`
    SELECT
      s.source_tool,
      COUNT(*) AS session_count,
      SUM(COALESCE(s.total_input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(s.total_output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(s.cache_read_tokens, 0)) AS cache_read_tokens,
      SUM(COALESCE(s.cache_creation_tokens, 0)) AS cache_creation_tokens,
      ROUND(
        100.0 * SUM(COALESCE(s.cache_read_tokens, 0)) / 
        NULLIF(SUM(COALESCE(s.cache_read_tokens, 0)) + SUM(COALESCE(s.total_input_tokens, 0)), 0), 
        1
      ) AS cache_hit_pct,
      ROUND(SUM(COALESCE(s.estimated_cost_usd, 0)), 2) AS total_cost_usd,
      ROUND(AVG(COALESCE(s.estimated_cost_usd, 0)), 3) AS avg_cost_per_session
    FROM sessions s
    ${where}
    GROUP BY s.source_tool
    ORDER BY total_cost_usd DESC
  `).all(...params);

  const modelStats = db.prepare(`
    SELECT
      COALESCE(s.primary_model, 'unknown') AS model,
      COUNT(*) AS session_count,
      SUM(COALESCE(s.total_input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(s.total_output_tokens, 0)) AS output_tokens,
      ROUND(SUM(COALESCE(s.estimated_cost_usd, 0)), 2) AS total_cost_usd
    FROM sessions s
    ${where}
    GROUP BY model
    ORDER BY total_cost_usd DESC
    LIMIT 10
  `).all(...params);

  const projectStats = db.prepare(`
    SELECT
      s.project_name,
      COUNT(*) AS session_count,
      SUM(COALESCE(s.total_input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(s.total_output_tokens, 0)) AS output_tokens,
      ROUND(SUM(COALESCE(s.estimated_cost_usd, 0)), 2) AS total_cost_usd
    FROM sessions s
    ${where}
    GROUP BY s.project_name
    ORDER BY total_cost_usd DESC
    LIMIT 10
  `).all(...params);

  const analysisStats = db.prepare(`
    SELECT
      provider,
      model,
      COUNT(*) AS passes,
      SUM(input_tokens) AS in_tok,
      SUM(output_tokens) AS out_tok,
      ROUND(SUM(estimated_cost_usd), 2) AS cost_usd
    FROM analysis_usage
    GROUP BY provider, model
    ORDER BY cost_usd DESC, passes DESC
    LIMIT 8
  `).all();

  let md = `# Token Economics & Cost Report\n\n`;
  if (options.project) md += `**Project**: \`${options.project}\`  \n`;
  if (options.days) md += `**Time Window**: Last ${options.days} days  \n`;
  md += `\n`;

  md += `## Economics by AI Coding Tool\n\n`;
  const toolHeaders = ['Source Tool', 'Sessions', 'Input Tokens', 'Output Tokens', 'Cache Read', 'Cache %', 'Total Cost', 'Avg/Session'];
  const toolRows = toolStats.map(t => [
    t.source_tool,
    formatNum(t.session_count),
    formatNum(t.input_tokens),
    formatNum(t.output_tokens),
    formatNum(t.cache_read_tokens),
    formatPercent(t.cache_hit_pct),
    formatCurrency(t.total_cost_usd),
    formatCurrency(t.avg_cost_per_session),
  ]);
  md += renderMarkdownTable(toolHeaders, toolRows);

  md += `## Top Models by Cost & Volume\n\n`;
  const modelHeaders = ['Primary Model', 'Sessions', 'Input Tokens', 'Output Tokens', 'Estimated Cost'];
  const modelRows = modelStats.map(m => [
    m.model,
    formatNum(m.session_count),
    formatNum(m.input_tokens),
    formatNum(m.output_tokens),
    formatCurrency(m.total_cost_usd),
  ]);
  md += renderMarkdownTable(modelHeaders, modelRows);

  md += `## Top Projects by Spend\n\n`;
  const projHeaders = ['Project Name', 'Sessions', 'Input Tokens', 'Output Tokens', 'Total Cost'];
  const projRows = projectStats.map(p => [
    p.project_name,
    formatNum(p.session_count),
    formatNum(p.input_tokens),
    formatNum(p.output_tokens),
    formatCurrency(p.total_cost_usd),
  ]);
  md += renderMarkdownTable(projHeaders, projRows);

  md += `## Background LLM Analysis Pipeline Usage\n\n`;
  const anHeaders = ['Provider', 'Model', 'Passes', 'Input Tokens', 'Output Tokens', 'Cost USD'];
  const anRows = analysisStats.map(a => [
    a.provider,
    a.model,
    formatNum(a.passes),
    formatNum(a.in_tok),
    formatNum(a.out_tok),
    formatCurrency(a.cost_usd),
  ]);
  md += renderMarkdownTable(anHeaders, anRows);

  const jsonPayload = {
    toolStats,
    modelStats,
    projectStats,
    analysisStats,
  };

  return writeOutput(md, jsonPayload, options);
}

// ============================================================================
// Command: friction
// ============================================================================

function runFriction(db, options) {
  const limit = options.limit || 15;
  const { where, params } = buildWhereClause(options, 's');

  const stats = db.prepare(`
    SELECT
      COUNT(sf.session_id) AS total_sessions,
      SUM(sf.had_course_correction) AS course_corrections,
      ROUND(100.0 * SUM(sf.had_course_correction) / NULLIF(COUNT(sf.session_id), 0), 1) AS course_correction_pct,
      SUM(CASE WHEN sf.outcome_satisfaction = 'high' THEN 1 ELSE 0 END) AS sat_high,
      SUM(CASE WHEN sf.outcome_satisfaction = 'medium' THEN 1 ELSE 0 END) AS sat_med,
      SUM(CASE WHEN sf.outcome_satisfaction = 'low' THEN 1 ELSE 0 END) AS sat_low,
      SUM(CASE WHEN sf.outcome_satisfaction = 'abandoned' THEN 1 ELSE 0 END) AS sat_abandoned
    FROM session_facets sf
    JOIN sessions s ON s.id = sf.session_id
    ${where}
  `).get(...params);

  // Group friction points using JOIN json_each
  const frictionPoints = db.prepare(`
    SELECT
      json_extract(f.value, '$.category') AS category,
      json_extract(f.value, '$.attribution') AS attribution,
      COUNT(*) AS occurrences,
      SUM(CASE WHEN json_extract(f.value, '$.severity') = 'high' THEN 1 ELSE 0 END) AS high_sev,
      SUM(CASE WHEN json_extract(f.value, '$.severity') = 'medium' THEN 1 ELSE 0 END) AS med_sev,
      SUM(CASE WHEN json_extract(f.value, '$.severity') = 'low' THEN 1 ELSE 0 END) AS low_sev
    FROM session_facets sf
    JOIN sessions s ON s.id = sf.session_id
    JOIN json_each(sf.friction_points) f
    ${where} AND sf.friction_points IS NOT NULL AND sf.friction_points != '[]'
    GROUP BY category, attribution
    ORDER BY occurrences DESC
    LIMIT ?
  `).all(...params, limit);

  // Extract concrete examples of friction
  const sampleFriction = db.prepare(`
    SELECT
      s.id AS session_id,
      s.project_name,
      json_extract(f.value, '$.category') AS category,
      json_extract(f.value, '$.attribution') AS attribution,
      json_extract(f.value, '$.severity') AS severity,
      json_extract(f.value, '$.description') AS description,
      json_extract(f.value, '$.resolution') AS resolution
    FROM session_facets sf
    JOIN sessions s ON s.id = sf.session_id
    JOIN json_each(sf.friction_points) f
    ${where} AND sf.friction_points IS NOT NULL AND sf.friction_points != '[]'
      AND json_extract(f.value, '$.severity') IN ('high', 'medium')
    ORDER BY s.started_at DESC
    LIMIT 8
  `).all(...params);

  let md = `# Friction & Failure Loops Analysis\n\n`;
  if (options.project) md += `**Project Filter**: \`${options.project}\`  \n`;
  if (options.days) md += `**Time Window**: Last ${options.days} days  \n`;
  md += `**Course Correction Rate**: **${formatPercent(stats.course_correction_pct)}** (${formatNum(stats.course_corrections)} of ${formatNum(stats.total_sessions)} analyzed sessions)  \n\n`;

  md += `## Outcome Satisfaction Breakdown\n\n`;
  const satHeaders = ['Satisfaction Rating', 'Sessions', 'Share %'];
  const total = stats.total_sessions || 1;
  const satRows = [
    ['High Satisfaction', formatNum(stats.sat_high), formatPercent(100.0 * stats.sat_high / total)],
    ['Medium Satisfaction', formatNum(stats.sat_med), formatPercent(100.0 * stats.sat_med / total)],
    ['Low Satisfaction', formatNum(stats.sat_low), formatPercent(100.0 * stats.sat_low / total)],
    ['Abandoned / Blocked', formatNum(stats.sat_abandoned), formatPercent(100.0 * stats.sat_abandoned / total)],
  ];
  md += renderMarkdownTable(satHeaders, satRows);

  md += `## Friction Taxonomy & Attribution Breakdown\n\n`;
  const fHeaders = ['Category', 'Attribution', 'Occurrences', 'High Sev', 'Med Sev', 'Low Sev'];
  const fRows = frictionPoints.map(f => [
    f.category || 'unknown',
    f.attribution || 'unspecified',
    formatNum(f.occurrences),
    formatNum(f.high_sev),
    formatNum(f.med_sev),
    formatNum(f.low_sev),
  ]);
  md += renderMarkdownTable(fHeaders, fRows);

  md += `## Sample Concrete Friction Incidents\n\n`;
  for (const item of sampleFriction) {
    md += `- **[${item.category}]** (${item.attribution}, ${item.severity}) in \`${item.project_name}\`:  \n`;
    md += `  ${item.description}  \n`;
    if (item.resolution) md += `  _Resolution: ${item.resolution}_  \n`;
  }
  md += `\n`;

  const jsonPayload = {
    stats,
    frictionPoints,
    sampleFriction,
  };

  return writeOutput(md, jsonPayload, options);
}

// ============================================================================
// Command: prompt-quality
// ============================================================================

function runPromptQuality(db, options) {
  const limit = options.limit || 10;
  const { where, params } = buildWhereClause(options, 's');

  const averages = db.prepare(`
    SELECT
      COUNT(*) AS total_scored,
      ROUND(AVG(json_extract(i.metadata, '$.efficiency_score')), 1) AS avg_efficiency,
      ROUND(AVG(json_extract(i.metadata, '$.dimension_scores.context_provision')), 1) AS avg_context,
      ROUND(AVG(json_extract(i.metadata, '$.dimension_scores.request_specificity')), 1) AS avg_specificity,
      ROUND(AVG(json_extract(i.metadata, '$.dimension_scores.scope_management')), 1) AS avg_scope,
      ROUND(AVG(json_extract(i.metadata, '$.dimension_scores.information_timing')), 1) AS avg_timing,
      ROUND(AVG(json_extract(i.metadata, '$.dimension_scores.correction_quality')), 1) AS avg_correction
    FROM insights i
    JOIN sessions s ON s.id = i.session_id
    ${where} AND i.type = 'prompt_quality'
      AND json_extract(i.metadata, '$.dimension_scores') IS NOT NULL
  `).get(...params);

  // Top Deficits using JOIN json_each
  const deficits = db.prepare(`
    SELECT
      json_extract(f.value, '$.category') AS category,
      COUNT(*) AS count,
      SUM(CASE WHEN json_extract(f.value, '$.impact') = 'high' THEN 1 ELSE 0 END) AS high_impact,
      MIN(json_extract(f.value, '$.description')) AS sample_desc,
      MIN(json_extract(f.value, '$.suggested_improvement')) AS sample_improvement
    FROM insights i
    JOIN sessions s ON s.id = i.session_id
    JOIN json_each(json_extract(i.metadata, '$.findings')) f
    ${where} AND i.type = 'prompt_quality'
      AND json_extract(f.value, '$.type') = 'deficit'
    GROUP BY category
    ORDER BY count DESC
    LIMIT ?
  `).all(...params, limit);

  // Top Strengths using JOIN json_each
  const strengths = db.prepare(`
    SELECT
      json_extract(f.value, '$.category') AS category,
      COUNT(*) AS count,
      MIN(json_extract(f.value, '$.description')) AS sample_desc
    FROM insights i
    JOIN sessions s ON s.id = i.session_id
    JOIN json_each(json_extract(i.metadata, '$.findings')) f
    ${where} AND i.type = 'prompt_quality'
      AND json_extract(f.value, '$.type') = 'strength'
    GROUP BY category
    ORDER BY count DESC
    LIMIT 6
  `).all(...params);

  let md = `# Prompt Quality & SFL Analysis Report\n\n`;
  if (options.project) md += `**Project Filter**: \`${options.project}\`  \n`;
  if (options.days) md += `**Time Window**: Last ${options.days} days  \n`;
  md += `**Total Sessions Scored**: ${formatNum(averages.total_scored)}  \n`;
  md += `**Average Efficiency Score**: **${averages.avg_efficiency || 'N/A'} / 100**\n\n`;

  md += `## SFL Metafunction Dimension Scores\n\n`;
  const sflHeaders = ['Metafunction', 'Dimension', 'Average Score', 'Functional Interpretation'];
  const sflRows = [
    ['Ideational', 'Context Provision', `${averages.avg_context || 0} / 100`, 'Provides background docs, paths, error logs, and repo context'],
    ['Ideational', 'Information Timing', `${averages.avg_timing || 0} / 100`, 'Supplies required parameters upfront rather than reactively'],
    ['Interpersonal', 'Correction Quality', `${averages.avg_correction || 0} / 100`, 'Clear, decisive feedback when guiding agents during course corrections'],
    ['Textual', 'Request Specificity', `${averages.avg_specificity || 0} / 100`, 'Unambiguous tasks, concrete acceptance criteria, explicit boundaries'],
    ['Textual', 'Scope Management', `${averages.avg_scope || 0} / 100`, 'Prevents task creep and maintains session focus on core objectives'],
  ];
  md += renderMarkdownTable(sflHeaders, sflRows);

  md += `## Top Prompt Deficit Categories\n\n`;
  const dHeaders = ['Deficit Category', 'Occurrences', 'High Impact', 'Sample Improvement Recommendation'];
  const dRows = deficits.map(d => [
    d.category || 'unknown',
    formatNum(d.count),
    formatNum(d.high_impact),
    truncate(d.sample_improvement || d.sample_desc, 65),
  ]);
  md += renderMarkdownTable(dHeaders, dRows);

  md += `## Top Observed Prompt Strengths\n\n`;
  const strHeaders = ['Strength Category', 'Frequency', 'Observed Pattern'];
  const strRows = strengths.map(s => [
    s.category || 'unknown',
    formatNum(s.count),
    truncate(s.sample_desc, 70),
  ]);
  md += renderMarkdownTable(strHeaders, strRows);

  const jsonPayload = {
    averages,
    deficits,
    strengths,
  };

  return writeOutput(md, jsonPayload, options);
}

// ============================================================================
// Command: benchmarks
// ============================================================================

function runBenchmarks(db, options) {
  const { where, params } = buildWhereClause(options, 's');

  const rows = db.prepare(`
    SELECT
      s.source_tool,
      COUNT(s.id) AS sessions,
      ROUND(AVG(s.message_count), 1) AS avg_messages,
      ROUND(AVG(s.tool_call_count), 1) AS avg_tools,
      ROUND(AVG(COALESCE(s.total_input_tokens, 0)), 0) AS avg_input_tokens,
      ROUND(SUM(COALESCE(s.estimated_cost_usd, 0)), 2) AS total_cost_usd,
      ROUND(AVG(COALESCE(s.estimated_cost_usd, 0)), 3) AS avg_cost_usd,
      ROUND(100.0 * SUM(CASE WHEN sf.outcome_satisfaction = 'high' THEN 1 ELSE 0 END) / NULLIF(COUNT(sf.session_id), 0), 1) AS high_sat_pct,
      ROUND(100.0 * SUM(CASE WHEN sf.had_course_correction = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(sf.session_id), 0), 1) AS course_correction_pct
    FROM sessions s
    LEFT JOIN session_facets sf ON sf.session_id = s.id
    ${where}
    GROUP BY s.source_tool
    ORDER BY sessions DESC
  `).all(...params);

  let md = `# Cross-Tool Coding Agent Benchmarks\n\n`;
  if (options.project) md += `**Project Filter**: \`${options.project}\`  \n`;
  if (options.days) md += `**Time Window**: Last ${options.days} days  \n`;
  md += `Comparative performance, message intensity, cost efficiency, and satisfaction ratings across all AI coding CLIs and agents.\n\n`;

  const headers = ['Tool Name', 'Sessions', 'Avg Msgs', 'Avg Tools', 'Avg In Tokens', 'Total Cost', 'Avg Cost', 'High Sat %', 'Course Corr %'];
  const tableRows = rows.map(r => [
    r.source_tool,
    formatNum(r.sessions),
    formatNum(r.avg_messages),
    formatNum(r.avg_tools),
    formatNum(r.avg_input_tokens),
    formatCurrency(r.total_cost_usd),
    formatCurrency(r.avg_cost_usd),
    formatPercent(r.high_sat_pct),
    formatPercent(r.course_correction_pct),
  ]);
  md += renderMarkdownTable(headers, tableRows);

  md += `### Key Observations\n`;
  md += `- **Highest Volume**: \`${rows[0]?.source_tool || 'N/A'}\` with **${formatNum(rows[0]?.sessions)}** sessions.\n`;
  const sortedBySat = [...rows].filter(r => r.high_sat_pct !== null).sort((a, b) => b.high_sat_pct - a.high_sat_pct);
  if (sortedBySat.length > 0) {
    md += `- **Top Satisfaction**: \`${sortedBySat[0].source_tool}\` (**${formatPercent(sortedBySat[0].high_sat_pct)}** high satisfaction).\n`;
  }
  const sortedByCorr = [...rows].filter(r => r.course_correction_pct !== null).sort((a, b) => a.course_correction_pct - b.course_correction_pct);
  if (sortedByCorr.length > 0) {
    md += `- **Lowest Friction / Course Corrections**: \`${sortedByCorr[0].source_tool}\` (**${formatPercent(sortedByCorr[0].course_correction_pct)}** course correction rate).\n`;
  }
  md += `\n`;

  return writeOutput(md, rows, options);
}

// ============================================================================
// Command: timeline (Chronological ADR & Graph Tracing)
// ============================================================================

function runTimeline(db, options) {
  const limit = options.limit || 15;
  const { where, params } = buildWhereClause(options, 's');

  const decisionsQuery = `
    SELECT
      i.id AS insight_id,
      i.session_id,
      i.project_name,
      i.title,
      i.timestamp,
      i.metadata
    FROM insights i
    JOIN sessions s ON s.id = i.session_id
    ${where} AND i.type = 'decision' AND i.timestamp > '2024-01-01'
    ORDER BY i.timestamp DESC
    LIMIT ?
  `;

  const decisionsDesc = db.prepare(decisionsQuery).all(...params, limit);
  // Reverse to display in forward chronological order
  const decisions = decisionsDesc.reverse();

  // For each decision, fetch associated session steps for causal linking
  const enrichedDecisions = decisions.map((d, index) => {
    let meta = {};
    try { meta = JSON.parse(d.metadata || '{}'); } catch (_) {}

    const steps = db.prepare(`
      SELECT idx, turn_ref, driver, target, state, label
      FROM session_steps
      WHERE session_id = ?
      ORDER BY idx ASC
      LIMIT 5
    `).all(d.session_id);

    return {
      stepIndex: index + 1,
      ...d,
      metadata: meta,
      steps,
    };
  });

  let md = `# Architectural Decision Records (ADR) & Development Timeline\n\n`;
  if (options.project) md += `**Project Filter**: \`${options.project}\`  \n`;
  if (options.days) md += `**Time Window**: Last ${options.days} days  \n`;
  md += `Chronological reconstruction of key architectural decision milestones, design trade-offs, and causal trajectory graph.\n\n`;

  // Timeline list
  for (const item of enrichedDecisions) {
    const meta = item.metadata;
    const decidedBy = meta.decided_by || 'collaborative';
    const dateStr = formatDate(item.timestamp).slice(0, 16);

    md += `### ${item.stepIndex}. [${dateStr}] ${item.title}\n`;
    md += `- **Project**: \`${item.project_name}\` · **Session**: \`${item.session_id.slice(0, 8)}\` · **Driver**: \`${decidedBy}\`\n`;
    if (meta.situation) md += `- **Situation**: ${meta.situation}\n`;
    if (meta.choice) md += `- **Choice**: ${meta.choice}\n`;
    if (meta.reasoning) md += `- **Reasoning**: ${meta.reasoning}\n`;
    if (meta.trade_offs) md += `- **Trade-offs**: ${meta.trade_offs}\n`;
    if (meta.alternatives && Array.isArray(meta.alternatives) && meta.alternatives.length > 0) {
      const altText = meta.alternatives.map(a => typeof a === 'string' ? a : `${a.option} (rejected: ${a.rejected_because})`).join('; ');
      md += `- **Alternatives Considered**: ${altText}\n`;
    }
    if (meta.revisit_when) md += `- **Revisit When**: ${meta.revisit_when}\n`;

    if (item.steps && item.steps.length > 0) {
      md += `- **Execution Milestones (FCA Steps)**:\n`;
      for (const st of item.steps) {
        md += `  - \`${st.turn_ref}\` [${st.driver} → ${st.target}] (${st.state}): ${st.label}\n`;
      }
    }
    md += `\n`;
  }

  // ASCII Causal Trace
  md += `## Chronological Trajectory Graph\n\n`;
  md += `\`\`\`text\n`;
  enrichedDecisions.forEach((item, i) => {
    const title = truncate(item.title, 45);
    const driver = item.metadata.decided_by || 'collab';
    const date = formatDate(item.timestamp).slice(0, 10);
    md += `(${i + 1}) [${date}] ${title} [${driver}]\n`;
    if (item.steps && item.steps.length > 0) {
      md += `     |--> Milestone: ${truncate(item.steps[0].label, 40)} (${item.steps[0].state})\n`;
    }
    if (i < enrichedDecisions.length - 1) {
      md += `     |\n     V\n`;
    }
  });
  md += `\`\`\`\n\n`;

  // Mermaid Diagram
  md += `## Mermaid Causal Flowchart\n\n`;
  md += `\`\`\`mermaid\nflowchart TD\n`;
  enrichedDecisions.forEach((item, i) => {
    const safeTitle = truncate(item.title, 35).replace(/["()]/g, "'");
    const driver = item.metadata.decided_by || 'collaborative';
    const nodeId = `D${item.stepIndex}`;
    md += `  ${nodeId}["${item.stepIndex}. ${safeTitle}<br/>(Driver: ${driver})"]\n`;
    if (i > 0) {
      const prevId = `D${enrichedDecisions[i - 1].stepIndex}`;
      md += `  ${prevId} --> ${nodeId}\n`;
    }
  });
  md += `\`\`\`\n\n`;

  return writeOutput(md, enrichedDecisions, options);
}

// ============================================================================
// Command: query (Safe Read-Only SQL)
// ============================================================================

function runQuery(db, options) {
  const sql = options.querySql;
  if (!sql) {
    throw new Error('Please provide a SELECT query. Example: ci-report.js query "SELECT * FROM projects LIMIT 5"');
  }

  const trimmed = sql.trim();
  const normalized = trimmed.toUpperCase();

  // Strict read-only safety guard
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    throw new Error('Unsafe query rejected: Ad-hoc queries MUST begin with SELECT or WITH.');
  }

  const dangerousTokens = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'REPLACE', 'ATTACH', 'DETACH', 'VACUUM', 'PRAGMA'];
  for (const token of dangerousTokens) {
    const regex = new RegExp(`\\b${token}\\b`, 'i');
    if (regex.test(trimmed)) {
      throw new Error(`Unsafe query rejected: Mutative or administrative keyword '${token}' is strictly forbidden.`);
    }
  }

  // Check for multi-statement semicolons
  const statements = trimmed.split(';').map(s => s.trim()).filter(Boolean);
  if (statements.length > 1) {
    throw new Error('Unsafe query rejected: Multiple statement execution is forbidden.');
  }

  const rows = db.prepare(trimmed).all();

  if (options.json) {
    return writeOutput(null, rows, options);
  }

  if (rows.length === 0) {
    if (!options.silent) console.log('_0 rows returned._');
    return { content: '_0 rows returned._', jsonContent: [] };
  }

  const headers = Object.keys(rows[0]);
  const tableRows = rows.map(r => headers.map(h => {
    const val = r[h];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }));

  const md = renderMarkdownTable(headers, tableRows);
  return writeOutput(md, rows, options);
}

// ============================================================================
// Command: verify
// ============================================================================

function runVerify(db, options) {
  console.log(`[ci-report verify] Initiating comprehensive verification suite...`);
  console.log(`[ci-report verify] Database Target: ${options.dbPath}`);

  const checks = [];

  // Check 1: File stats & initial mtime
  const initialStat = fs.statSync(options.dbPath);
  checks.push({ name: 'Database file accessibility', pass: true, detail: `Size: ${(initialStat.size / (1024 * 1024)).toFixed(1)} MB` });

  // Check 2: Schema version & core tables
  try {
    const verRow = db.prepare('SELECT MAX(version) AS ver FROM schema_version').get();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    const requiredTables = ['projects', 'sessions', 'messages', 'insights', 'session_facets', 'session_steps', 'analysis_usage'];
    const missing = requiredTables.filter(t => !tables.includes(t));

    if (missing.length > 0) {
      checks.push({ name: 'Core schema tables check', pass: false, detail: `Missing: ${missing.join(', ')}` });
    } else {
      checks.push({ name: 'Core schema tables check', pass: true, detail: `Version ${verRow.ver}, all 7 required tables present` });
    }
  } catch (err) {
    checks.push({ name: 'Core schema tables check', pass: false, detail: err.message });
  }

  // Check 3: Read-only engine enforcement
  try {
    let mutThrown = false;
    try {
      db.exec("CREATE TABLE __verify_temp_test (id INT)");
    } catch (e) {
      mutThrown = true;
    }
    checks.push({ name: 'Read-only engine enforcement', pass: mutThrown, detail: mutThrown ? 'Mutative CREATE TABLE was successfully blocked by SQLite engine' : 'Failed to block mutation!' });
  } catch (err) {
    checks.push({ name: 'Read-only engine enforcement', pass: false, detail: err.message });
  }

  // Check 4: Test query command safety blocker
  try {
    let blocked = false;
    try {
      runQuery(db, { querySql: "INSERT INTO sessions (id) VALUES ('test')", silent: true });
    } catch (e) {
      blocked = true;
    }
    checks.push({ name: 'Ad-hoc query safety validator', pass: blocked, detail: blocked ? 'INSERT keyword correctly rejected by query parser' : 'Failed to reject INSERT!' });
  } catch (err) {
    checks.push({ name: 'Ad-hoc query safety validator', pass: false, detail: err.message });
  }

  // Check 5: Execute subcommands without error (silent test run)
  const silentOpts = { ...options, silent: true, json: false, output: null };
  const subcommands = ['summary', 'reflection', 'cost', 'friction', 'prompt-quality', 'benchmarks', 'timeline'];

  for (const sub of subcommands) {
    try {
      if (sub === 'summary') runSummary(db, silentOpts);
      else if (sub === 'reflection') runReflection(db, silentOpts);
      else if (sub === 'cost') runCost(db, silentOpts);
      else if (sub === 'friction') runFriction(db, silentOpts);
      else if (sub === 'prompt-quality') runPromptQuality(db, silentOpts);
      else if (sub === 'benchmarks') runBenchmarks(db, silentOpts);
      else if (sub === 'timeline') runTimeline(db, silentOpts);
      checks.push({ name: `Subcommand execution: ${sub}`, pass: true, detail: 'Executed cleanly in read-only mode' });
    } catch (err) {
      checks.push({ name: `Subcommand execution: ${sub}`, pass: false, detail: err.message });
    }
  }

  // Check 6: Read-only integrity (mtime check)
  const postStat = fs.statSync(options.dbPath);
  const mtimeUnchanged = initialStat.mtimeMs === postStat.mtimeMs;
  checks.push({ name: 'Database file non-destructive integrity', pass: mtimeUnchanged, detail: mtimeUnchanged ? 'File mtime preserved exactly; 0 byte modifications' : 'File mtime changed!' });

  // Output test report
  console.log('\n=============================================================');
  console.log('              VERIFICATION RESULTS REPORT                    ');
  console.log('=============================================================');
  let allPass = true;
  for (const c of checks) {
    const symbol = c.pass ? '✓ PASS' : '✗ FAIL';
    console.log(`${symbol} | ${c.name.padEnd(40)} | ${c.detail}`);
    if (!c.pass) allPass = false;
  }
  console.log('=============================================================\n');

  if (!allPass) {
    throw new Error('One or more verification checks failed.');
  }

  console.log('All verification checks passed with zero errors.');
}

// ============================================================================
// Main Dispatcher
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help || !options.command) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  let db;
  try {
    db = openDatabase(options.dbPath);
  } catch (err) {
    console.error(`[ci-report error] Failed to open database: ${err.message}`);
    process.exit(1);
  }

  try {
    switch (options.command) {
      case 'summary':
        runSummary(db, options);
        break;
      case 'reflection':
        runReflection(db, options);
        break;
      case 'cost':
        runCost(db, options);
        break;
      case 'friction':
        runFriction(db, options);
        break;
      case 'prompt-quality':
        runPromptQuality(db, options);
        break;
      case 'benchmarks':
        runBenchmarks(db, options);
        break;
      case 'timeline':
        runTimeline(db, options);
        break;
      case 'query':
        runQuery(db, options);
        break;
      case 'verify':
        runVerify(db, options);
        break;
      default:
        console.error(`[ci-report error] Unknown command: '${options.command}'`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`[ci-report error] ${err.message}`);
    process.exit(1);
  } finally {
    if (db) {
      db.close();
    }
  }
}

main();
