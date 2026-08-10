/** Cast node:sqlite row results to typed records. */
export function asRow<T>(row: unknown): T {
  return row as T;
}

export function asRows<T>(rows: unknown): T[] {
  return rows as T[];
}
