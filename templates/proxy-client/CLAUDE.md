# Working in this sandbox

This sandbox has **no direct network access**. All HTTP(S) traffic goes through the proxy
(`http://proxy:8899`, set in `HTTPS_PROXY` and friends), which only lets through hosts on its
allowlist. Anything else is refused with **403**: curl reports `CONNECT tunnel failed, response 403`,
and plain HTTP returns *Blocked by sandbox egress allowlist*. WebFetch is affected the same way.

The proxy intercepts TLS (its CA is in `/proxy-ca/ca-cert.pem`, trusted through `CURL_CA_BUNDLE` and
`NODE_EXTRA_CA_CERTS`) and logs the decrypted traffic for the owner.

When a task needs a blocked host, don't work around the proxy: say which host and why, and the
owner can add it to the proxy's `allowlist.txt`.
