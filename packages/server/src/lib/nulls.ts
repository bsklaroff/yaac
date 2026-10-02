type NullableKeys<T> = { [K in keyof T]: null extends T[K] ? K : never }[keyof T]

/** A row with its nullable columns as optional fields. */
export type NullsToUndefined<T> = {
  [K in Exclude<keyof T, NullableKeys<T>>]: T[K]
} & {
  [K in NullableKeys<T>]?: Exclude<T[K], null>
}

/**
 * Drop a row's null columns, so an unset column reads as an absent field the
 * way the wire types expect.
 */
export function nullsToUndefined<T extends object>(row: T): NullsToUndefined<T> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)) as NullsToUndefined<T>
}
