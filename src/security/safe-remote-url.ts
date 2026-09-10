import dns from "dns/promises";

// Gap B fix: RFC 6598 shared-address space (100.64.0.0/10), used by
// Tailscale and some cloud CGNAT setups, was previously absent from this
// list — an agent reachable on a Tailscale/CGNAT network could be made to
// fetch/clone from an address on its own carrier-grade-NAT segment.
// 100.(64-127).x.x, expressed the same prefix-matching style as the
// existing 172.16-31 range immediately below it:
//   64-69  -> 6[4-9]
//   70-99  -> [7-9]\d
//   100-119 -> 1[01]\d
//   120-127 -> 12[0-7]
const BLOCKED =
  /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fc|fd|fe80)/i;

export interface SafeRemoteUrlResult {
  url: URL;
  /**
   * The addresses `url.hostname` resolved to AT CHECK TIME, already
   * verified non-private/non-loopback/non-CGNAT above. This is not a
   * safety guarantee by itself — see Gap A note on each caller that
   * consumes it. Callers that can pin a real connection to one of these
   * addresses (curl's `--resolve`, a custom DNS `lookup` on an http(s)
   * request) should; callers that can't (git's HTTP transport has no
   * supported pinning hook) get a shrunk-but-not-eliminated TOCTOU
   * window instead — see GIT_CLONE_HARDENED_ARGS below for what IS
   * closable there.
   */
  addresses: string[];
}

/**
 * Validate that `value` is a public, unauthenticated http(s) URL and
 * return the addresses it resolved to at check time.
 *
 * Gap A (DNS rebinding / TOCTOU), acknowledged and only partially
 * closable here: this function's own DNS lookup and the *actual*
 * network connection a caller makes afterwards are two independent
 * resolutions. A hostile DNS server serving a TTL of 0 can legitimately
 * answer this check with a public IP and then answer the real
 * connection's lookup with 127.0.0.1 (or any other private address)
 * moments later. Nothing at this layer can fully close that gap without
 * either (a) the caller pinning its connection to the exact addresses
 * returned here instead of re-resolving, or (b) routing all such egress
 * through a validating SSRF proxy. This function does its part (returns
 * the validated addresses so (a) is possible) but cannot enforce (a) on
 * a caller's behalf, and (b) is out of scope for a single helper
 * function. See each caller for which mitigation it applies.
 */
export async function assertSafeRemoteUrl(value: string): Promise<SafeRemoteUrlResult> {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("URL must be an unauthenticated http(s) URL");
  }
  if (url.hostname === "localhost" || BLOCKED.test(url.hostname)) {
    throw new Error("URL resolves to a private or loopback destination");
  }
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some(({ address }) => BLOCKED.test(address))) {
    throw new Error("URL resolves to a private or loopback destination");
  }
  return { url, addresses: records.map((r) => r.address) };
}

/**
 * curl `--resolve HOST:PORT:ADDR[,ADDR...]` arguments that pin the
 * connection to exactly the addresses assertSafeRemoteUrl already
 * validated. This is the actual Gap A fix for curl-based fetches: curl
 * is short-circuited from doing its own (independently rebindable) DNS
 * lookup for this host:port, while still sending the real hostname over
 * SNI/Host — so TLS certificate validation and name-based virtual
 * hosting both keep working normally. Returns [] if there's nothing to
 * pin (shouldn't happen given assertSafeRemoteUrl always returns at
 * least one address or throws, but keeps this safe to spread either way).
 */
export function curlResolveArgs(url: URL, addresses: string[]): string[] {
  if (!addresses.length) return [];
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return ["--resolve", `${url.hostname}:${port}:${addresses.join(",")}`];
}

/**
 * Node `lookup` option for http(s).request that pins DNS resolution to
 * exactly the addresses assertSafeRemoteUrl already validated — the
 * fetch-API equivalent of curlResolveArgs above, for callers using
 * Node's http/https modules directly (global `fetch` doesn't expose a
 * custom-lookup hook, only a `dispatcher`, which would mean taking on
 * the `undici` package as a new dependency just for this).
 */
export function pinnedDnsLookup(
  addresses: string[],
): (hostname: string, options: any, callback: any) => void {
  return (_hostname, options, callback) => {
    if (options && options.all) {
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );
      return;
    }
    const address = addresses[0];
    callback(null, address, address.includes(":") ? 6 : 4);
  };
}

/**
 * Gap C fix (git clone following redirects): `-c http.followRedirects=false`
 * makes git treat ANY HTTP redirect during the clone as a hard error
 * instead of transparently following it — a hostile git host 3xx'ing the
 * request to an internal endpoint now fails the clone instead of
 * succeeding against the redirected target. Must be passed BEFORE the
 * `clone` subcommand (git's `-c` is a global option), unlike
 * GIT_CLONE_HARDENED_FLAGS below.
 *
 * Does NOT close Gap A for git: git's HTTP transport does its own
 * independent DNS resolution with no supported `--resolve`-style pinning
 * hook, and rewriting the clone URL to an IP literal instead of the
 * hostname would break TLS certificate validation for virtually every
 * real git host (certs are issued for hostnames, not IPs). Closing that
 * fully requires routing git's egress through a validating proxy —
 * tracked as a known residual gap, not silently ignored.
 */
export const GIT_GLOBAL_HARDENED_ARGS = ["-c", "http.followRedirects=false"] as const;

/** Passed after `clone`, alongside its own flags like `--depth`. */
export const GIT_CLONE_HARDENED_FLAGS = ["--no-recurse-submodules"] as const;

/**
 * Env for the git subprocess: don't block on a credential prompt, and
 * don't read ambient system/global gitconfig (which could carry a proxy,
 * credential helper, or other trust decision the operator never intended
 * to apply to a clone of an untrusted, agent-supplied URL).
 */
export const GIT_CLONE_HARDENED_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
} as const;
