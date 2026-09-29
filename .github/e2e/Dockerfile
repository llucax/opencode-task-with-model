# The environment scripts/e2e.sh runs in on CI: OpenCode's official image plus
# the tools the script needs, which the image doesn't ship.
#
# The pinned image is the OpenCode version the README says the hooks were
# checked against. It lives here, rather than in the workflow, so Dependabot
# can bump it: it updates Dockerfiles but not container images in workflows.
# Build with --build-arg OPENCODE_IMAGE=<image> to test another version.
ARG OPENCODE_IMAGE=pinned

FROM ghcr.io/anomalyco/opencode:1.18.32@sha256:b3ce2a73474c57d19abb8c1e9d955c66066b4263e8f15167ba6e6c5ddf9a7ee0 AS pinned

FROM ${OPENCODE_IMAGE}
RUN apk add --no-cache bash curl jq python3
ENTRYPOINT []
