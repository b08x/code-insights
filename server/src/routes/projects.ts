import { Hono } from 'hono';
import { getDb } from '@code-insights/cli/db/client';
import { parseIntParam } from '../utils.js';

const app = new Hono();

app.get('/', (c) => {
  const db = getDb();
  const { limit, offset } = c.req.query();
  const projects = db.prepare(`
    SELECT id, name, path, git_remote_url, session_count, last_activity,
           total_input_tokens, total_output_tokens, cache_creation_tokens,
           cache_read_tokens, estimated_cost_usd, created_at, updated_at
    FROM projects
    ORDER BY last_activity DESC
    LIMIT ? OFFSET ?
  `).all(parseIntParam(limit, 100), parseIntParam(offset, 0));
  return c.json({ projects });
});

app.get('/:id', (c) => {
  const db = getDb();
  const project = db.prepare(`
    SELECT id, name, path, git_remote_url, session_count, last_activity,
           total_input_tokens, total_output_tokens, cache_creation_tokens,
           cache_read_tokens, estimated_cost_usd, created_at, updated_at
    FROM projects
    WHERE id = ?
  `).get(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);
  return c.json({ project });
});

app.patch('/:id', async (c) => {
  const db = getDb();
  const projectId = c.req.param('id');
  const body = await c.req.json<{ name?: string, gitRemoteUrl?: string }>();
  const { name, gitRemoteUrl } = body;
  
  if (name === undefined && gitRemoteUrl === undefined) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const updates: string[] = [];
  const params: any[] = [];
  const sessionUpdates: string[] = [];
  const sessionParams: any[] = [];
  const insightUpdates: string[] = [];
  const insightParams: any[] = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(name);
    
    sessionUpdates.push('project_name = ?');
    sessionParams.push(name);

    insightUpdates.push('project_name = ?');
    insightParams.push(name);
  }
  if (gitRemoteUrl !== undefined) {
    updates.push('git_remote_url = ?');
    params.push(gitRemoteUrl || null);

    sessionUpdates.push('git_remote_url = ?');
    sessionParams.push(gitRemoteUrl || null);
  }

  params.push(projectId);
  sessionParams.push(projectId);
  insightParams.push(projectId);

  const tx = db.transaction(() => {
    const result = db.prepare(`
      UPDATE projects 
      SET ${updates.join(', ')}, updated_at = datetime('now')
      WHERE id = ?
    `).run(...params);

    if (result.changes === 0) return false;

    if (sessionUpdates.length > 0) {
      db.prepare(`
        UPDATE sessions
        SET ${sessionUpdates.join(', ')}
        WHERE project_id = ?
      `).run(...sessionParams);
    }

    if (insightUpdates.length > 0) {
      db.prepare(`
        UPDATE insights
        SET ${insightUpdates.join(', ')}
        WHERE project_id = ?
      `).run(...insightParams);
    }

    return true;
  });

  const updated = tx();
  
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default app;
