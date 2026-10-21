// Diagnosis: the facts that answer "why is this runner unhappy", all
// derived from the system graph. The agent samples these every few
// seconds for the listener and the current step's leaf processes; the
// exporter and llms.txt take one sample. Everything here is pure.
//
// Sockets: a process's fds carry socket inodes, and the tcp tables
// carry inode, state and remote address, so joining the two says what
// a process is connected to and whether a connect is still pending.

export const DIAG_HOST_QUERY = `network_interfaces { name is_up is_running default is_loopback is_tun dns_servers { addr } ipv4 { address } }
  network_interface_stats { name recv_bytes recv_errs recv_drop sent_bytes sent_errs sent_drop }
  hwmons { name temps { name input max crit } }`;
export const TCP_QUERY = `tcp { remote_address { ip { addr } port } state inode rx_queue tx_queue }
  tcp6 { remote_address { ip { addr } port } state inode rx_queue tx_queue }`;
export const FDS_QUERY = (pid) => `{ proc(pid: ${pid}) { pid fds { kind inode } status { fdsize } } }`;

// One query per pid: a pid that exited since the tick rejects its own
// query and nothing else.
export async function fdsOf(pids, limit = 16) {
  const fds = new Map(), fdsize = new Map();
  const results = await Promise.allSettled([...new Set(pids)].slice(0, limit).map((pid) => yeet.graph.query(FDS_QUERY(pid))));
  for (const r of results) {
    const v = r.status === "fulfilled" ? r.value?.data?.proc : null;
    if (v?.pid != null) { fds.set(v.pid, v.fds ?? []); fdsize.set(v.pid, v.status?.fdsize ?? null); }
  }
  return { fds, fdsize };
}

// GitHub's published ranges (api.github.com/meta, "web", "api", "git").
// Actions results and artifacts go to Azure fronts that change, so an
// unknown public remote on 443 is reported as "remote", not as a miss.
const GITHUB_V4 = [["140.82.112.0", 20], ["143.55.64.0", 20], ["192.30.252.0", 22], ["185.199.108.0", 22]];
const GITHUB_V6 = ["2a0a:a440:", "2606:50c0:"];
const v4 = (ip) => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
export function isGithubIp(ip) {
  if (!ip) return false;
  if (ip.includes(":")) return GITHUB_V6.some((p) => ip.toLowerCase().startsWith(p));
  const n = v4(ip);
  return GITHUB_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4(base) >>> (32 - bits)));
}
export function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.includes(":")) return /^(::1$|::$|fe80:|fc|fd|::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i.test(ip);
  return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
}

export function tcpIndex(data) {
  const map = new Map();
  for (const t of [...(data.tcp ?? []), ...(data.tcp6 ?? [])]) map.set(String(t.inode), t);
  return map;
}

// Sockets held by one process, joined to the tcp tables. Listening and
// loopback sockets are dropped: they say nothing about reachability.
export function socketsOf(fds, tcpByInode) {
  const out = [];
  for (const f of fds ?? []) {
    if (f.kind !== "SOCKET" || f.inode == null) continue;
    const t = tcpByInode.get(String(f.inode));
    if (!t || t.state === "Listen") continue;
    const ip = t.remote_address?.ip?.addr ?? "";
    if (isPrivateIp(ip) && !/^100\./.test(ip)) continue;
    out.push({ ip, port: t.remote_address?.port ?? 0, state: t.state, rx: t.rx_queue ?? 0, tx: t.tx_queue ?? 0, github: isGithubIp(ip) });
  }
  return out;
}

// The listener keeps one long poll open to GitHub; without any
// established public socket it is not getting jobs, whatever the
// process list says.
export function listenerNet(sockets) {
  const est = sockets.filter((s) => s.state === "Established");
  const syn = sockets.filter((s) => s.state === "SynSent");
  const gh = est.filter((s) => s.github);
  return {
    connected: est.length > 0, github: gh.length > 0, established: est.length, connecting: syn.length,
    remotes: est.slice(0, 4).map((s) => `${s.ip}:${s.port}${s.github ? " (github)" : ""}`),
  };
}

// Processes in the worker's tree with no children: whatever the step
// is actually doing lives there.
export function leafProcs(worker, kids) {
  const out = [];
  const stack = [...(kids.get(worker.pid) ?? [])];
  while (stack.length) {
    const p = stack.pop();
    const ch = kids.get(p.pid) ?? [];
    if (ch.length) stack.push(...ch); else out.push(p);
  }
  return out;
}

