#!/usr/bin/env node
/**
 * Delete release tags older than RETENTION_DAYS (default 30).
 *
 * Protections:
 *   - tags starting with "keep" are never touched
 *   - KEEP_LATEST=1 keeps the newest N releases (default 0 = age only)
 *   - DRY_RUN=1 only prints what would be deleted
 */
const env = process.env;
const TOKEN = env.GH_TOKEN || env.GITHUB_TOKEN || '';
const REPO = env.GH_REPO || env.GITHUB_REPOSITORY || '';
const DAYS = Number(env.RETENTION_DAYS || 30);
const KEEP_LATEST = Number(env.KEEP_LATEST || 0);
const DRY = /^(1|true|yes)$/i.test(env.DRY_RUN || '');
const KEEP_PREFIX = (env.KEEP_PREFIX || 'keep').toLowerCase();

const log = (...a) => console.log('[cleanup]', ...a);

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dub-sync-cleanup',
      ...(init.headers || {}),
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`${init.method || 'GET'} ${path} → HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  if (!TOKEN) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  if (!REPO) throw new Error('GH_REPO or GITHUB_REPOSITORY is required (owner/name)');

  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  log(`repo=${REPO} retention=${DAYS}d cutoff=${new Date(cutoff).toISOString()}${DRY ? ' (dry run)' : ''}`);

  const releases = [];
  for (let page = 1; page <= 30; page += 1) {
    const { body } = await api(`/repos/${REPO}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(body) || body.length === 0) break;
    releases.push(...body);
    if (body.length < 100) break;
  }

  releases.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  let deleted = 0;
  let kept = 0;

  for (let i = 0; i < releases.length; i += 1) {
    const r = releases[i];
    const tag = String(r.tag_name || '');

    if (tag.toLowerCase().startsWith(KEEP_PREFIX)) {
      log(`keep  ${tag} (protected prefix)`);
      kept += 1;
      continue;
    }
    if (i < KEEP_LATEST) {
      log(`keep  ${tag} (KEEP_LATEST)`);
      kept += 1;
      continue;
    }
    const created = new Date(r.created_at).getTime();
    const ageDays = ((Date.now() - created) / 86400000).toFixed(1);
    if (created > cutoff) {
      log(`keep  ${tag} (age ${ageDays}d)`);
      kept += 1;
      continue;
    }

    log(`${DRY ? 'would delete' : 'delete'} ${tag} (age ${ageDays}d, id ${r.id})`);
    if (DRY) continue;

    await api(`/repos/${REPO}/releases/${r.id}`, { method: 'DELETE' });
    await api(`/repos/${REPO}/git/refs/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    deleted += 1;
  }

  log(`done: deleted=${deleted} kept=${kept} total=${releases.length}`);
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### release cleanup\n\n- repo: \`${REPO}\`\n- retention: ${DAYS} days\n- deleted: ${deleted}\n- kept: ${kept}\n`);
  }
}

main().catch((err) => {
  console.error('[cleanup] FAILED:', err.message);
  process.exit(1);
});
