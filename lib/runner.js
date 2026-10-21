// The runner process model, shared by the agent and the metrics
// exporter. A runner is a `Runner.Listener` process; while a job runs
// it has a `Runner.Worker` child, whose descendants are the steps. A
// step's cwd under `_work/<repo>/<repo>` names the repository. A job
// that runs in containers shows the worker only `docker` calls: the
// real steps live under containerd in a container that mounts `_work`
// at `/__w`, so those containers are found by their mounts and their
// processes by cgroup.

export const LISTENER = "Runner.Listener";
export const WORKER = "Runner.Worker";
export const MAX_STEPS = 100;
export const PROCS_QUERY = `procs { pid cwd exe cmdline fd_count cgroups { pathname }
    stat { comm ppid state utime stime cutime cstime starttime rss_bytes num_threads }
    io { read_bytes write_bytes } }`;
export const HOST_QUERY = `kernel_stats { btime processes procs_running procs_blocked
    total { user_ms nice_ms system_ms idle_ms iowait_ms irq_ms softirq_ms steal_ms } }
  meminfo { mem_total mem_available mem_free swap_total swap_free dirty writeback }
  load_average { one five fifteen }
  host { uptime { uptime } ticks_per_second }`;
export const DOCKER_QUERY = `docker { list_containers { id name names image state mounts { source destination } } }`;


// A process that exits between enumeration and read makes the daemon
// reject the whole query; that is a race, not a fault, so try again.
export async function graphQuery(q, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await yeet.graph.query(q); }
    catch (e) { if (i >= attempts || !/File not found: \/proc\//.test(e?.message ?? "")) throw e; }
  }
}

export function byPid(procs) {
  const map = new Map();
  for (const p of procs) if (p.stat) map.set(p.pid, p);
  return map;
}

export function childrenIndex(procs) {
  const kids = new Map();
  for (const p of procs) {
    if (!p.stat) continue;
    const list = kids.get(p.stat.ppid) ?? [];
    list.push(p);
    kids.set(p.stat.ppid, list);
  }
  return kids;
}

export function descendants(pid, kids) {
  const out = [];
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    stack.push(...(kids.get(p.pid) ?? []));
  }
  return out;
}

export function isRunnerBinary(p, name) {
  return p.stat?.comm === name || (p.exe ?? "").endsWith(`/${name}`);
}

export function runnerHome(p) {
  const exe = p.exe ?? "";
  const i = exe.lastIndexOf("/bin/");
  return i > 0 ? exe.slice(0, i) : null;
}

