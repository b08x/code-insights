import * as path from 'path';

/**
 * Extract real filesystem path and optional session fragment from a virtual path.
 * Virtual paths use '#' delimiter: "/path/to/state.vscdb#composerId"
 * Regular paths pass through unchanged.
 */
export function splitVirtualPath(filePath: string): { realPath: string; sessionFragment: string | null } {
  const hashIndex = filePath.lastIndexOf('#');
  if (hashIndex > 0) {
    return {
      realPath: filePath.slice(0, hashIndex),
      sessionFragment: filePath.slice(hashIndex + 1),
    };
  }
  return { realPath: filePath, sessionFragment: null };
}

/**
 * Resolve a human-friendly project name from a project path.
 * Falls back to the parent directory name when the basename is 'unknown' or 'tmp'.
 */
export function resolveProjectName(projectPath: string): string {
  const base = path.basename(projectPath);
  if (base && base !== 'unknown' && base !== 'tmp') {
    return base;
  }
  const parent = path.basename(path.dirname(projectPath));
  if (parent && parent !== 'unknown' && parent !== 'tmp' && parent !== '.' && parent !== '/') {
    return parent;
  }
  return base || 'unknown';
}
