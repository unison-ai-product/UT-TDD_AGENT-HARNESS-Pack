export const col = (name: string, type: "TEXT" | "INTEGER" | "REAL" = "TEXT") => ({ name, type });
export const pk = (name: string) => ({ name, type: "TEXT" as const, primaryKey: true });
