// Which npm registry a release talks to (#137).
//
// Releases publish to our own registry first and mirror to npmjs afterwards,
// so an npmjs outage, an expired npmjs token, or a hold on the scope there
// cannot stop a release. Mirrors happyvertical/sdk's scripts/release-registry.mjs.

export const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
export const OWN_REGISTRY = 'https://npm.happyvertical.com/';
export const RELEASE_SCOPE = '@happyvertical';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The only hosts a release may be published to. The publish credential is
// written for, and sent to, whatever host the primary names, so this is a
// reviewed constant and never open-ended configuration.
const ALLOWED_PRIMARY_HOSTS = new Set([
  new URL(OWN_REGISTRY).host,
  new URL(NPMJS_REGISTRY).host,
]);

export function normalizeRegistry(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the input: a malformed value can still carry a credential.
    throw new Error('Invalid registry URL (value withheld)');
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw new Error(`Registry URL must be https (got ${parsed.protocol}//${parsed.host})`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `Registry URL must not carry credentials, a query, or a fragment: ${parsed.origin}${parsed.pathname}`,
    );
  }
  return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
}

// The registry a release is published to and recorded against.
export function primaryRegistry(env = process.env) {
  const url = normalizeRegistry(env.RELEASE_PRIMARY_REGISTRY || OWN_REGISTRY);
  const { host, hostname } = new URL(url);
  if (!LOOPBACK_HOSTS.has(hostname) && !ALLOWED_PRIMARY_HOSTS.has(host)) {
    throw new Error(
      `RELEASE_PRIMARY_REGISTRY names ${host}, which is not an allowed release registry ` +
        `(${[...ALLOWED_PRIMARY_HOSTS].join(', ')}). Add it to ALLOWED_PRIMARY_HOSTS in a reviewed change.`,
    );
  }
  return url;
}

// `--registry` alone is NOT enough: an `@happyvertical:registry` scope mapping
// from any npmrc overrides it for scoped packages. The scope flag on the
// command line outranks every npmrc, so every npm call that names a registry
// carries both.
export function registryArgs(registry) {
  const url = normalizeRegistry(registry);
  return ['--registry', url, `--${RELEASE_SCOPE}:registry=${url}`];
}
