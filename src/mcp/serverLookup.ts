// One place every "is there a server called X in this scope" read goes
// through, so the lookup rule lives in one function.
export function getServerByName<T>(
  servers: Readonly<Record<string, T>> | undefined,
  name: string,
): T | undefined {
  return servers?.[name]
}
