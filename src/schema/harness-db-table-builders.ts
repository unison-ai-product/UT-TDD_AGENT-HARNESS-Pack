import type { CheckExpression, ColumnReference, ColumnType, ForeignKeyDef } from "./harness-db.ts";

export const col = (name: string, type: ColumnType = "TEXT") => ({ name, type });
export const pk = (name: string) => ({ name, type: "TEXT" as const, primaryKey: true });

export const requiredCol = (name: string, type: ColumnType = "TEXT") => ({
  name,
  type,
  notNull: true,
});

export const reference = (name: string, target: ColumnReference, type: ColumnType = "TEXT") => ({
  name,
  type,
  references: target,
});

export const foreignKey = (
  columns: readonly string[],
  target: {
    table: string;
    columns: readonly string[];
    onDelete?: ForeignKeyDef["onDelete"];
    onUpdate?: ForeignKeyDef["onUpdate"];
  },
): ForeignKeyDef => ({
  columns,
  referencedTable: target.table,
  referencedColumns: target.columns,
  ...(target.onDelete ? { onDelete: target.onDelete } : {}),
  ...(target.onUpdate ? { onUpdate: target.onUpdate } : {}),
});

export const enumCheck = (column: string, values: readonly string[]): CheckExpression => ({
  kind: "in",
  column,
  values,
});
