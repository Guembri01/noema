/**
 * The version the server reports.
 *
 * `npm run dev/start` exports the package version as `npm_package_version`;
 * container images that run without npm set `APP_VERSION` explicitly. The
 * literal fallback keeps a version well-formed when neither is present.
 *
 * The version is also part of the product's own user agent: a provider that
 * sees `noema/1.4.1` knows which build is talking to it, which a bare
 * `noema` would not tell it.
 */
export function serverAppVersion(): string {
  return process.env.APP_VERSION ?? process.env.npm_package_version ?? "1.4.1";
}
