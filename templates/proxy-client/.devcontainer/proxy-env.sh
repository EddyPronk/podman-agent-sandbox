#!/bin/sh
# proxy-env.sh NAME CLIENT_AUTH: writes ../proxy.env, the proxy settings of this sandbox, which
# devcontainer.json passes to the container with --env-file. Runs on your machine (initializeCommand),
# in the sandbox's config folder, before the container is made.
#
# CLIENT_AUTH=0: the plain proxy URL, http://proxy:8899.
# CLIENT_AUTH=1: the URL with this sandbox's name and token, http://NAME:TOKEN@proxy:8899. The
#   token comes from `vault enroll NAME` in the proxy container, once: while proxy.env holds a URL
#   with a token, it is kept (enrolling again would end the token the sandbox has).
set -eu
name=$1
auth=$2
file=proxy.env
plain=http://proxy:8899

url=$plain
if [ "$auth" = 1 ]; then
    if [ -f "$file" ] && grep -q '^HTTPS_PROXY=http://[^:]*:[^@]*@proxy:8899$' "$file"; then
        exit 0
    fi
    # `vault enroll` prints "enrolled NAME; ...", the URL, then which entry it granted.
    out=$(podman exec proxy /opt/agent-mitm-proxy/venv/bin/vault enroll "$name") || {
        echo "sandbox: couldn't enrol '$name' with the proxy: is it running, made with clientAuth=1 (agent-mitm-proxy 1.4.0 or later)?" >&2
        exit 1
    }
    url=$(printf '%s\n' "$out" | sed -n 2p)
    case $url in
        http://"$name":*@proxy:8899) ;;
        *) echo "sandbox: unexpected answer from 'vault enroll $name' in the proxy" >&2; exit 1 ;;
    esac
fi

# Private from the start: the token is a credential for the proxy.
umask 077
tmp=$file.$$
{
    for var in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do
        echo "$var=$url"
    done
} >"$tmp"
mv "$tmp" "$file"