// What the current step is waiting on. `activity` is the job tree's
// cpu share plus io bytes/s over the last tick; `sockets` are the
// leaves' sockets when the slow sample has them.
export function waitState({ leaves, activity, sockets }) {
  const states = leaves.map((p) => p.stat.state);
  const leaf = leaves[0] ?? null;
  const who = leaf ? `${leaf.stat.comm} (pid ${leaf.pid})` : "worker";
  if (activity.cpu >= 0.05 || activity.io >= 1 << 20 || states.includes("R")) return { kind: "running", detail: `${who} is busy` };
  if (states.includes("D")) return { kind: "disk", detail: `${who} is in uninterruptible io wait` };
  if (leaves.length && states.every((s) => s === "Z")) return { kind: "zombie", detail: `${who} exited but was not reaped` };
  if (states.includes("T")) return { kind: "stopped", detail: `${who} is stopped (SIGSTOP or a debugger)` };
  const syn = sockets?.find((s) => s.state === "SynSent");
  if (syn) return { kind: "connecting", detail: `${who} is waiting for a tcp connect to ${syn.ip}:${syn.port}` };
  const est = sockets?.find((s) => s.state === "Established");
  if (est) return { kind: "network", detail: `${who} is waiting on ${est.github ? "github " : ""}${est.ip}:${est.port}${est.tx ? ` (${est.tx} bytes unacked)` : ""}` };
  if (!leaves.length) return { kind: "setup", detail: "worker has no child process: setting up, or between steps" };
  return { kind: "sleeping", detail: `${who} is sleeping with no cpu, io or public socket: likely waiting on a pipe, lock or child` };
}

export function cpuParts(prev, cur) {
  if (!prev) return null;
  const d = (k) => Math.max(0, (cur[k] ?? 0) - (prev[k] ?? 0));
  const total = ["user_ms", "nice_ms", "system_ms", "idle_ms", "iowait_ms", "irq_ms", "softirq_ms", "steal_ms"].reduce((s, k) => s + d(k), 0);
  if (total <= 0) return null;
  return { user: (d("user_ms") + d("nice_ms")) / total, system: (d("system_ms") + d("irq_ms") + d("softirq_ms")) / total, iowait: d("iowait_ms") / total, steal: d("steal_ms") / total };
}

export function ifaceView(data, prevStats, dtMs) {
  const stats = new Map((data.network_interface_stats ?? []).map((s) => [s.name, s]));
  const out = [];
  for (const i of data.network_interfaces ?? []) {
    if (i.is_loopback || /^(veth|br-|docker)/.test(i.name)) continue;
    const s = stats.get(i.name), p = prevStats?.get(i.name);
    const rate = (k) => (s && p && dtMs > 0 ? Math.max(0, (s[k] - p[k]) / (dtMs / 1000)) : null);
    out.push({
      name: i.name, up: Boolean(i.is_up && i.is_running), default: Boolean(i.default), tun: Boolean(i.is_tun),
      ipv4: (i.ipv4 ?? []).map((a) => a.address), dns: (i.dns_servers ?? []).map((d) => d.addr),
      errs: s ? s.recv_errs + s.sent_errs : null, drops: s ? s.recv_drop + s.sent_drop : null,
      dropRate: rate("recv_drop") == null ? null : rate("recv_drop") + rate("sent_drop"), rxRate: rate("recv_bytes"), txRate: rate("sent_bytes"),
    });
  }
  return { ifaces: out, stats };
}

export function hottest(hwmons) {
  let best = null;
  for (const h of hwmons ?? []) for (const t of h.temps ?? []) {
    if (t.input == null) continue;
    const deg = (v) => (v == null ? null : Math.abs(v) > 1000 ? v / 1000 : v);
    const c = deg(t.input), limit = deg(t.crit ?? t.max ?? null);
    if (!best || c > best.c) best = { c, limit, name: `${h.name}${t.name ? ` ${t.name}` : ""}` };
  }
  return best;
}

