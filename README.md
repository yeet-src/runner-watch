# runner-watch

What every self-hosted GitHub Actions runner is doing, on one page, from
yeet's system graph. An agent on each runner host reads the process
table, cpu, memory, load and docker once a second and streams a frame;
a hub on any host proxies every agent and serves the dashboard.

![dashboard](docs/dashboard.png)

Each runner also serves `/metrics` for Prometheus and `/llms.txt` for
anything that would rather read text. Nothing runs inside the job, and
the runner software is untouched apart from an optional job hook that
supplies step names and run links.

## Quick start

You need yeet installed and logged in on the runners and on one hub
host, and ssh from the hub to the runners. On the hub:

1. Get the code.

   ```sh
   git clone https://github.com/yeet-src/runner-watch.git && cd runner-watch
   ```

2. Deploy.

   ```sh
   scripts/deploy.sh --all --prefix github-actions-runner- --restart-runner
   ```

   > This uses tailscale to find every host whose name starts with the
   > prefix, installs the agent on each over ssh, then installs the hub
   > on this host with the same roster. It logs in as you unless you set
   > `SSH_USER=runner` or write `user@host`; deploying as the runner's
   > own user is simplest, since that user runs the job hook. To skip
   > discovery, name the hosts: `scripts/deploy.sh user@host1 user@host2
   > --restart-runner`.

3. Open http://localhost:9430/

### Details

`deploy.sh` copies this directory to `~/runner-watch` on each runner,
installs the agent as a yeet service on port 9420, wires the job hook
into the runner's `.env`, and checks the agent answers from here. Rerun
it to roll out a change. `--restart-runner` restarts an idle runner so
the hook takes effect, since the runner reads `.env` only at startup.

The runner executes the job hook as its own user, which must be able to
read `~/runner-watch/hooks` in the login user's home, and the install
writes the runner's `.env`. The simplest arrangement is to deploy as the
runner's user: `SSH_USER=runner scripts/deploy.sh --all`. Otherwise
`install-hooks.sh` prints a note when the runner's user cannot read the
hooks. Set `SUDO=sudo` if the yeet socket needs it.

To add a runner later, `scripts/deploy.sh --all` again, or mount the
route on the running hub:

```sh
yeet service mount runner-watch-hub/web -L /r/<name> -U http://<name>:9420/
```

| script | what |
|---|---|
| `scripts/deploy.sh HOST… \| --all [--prefix P] [--restart-runner] [--no-hub]` | install agent and hook on runners over ssh, then the hub here (`SSH_USER`, `SSH_OPTS`, `SUDO`, `PORT`) |
| `scripts/install-agent.sh [--name N] [--port P] [--dev]` | install the agent service on the current host |
| `scripts/install-hooks.sh [--root DIR] [--restart]` | wire the job hook into the runner's `.env` on the current host |
| `scripts/install-hub.sh [--port P] [--prefix P] [--runner NAME=HOST…] [--dry-run]` | install the hub on the current host |
| `scripts/fake-runner.sh [root] [repo]` | a stand-in `Runner.Listener`/`Runner.Worker` that runs a job every few seconds; `CONTAINER=1` runs the job through `docker exec` |

## What it shows

Tiles for the fleet: reachable, busy, jobs completed, average cpu, share
of runners busy, and runners with alerts, each with a sparkline.

One row per runner, busy first, then by health: state, health, cpu and
memory meters, load, the job with its current step, elapsed, jobs done
and the share of uptime spent busy. The panel under a row shows:

- the current job with links to the repository, run and commit, the
  steps so far with real names, timings and results, a "waiting on" line
  for the current step, containers and top processes;
- the previous run's steps for comparison, and recent jobs;
- a diagnosis: the listener's connection to GitHub, cpu split into user,
  system, iowait and steal, blocked and zombie processes, swap and dirty
  pages, the default interface with dns and throughput, the hottest
  sensor, the listener's file descriptors, leftovers from a finished
  job, and clock skew against the browser;
- host facts.

Health rolls those up with stable reason codes: `mem_low`, `swapping`,
`writeback`, `iowait`, `steal`, `blocked`, `load`, `zombies`,
`thermal`, `no_listener`, `disconnected`, `fds`, `stall`, `slow_step`,
`disk_wait`, `connect_timeout`, `leftover_containers`, `leftover_procs`,
`no_default_route`, `iface_down`, `no_dns`, `drops`, plus the hub's own
`unreachable`, `agent_stalled`, `connecting` and `clock_skew`.

"Waiting on" classifies the current step's leaf processes as `running`,
`disk`, `network`, `connecting`, `sleeping`, `setup`, `zombie` or
`stopped`, from process state, cpu and io deltas and the sockets they
hold. For a `container:` job the leaves are the processes inside the
container, found by cgroup, not the `docker exec` client. A step is
marked slow when it is past twice its median duration for that step
name and repository, learned from the hook's step results.

## Endpoints

On each agent (port 9420), and through the hub under `/r/<name>/`:

| path | kind | content |
|---|---|---|
| `/tty` | websocket | one OSC 7880 frame per second: `{t:"tick", ts, name, host, runners[], health, stats, history[]}` |
| `/metrics` | per-request | Prometheus exposition, `runner_watch_*`, labelled `runner="<name>"` |
| `/llms.txt` | per-request | markdown snapshot: health, host, network, runners, containers |
| `/.well-known/yeet/manifest.json` | | the route manifest |

On the hub (port 9430): `/` the dashboard, `/llms.txt` an index of the
fleet, `/runners.json` the configured names, and the manifest, which
lists every reachable runner's routes.

`/metrics` and `/llms.txt` are per-connection console routes: each GET
spawns an isolate that takes one sample, prints and exits, which ends
the chunked body. Notable series: `runner_watch_health_level`,
`runner_watch_health_reason{code}`, `runner_watch_listener_connected`,
`runner_watch_job_wait{kind}`, `runner_watch_job_elapsed_seconds`,
`runner_watch_host_cpu_split_ratio{kind}`, `runner_watch_iface_up`.

## Planned improvements

- Runners registering with the hub on their own, instead of a rerun of
  `install-hub.sh` or a mounted route.
- Disk usage, once the system graph exposes filesystems.
- A fleet-wide `/llms.txt` on the hub that aggregates the runners,
  which needs isolates to be able to dial out.
- Active dns and connect probes from the runner.
- History that survives an agent restart; today jobs completed, busy
  ratio and step timings start over with the agent.
