import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual github-script body, not a second implementation of the gate.
const yaml = readFileSync(new URL('../.github/workflows/ci-health-check.yml', import.meta.url), 'utf8');
const lines = yaml.split('\n');
const start = lines.findIndex((line) => line.trim() === 'script: |');
assert.notEqual(start, -1);
const body = [];
for (const line of lines.slice(start + 1)) {
  if (line.trim() && !line.startsWith('            ')) break;
  body.push(line.slice(12));
}
const script = new vm.Script(`(async () => {${body.join('\n')}\n})()`);
const green = { name: 'Visible job', status: 'completed', conclusion: 'success' };
const workflow = (overrides = {}) => ({
  id: 10, workflow_id: 100, event: 'pull_request', run_attempt: 1,
  name: 'PR CI', status: 'queued', conclusion: null,
  html_url: 'https://github.com/example/repo/actions/runs/10', ...overrides,
});

async function gate(frames) {
  let now = 0;
  let polls = 0;
  const result = { failures: [], info: [], summaries: [], comments: [] };
  const frame = () => frames[Math.min(polls, frames.length - 1)];
  const checks = Symbol('checks');
  const runs = Symbol('runs');
  const comments = Symbol('comments');
  const github = {
    rest: {
      checks: { listForRef: checks },
      actions: { listWorkflowRunsForRepo: runs },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: frame().statuses ?? [] } }) },
      issues: {
        listComments: comments,
        createComment: async (payload) => result.comments.push(payload.body),
      },
    },
    paginate: async (endpoint, args) => {
      if (endpoint === comments) return [];
      assert.equal(args.owner, 'example');
      assert.equal(args.repo, 'repo');
      assert.equal(args.per_page, 100);
      if (endpoint === checks) {
        assert.equal(args.ref, '810bd17d');
        return frame().checks ?? [green];
      }
      assert.equal(endpoint, runs);
      assert.equal(args.head_sha, '810bd17d');
      const value = frame().runs ?? [];
      polls++;
      return value;
    },
  };
  const core = {
    info: (message) => result.info.push(message),
    warning: (message) => assert.fail(message),
    setFailed: (message) => result.failures.push(message),
    summary: {
      addRaw(message) { result.summaries.push(message); return this; },
      async write() {},
    },
  };
  await script.runInNewContext({
    github, core,
    context: { repo: { owner: 'example', repo: 'repo' }, runId: 999,
      payload: { pull_request: { number: 1075, head: { sha: '810bd17d' } } } },
    Date: { now: () => now },
    setTimeout: (callback, ms) => {
      now += ms;
      assert.ok(now < 26 * 60 * 1000, 'polling must remain bounded');
      callback();
    },
  });
  return { ...result, polls, now };
}

const passed = (result) => {
  assert.deepEqual(result.failures, []);
  assert.match(result.summaries.at(-1), /CI Health Check passed/);
};

test('queued workflow blocks green visible checks until its jobs and workflow pass', async () => {
  const result = await gate([
    { runs: [workflow()] },
    { runs: [workflow({ status: 'in_progress' })] },
    { runs: [workflow({ status: 'completed', conclusion: 'success' })] },
  ]);
  passed(result);
  assert.equal(result.polls, 3);
  assert.equal(result.now, 50000);
  assert.equal(result.info.filter((line) => line.includes('Waiting on')).length, 2);
});

test('workflow failure is reported even when all visible checks are green', async () => {
  const result = await gate([
    { runs: [workflow()] },
    { runs: [workflow({ status: 'completed', conclusion: 'failure' })] },
  ]);
  assert.equal(result.polls, 2);
  assert.deepEqual(result.failures, ['CI Health Check failed: PR CI (failure)']);
  assert.match(result.comments[0], /PR CI/);
  assert.match(result.comments[0], /https:\/\/github.com\/example\/repo\/actions\/runs\/10/);
});

test('current run, other health runs and advisory checks/workflows never gate', async () => {
  const result = await gate([{ runs: [
    workflow({ id: 999, name: 'Unrecognized current run' }),
    workflow({ id: 11, workflow_id: 101, name: 'CI HEALTH CHECK rerun' }),
    workflow({ id: 12, workflow_id: 102, name: 'Copilot code review' }),
    workflow({ id: 13, workflow_id: 103, name: 'CodeRabbit review' }),
  ], checks: [green, { name: 'Copilot', status: 'in_progress' }] }]);
  passed(result);
  assert.equal(result.polls, 1);
});

test('newest run wins over an older cancelled run regardless of API order', async () => {
  const old = workflow({ status: 'completed', conclusion: 'cancelled' });
  const newer = workflow({ id: 20, status: 'completed', conclusion: 'success' });
  for (const runs of [[old, newer], [newer, old]]) passed(await gate([{ runs }]));
  const rerun = { ...old, run_attempt: 2, conclusion: 'success' };
  for (const runs of [[old, rerun], [rerun, old]]) passed(await gate([{ runs }]));
});

test('newer queued run is not masked by an older successful run', async () => {
  const old = workflow({ status: 'completed', conclusion: 'success' });
  const result = await gate([
    { runs: [workflow({ id: 20 }), old] },
    { runs: [old, workflow({ id: 20, status: 'completed', conclusion: 'success' })] },
  ]);
  passed(result);
  assert.equal(result.polls, 2);
});

test('workflow identity and event both distinguish independent runs', async () => {
  for (const identity of [{ event: 'push' }, { workflow_id: 200 }]) {
    const result = await gate([{ runs: [
      workflow({ status: 'completed', conclusion: 'failure' }),
      workflow({ ...identity, id: 20, status: 'completed', conclusion: 'success' }),
    ] }]);
    assert.deepEqual(result.failures, ['CI Health Check failed: PR CI (failure)']);
  }
});

test('docs-only with no sibling CI still passes after two empty confirmations', async () => {
  const result = await gate([{ checks: [], runs: [] }]);
  passed(result);
  assert.equal(result.polls, 2);
  assert.equal(result.now, 35000);
});

test('a workflow that stays queued fails at the existing 25-minute deadline', async () => {
  const result = await gate([{ runs: [workflow()] }]);
  assert.deepEqual(result.failures, ['CI Health Check timed out: PR CI']);
  assert.ok(result.now > 25 * 60 * 1000);
  assert.match(result.comments[0], /PR CI/);
});

test('existing failing checks and legacy statuses still block', async () => {
  for (const frame of [
    { checks: [{ ...green, conclusion: 'failure' }] },
    { statuses: [{ context: 'Legacy CI', state: 'error' }] },
  ]) {
    const result = await gate([frame]);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /CI Health Check failed: (Visible job|Legacy CI) \(failure\)/);
  }
});

test('pending legacy status waits and skipped/neutral checks remain acceptable', async () => {
  const result = await gate([
    { statuses: [{ context: 'Legacy CI', state: 'pending' }] },
    { statuses: [{ context: 'Legacy CI', state: 'success' }],
      checks: [{ ...green, conclusion: 'skipped' }, { ...green, conclusion: 'neutral' }] },
  ]);
  passed(result);
  assert.equal(result.polls, 2);
});
