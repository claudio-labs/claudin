// One place every "is there a server called X in this scope" read goes
// through. Own keys only: a server name like `constructor` or `toString`
// must not resolve to what Object.prototype carries under it.
export function getServerByName<T>(
  servers: Readonly<Record<string, T>> | undefined,
  name: string,
): T | undefined {
  return servers && Object.hasOwn(servers, name) ? servers[name] : undefined
}