export const REPO_PATH = /\/(?:_work|__w)\/([^/\s"']+)\/\1(?:[/\s"']|$)/;
export const WORK_PATH = /\/(?:_work|__w)\/([^/\s"']+)\//;

export function repoIn(text) {
  if (!text) return null;
  const exact = REPO_PATH.exec(text);
  if (exact) return exact[1];
  const loose = WORK_PATH.exec(text);
  return loose && !loose[1].startsWith("_") ? loose[1] : null;
}

export function repoOf(procs, containers) {
  for (const p of procs) { const r = repoIn(p.cwd); if (r) return r; }
  for (const c of containers) for (const m of c.mounts) { const r = repoIn(m.source) ?? repoIn(m.destination); if (r) return r; }
  for (const p of procs) { const r = repoIn((p.cmdline ?? []).join(" ")); if (r) return r; }
  return null;
}

// Containers the runner made for a job mount its `_work` tree.
// A job's containers mount the runner's work tree, or are named by a
// `docker exec|stop|logs <id>` in the worker's tree: the runner drives
// a `container:` job that way, and its processes live under
// containerd, not under the worker.
export function jobContainers(containers, treeProcs = []) {
  const named = new Set();
  for (const p of treeProcs) {
    if (!isDockerClient(p)) continue;
    for (const a of p.cmdline ?? []) if (/^[0-9a-f]{12,64}$/.test(a) || /^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(a)) named.add(a);
  }
  return containers.filter((c) => c.mounts.some((m) => /\/_work(\/|$)/.test(m.source ?? ""))
    || [...named].some((n) => (n.length >= 12 && c.id.startsWith(n)) || n === c.name));
}
export function isDockerClient(p) {
  return p.stat?.comm === "docker" || (p.cmdline?.[0] ?? "").split("/").pop() === "docker";
}

// What a job is actually running: the processes of its tree and its
// containers that have no children of their own. Container processes
// first, since a `docker exec` client only waits on them, then the
// busiest.
export function jobLeaves(work, kids, ctrProcs, cpuOf = null) {
  const inWork = new Set(work.map((p) => p.pid));
  const leaves = work.filter((p) => !(kids.get(p.pid) ?? []).some((c) => inWork.has(c.pid)));
  const inCtr = (p) => (ctrProcs.has(p.pid) ? 1 : 0);
  const notDocker = (p) => (isDockerClient(p) ? 0 : 1);
  return leaves.sort((a, b) => inCtr(b) - inCtr(a) || notDocker(b) - notDocker(a) || (cpuOf?.get(b.pid) ?? 0) - (cpuOf?.get(a.pid) ?? 0) || b.stat.starttime - a.stat.starttime);
}

// Steps. The worker runs each step as one direct child: a shell on a
// generated `_temp/<guid>.sh`, node on an action's checkout under
// `_actions/<owner>/<repo>/<ref>`, or `docker exec` into the job
// container doing one of those. Only the action's name survives in the
// command line; a `run:` step is just "run".

export function stepLabel(p) {
  const argv = p.cmdline ?? [];
  const line = argv.join(" ");
  const action = /\/_actions\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)/.exec(line);
  if (action) return { kind: "action", label: `${action[1]}/${action[2]}@${action[3]}` };
  if (/\/(?:_temp|__w\/_temp)\/[^\s]+\.(?:sh|ps1|py|js)\b/.test(line)) {
    const shell = argv.findIndex((a) => /^docker$/.test(a.split("/").pop())) >= 0
      ? argv.find((a, i) => i > 0 && /^(bash|sh|pwsh|python3?|node)$/.test(a.split("/").pop())) ?? "sh"
      : argv[0] ?? p.stat.comm;
    return { kind: "run", label: `run (${shell.split("/").pop()})` };
  }
  const docker = argv.findIndex((a) => a.split("/").pop() === "docker");
  if (docker >= 0) return { kind: "docker", label: `docker ${argv[docker + 1] ?? ""}`.trim() };
  return { kind: "other", label: p.stat.comm };
}

export function trackSteps(entry, worker, kids, startOf, now) {
  const children = (kids.get(worker.pid) ?? []).sort((a, b) => a.stat.starttime - b.stat.starttime);
  const livePids = new Set(children.map((c) => c.pid));
  for (const st of entry.steps) if (st.endedAt == null && !livePids.has(st.pid)) st.endedAt = now;
  for (const c of children) {
    if (entry.steps.some((st) => st.pid === c.pid && st.endedAt == null)) continue;
    if (entry.steps.length >= MAX_STEPS) break;
    entry.steps.push({ n: entry.steps.length + 1, pid: c.pid, startedAt: startOf(c), endedAt: null, ...stepLabel(c) });
  }
}

export function stepsView(entry, now) {
  const source = entry.named.length ? entry.named : entry.steps;
  return source.map((st) => ({ n: st.n, kind: st.kind, label: st.label, startedAt: st.startedAt, durationMs: (st.endedAt ?? now) - st.startedAt, done: st.endedAt != null, result: st.result ?? null }));
}

export function metaView(meta) {
  if (!meta) return null;
  const base = `${meta.serverUrl || "https://github.com"}/${meta.repo}`;
  return {
    repo: meta.repo, workflow: meta.workflow, job: meta.job, runId: meta.runId, runNumber: meta.runNumber, runAttempt: meta.runAttempt,
    ref: meta.ref, sha: meta.sha, actor: meta.actor, event: meta.event,
    repoUrl: base, runUrl: `${base}/actions/runs/${meta.runId}${Number(meta.runAttempt) > 1 ? `/attempts/${meta.runAttempt}` : ""}`,
    commitUrl: meta.sha ? `${base}/commit/${meta.sha}` : null,
  };
}

export function containerOf(p, ids) {
  for (const cg of p.cgroups ?? []) {
    const m = /docker-([0-9a-f]{64})\.scope|\/docker\/([0-9a-f]{64})/.exec(cg.pathname);
    const id = m?.[1] ?? m?.[2];
    if (id && ids.has(id)) return id;
  }
  return null;
}


export function cpuBusyTotal(total) {
  const busy = total.user_ms + total.nice_ms + total.system_ms
    + (total.irq_ms ?? 0) + (total.softirq_ms ?? 0) + (total.steal_ms ?? 0);
  return { busy, total: busy + total.idle_ms + (total.iowait_ms ?? 0) };
}

export function runningContainers(docker) {
  return (docker ?? []).filter((c) => c.state === "RUNNING").map((c) => ({
    id: c.id ?? "", name: String(c.name ?? c.names?.[0] ?? "").replace(/^\//, ""), image: c.image, mounts: c.mounts ?? [],
  }));
}

// Each listener with its worker, the job's processes (worker tree plus
// job-container processes), repo and containers. Pure: no history.
export function scanRunners(procs, containers) {
  const kids = childrenIndex(procs);
  const listeners = procs.filter((p) => isRunnerBinary(p, LISTENER));
  const jobCtrs = jobContainers(containers, listeners.flatMap((l) => descendants(l.pid, kids)));
  const jobCtrIds = new Set(jobCtrs.map((c) => c.id));
  const ctrProcs = new Map();
  for (const p of procs) { const id = containerOf(p, jobCtrIds); if (id) ctrProcs.set(p.pid, id); }
  const runners = [];
  for (const listener of listeners) {
    const tree = descendants(listener.pid, kids);
    const worker = tree.find((p) => isRunnerBinary(p, WORKER)) ?? null;
    let work = [], repo = null;
    if (worker) {
      const inTree = descendants(worker.pid, kids);
      const seen = new Set(inTree.map((p) => p.pid));
      work = [...inTree, ...(jobCtrIds.size ? procs.filter((p) => ctrProcs.has(p.pid) && !seen.has(p.pid)) : [])];
      repo = repoOf(work, jobCtrs);
    }
    runners.push({ listener, worker, work, repo, kids });
  }
  return { runners, jobCtrs, ctrProcs };
}