// Health reasons. `level` is "warn" or "critical"; codes are stable so
// metrics and the dashboard can key on them.
export function assess({ host, runners, leftovers, ifaces, temp }) {
  const r = [];
  const add = (level, code, text) => r.push({ level, code, text });
  const mem = host.mem, availShare = mem.total ? mem.available / mem.total : 1;
  if (availShare < 0.05) add("critical", "mem_low", `only ${Math.round(availShare * 100)}% of memory available`);
  else if (availShare < 0.12) add("warn", "mem_low", `${Math.round(availShare * 100)}% of memory available`);
  if (host.swap?.total && host.swap.total - host.swap.free > 0.25 * host.swap.total) add("warn", "swapping", `${Math.round(100 * (host.swap.total - host.swap.free) / host.swap.total)}% of swap in use`);
  if (host.dirty != null && host.dirty + (host.writeback ?? 0) > 1 << 30) add("warn", "writeback", `${((host.dirty + host.writeback) / 2 ** 30).toFixed(1)} GiB of dirty pages waiting for disk`);
  const parts = host.cpuParts;
  if (parts?.iowait > 0.25) add("warn", "iowait", `${Math.round(parts.iowait * 100)}% of cpu time waiting on io`);
  if (parts?.steal > 0.1) add("warn", "steal", `${Math.round(parts.steal * 100)}% cpu steal: the hypervisor is overcommitted`);
  if (host.blocked != null && host.cpus && host.blocked > host.cpus) add("warn", "blocked", `${host.blocked} processes blocked on io`);
  if (host.load?.[0] > 2 * host.cpus) add("warn", "load", `load ${host.load[0].toFixed(1)} on ${host.cpus} cpus`);
  if (host.zombies > 20) add("warn", "zombies", `${host.zombies} zombie processes`);
  if (temp?.limit && temp.c >= temp.limit - 5) add("critical", "thermal", `${temp.name} at ${Math.round(temp.c)}°C, limit ${Math.round(temp.limit)}°C`);
  else if (temp && temp.c >= 90) add("warn", "thermal", `${temp.name} at ${Math.round(temp.c)}°C`);
  if (!runners.length) add("critical", "no_listener", "no Runner.Listener process");
  for (const x of runners) {
    const tag = runners.length > 1 ? `listener ${x.pid}: ` : "";
    if (x.net && !x.net.connected && x.net.disconnectedMs > 15_000) add(x.net.disconnectedMs > 120_000 ? "critical" : "warn", "disconnected", `${tag}no established connection to GitHub for ${Math.round((x.net.disconnectedMs ?? 0) / 1000)}s`);
    if (x.fd?.limit && x.fd.open > 0.8 * x.fd.limit) add("warn", "fds", `${tag}${x.fd.open} of ${x.fd.limit} file descriptors open`);
    const j = x.job;
    if (!j) continue;
    if (j.wait && j.wait.idleMs > 120_000 && j.wait.kind !== "running") add("warn", "stall", `${tag}job idle for ${Math.round(j.wait.idleMs / 1000)}s: ${j.wait.detail}`);
    if (j.step?.slow) add("warn", "slow_step", `${tag}step ${j.step.n} "${j.step.label}" at ${Math.round(j.step.durationMs / 1000)}s, usually ${Math.round(j.step.typicalMs / 1000)}s`);
    if (j.wait?.kind === "disk" && j.wait.sinceMs > 30_000) add("warn", "disk_wait", `${tag}${j.wait.detail} for ${Math.round(j.wait.sinceMs / 1000)}s`);
    if (j.wait?.kind === "connecting" && j.wait.sinceMs > 10_000) add("warn", "connect_timeout", `${tag}${j.wait.detail}`);
  }
  if (leftovers?.containers?.length) add("warn", "leftover_containers", `${leftovers.containers.length} job container${leftovers.containers.length === 1 ? "" : "s"} still running with no job`);
  if (leftovers?.procs?.length) add("warn", "leftover_procs", `${leftovers.procs.length} process${leftovers.procs.length === 1 ? "" : "es"} from a finished job still running`);
  const def = (ifaces ?? []).find((i) => i.default);
  if (ifaces?.length && !def) add("critical", "no_default_route", "no interface has a default route");
  else if (def && !def.up) add("critical", "iface_down", `default interface ${def.name} is down`);
  else if (def && !def.dns.length && !ifaces.some((i) => i.dns.length)) add("warn", "no_dns", "no dns servers configured on any interface");
  for (const i of ifaces ?? []) if (i.dropRate > 10) add("warn", "drops", `${i.name} dropping ${Math.round(i.dropRate)} packets/s`);
  const level = r.some((x) => x.level === "critical") ? "critical" : r.length ? "warn" : "ok";
  return { level, reasons: r };
}

// One-shot version of the agent's slow sample, for the per-request
// isolates. Rates need two samples, so interfaces come without them.
export async function diagSample(pids) {
  const [{ data, errors }, { fds, fdsize }] = await Promise.all([yeet.graph.query(`{ ${TCP_QUERY} ${DIAG_HOST_QUERY} }`), fdsOf(pids)]);
  if (!data) throw new Error(errors?.[0]?.message ?? "no data");
  const tcp = tcpIndex(data);
  return { tcp, fds, fdsize, ifaces: ifaceView(data, null, 0).ifaces, temp: hottest(data.hwmons), sockets: (pid) => (fds.has(pid) ? socketsOf(fds.get(pid), tcp) : null) };
}

// Leftovers as a single sample sees them: only when no job is running.
export function leftoversNow({ runners, jobCtrs, ctrProcs }, procs, inTree, workPath) {
  if (!runners.length || runners.some((r) => r.worker)) return null;
  const listeners = new Set(runners.map((r) => r.listener.pid));
  const orphans = procs.filter((p) => !inTree.has(p.pid) && !listeners.has(p.pid) && (workPath.test(p.cwd ?? "") || ctrProcs.has(p.pid)));
  if (!orphans.length && !jobCtrs.length) return null;
  return { containers: jobCtrs.map((c) => ({ id: c.id.slice(0, 12), name: c.name, image: c.image })), procs: orphans.slice(0, 10).map((p) => ({ pid: p.pid, comm: p.stat.comm, cwd: p.cwd ?? null })) };
}
