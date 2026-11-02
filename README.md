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

## Getting started

On a runner host, with yeet installed and logged in:

```sh
curl -fsSL https://yeet.cx | sh
yeet login
```

Then one command. `apply` clones this repository and creates the
agent service from its `service.toml`:

```sh
yeet service apply -f https://github.com/yeet-src/runner-watch
```

That starts the agent on `:9420`: `/tty` streams a frame a second,
`/metrics` and `/llms.txt` answer per request. Run the same line again
to move to a newer commit: `apply` rolls the change out in place, and a
service you had stopped stays stopped.

```sh
curl -fsS localhost:9420/llms.txt            # one snapshot, as text
yeet dial ws://127.0.0.1:9420/tty            # the frames; ctrl-c to leave
yeet service remove -f runner-watch          # stop and remove it
```

The hub is a second service on any host that can reach the runners,
usually over Tailscale. From a checkout there:

```sh
git clone https://github.com/yeet-src/runner-watch.git && cd runner-watch
make hub PREFIX=github-actions-runner-
```

`install-hub.sh` finds every tailnet host whose name starts with the
prefix, writes `hub.toml` with one upstream route per runner, and
applies it. Open http://localhost:9430/. To change the roster, rerun it
or edit `hub.toml` and `yeet service apply -f hub.toml`; to add one
runner to the running hub without a rewrite:

```sh
yeet service mount runner-watch-hub/web -L /r/<name> -U http://<name>:9420/
```

### The whole fleet at once

`scripts/deploy.sh` does both sides over ssh, plus the optional job
hook that supplies step names and run links, which needs the checkout
on the runner. On the hub host:

```sh
scripts/deploy.sh --all --prefix github-actions-runner- --restart-runner
```

> This uses tailscale to find every host whose name starts with the
> prefix, copies the tree to `~/runner-watch` on each and applies the
> agent there, wires the job hook into the runner's `.env`, then
> installs the hub on this host with the same roster. It logs in as
> you unless you set `SSH_USER=runner` or write `user@host`;
> deploying as the runner's own user is simplest, since that user
> runs the job hook. To skip discovery, name the hosts:
> `scripts/deploy.sh user@host1 user@host2 --restart-runner`.

Rerun it to roll out a change. `--restart-runner` restarts an idle
runner so the hook takes effect, since the runner reads `.env` only at
startup.

The runner executes the job hook as its own user, which must be able to
read `~/runner-watch/hooks` in the login user's home, and the install
writes the runner's `.env`. The simplest arrangement is to deploy as the
runner's user: `SSH_USER=runner scripts/deploy.sh --all`. Otherwise
`install-hooks.sh` prints a note when the runner's user cannot read the
hooks. Set `SUDO=sudo` if the yeet socket needs it.

The workflow in `.github/workflows/deploy-runners.yml` does the runner
side without ssh: on `workflow_dispatch`, one job per runner runs on
that runner, upgrades yeet, applies `service.toml` to itself and wires
the hook. It needs passwordless sudo for the runner's user and takes
the runner names from a repository variable `RUNNERS` (a JSON array),
defaulting to `github-actions-runner-1` through `-16`.

To run the hub on another host, `scripts/deploy-hub.sh user@host` copies
the committed tree there over ssh and runs `install-hub.sh`; the host
needs yeet, tailscale and python3 but not access to GitHub. The
workflow in `.github/workflows/deploy-hub.yml` does the same from a
self-hosted runner on every push to `main`. It needs a repository
secret `HUB_SSH_KEY` holding a private key the hub user accepts, and
optionally a variable `HUB_HOST` (default
`debian@sandbox.great-lime.ts.net`).

### Names and ports

The dashboard names each runner by its hub route, `/r/<name>/`.
`/metrics` and `/llms.txt` on the agent carry a name too: `--name` in
`service.toml` sets it, and without one the agent takes the
`RUNNER_NAME` the job hook reports with the first job. Another port
is an edit to `service.toml`'s `web-server`, or:

```sh
make up PORT=9421                              # this host
scripts/install-agent.sh --name ci-3 --port 9421
```

Both render a copy of `service.toml` with the name and port swapped
in and apply it under the `runner-watch` alias.

| script | what |
|---|---|
| `scripts/deploy.sh HOST… \| --all [--prefix P] [--restart-runner] [--no-hub]` | apply the agent and wire the hook on runners over ssh, then the hub here (`SSH_USER`, `SSH_OPTS`, `SUDO`, `PORT`) |
| `scripts/install-agent.sh [--name N] [--port P]` | apply `service.toml` on the current host with a name and port |
| `scripts/install-hooks.sh [--root DIR] [--restart]` | wire the job hook into the runner's `.env` on the current host |
| `scripts/install-hub.sh [--port P] [--prefix P] [--runner NAME=HOST…] [--dry-run]` | write and apply `hub.toml` on the current host |
| `scripts/deploy-hub.sh [user@]HOST [install-hub flags]` | install the hub on another host over ssh and check it answers |
| `scripts/fake-runner.sh [root] [repo]` | a stand-in `Runner.Listener`/`Runner.Worker` that runs a job every few seconds; `CONTAINER=1` runs the job through `docker exec` |

`make up`, `make hub`, `make down`, `make status` and `make check` wrap
the common ones.

## What it shows

Two views, switched in the header: a list and a timeline. The timeline
is a Gantt chart with one lane per runner and a bar per job, grey for
completed jobs from each agent's history and yellow for the one running,
with step boundaries drawn inside the bar, a red strip under a failed
step, and a selectable window from 15 minutes to 24 hours. Bars link to
the run on GitHub when the hook supplied it.

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

`service.toml` is the whole agent: three isolates and a web server.
`hub.toml` is the hub: one static route, one lazy isolate, and an
upstream route per runner. `yeet service apply -f <file>` rolls an
edit to either out.

`/metrics` and `/llms.txt` are per-connection console routes: each GET
spawns an isolate that takes one sample, prints and exits, which ends
the chunked body. Notable series: `runner_watch_health_level`,
`runner_watch_health_reason{code}`, `runner_watch_listener_connected`,
`runner_watch_job_wait{kind}`, `runner_watch_job_elapsed_seconds`,
`runner_watch_host_cpu_split_ratio{kind}`, `runner_watch_iface_up`.

## Planned improvements

- Runners registering with the hub on their own, instead of a rerun of
  `install-hub.sh` or a mounted route.
- Reading the hostname from the daemon, so `/metrics` is labelled
  before the first job runs.
- Disk usage, once the system graph exposes filesystems.
- A fleet-wide `/llms.txt` on the hub that aggregates the runners,
  which needs isolates to be able to dial out.
- Active dns and connect probes from the runner.
- History that survives an agent restart; today jobs completed, busy
  ratio and step timings start over with the agent.
