# runner-watch on yeet.
#
#   make up                  # the agent on this host, :9420
#   make up PORT=9421        # another port
#   make hub                 # the hub on this host from the tailnet roster, :9430
#   make hub PREFIX=ci-      # another hostname prefix
#   make down                # stop and remove both
#   make status              # the service trees
#   make scrape              # curl /metrics
#   make check               # syntax over every script

PORT   ?= 9420
HUB_PORT ?= 9430
PREFIX ?= github-actions-runner-

up:
	scripts/install-agent.sh --port $(PORT)

hub:
	scripts/install-hub.sh --port $(HUB_PORT) --agent-port $(PORT) --prefix $(PREFIX)

down:
	-yeet service remove -f runner-watch
	-yeet service remove -f runner-watch-hub

status:
	-yeet service tree runner-watch
	-yeet service tree runner-watch-hub

scrape:
	curl -fsS localhost:$(PORT)/metrics

check:
	@set -e; for f in *.js lib/*.js; do node --check "$$f"; done; echo "js ok"
	@set -e; for f in scripts/*.sh hooks/*.sh; do bash -n "$$f"; done; echo "sh ok"

.PHONY: up hub down status scrape check
