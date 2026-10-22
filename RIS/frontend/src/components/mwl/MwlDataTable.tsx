import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronLeft, ChevronRight, Columns3, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export type MwlTableColumn<T> = {
  key: string;
  label: string;
  width?: string;
  render: (row: T) => ReactNode;
  value?: (row: T) => string | number | null | undefined;
};

type MwlDataTableProps<T> = {
  storageKey: string;
  columns: MwlTableColumn<T>[];
  rows: T[];
  loading?: boolean;
  emptyMessage: string;
  searchValue: string;
  searchPlaceholder?: string;
  onSearchChange: (value: string) => void;
  toolbar?: ReactNode;
  onRowDoubleClick?: (row: T) => void;
  getRowKey: (row: T) => string | number;
  enablePagination?: boolean;
  initialPageSize?: number;
  pageSizeOptions?: number[];
};

const loadStoredOrder = (key: string, fallback: string[]) => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(`${key}:order`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : fallback;
  } catch {
    return fallback;
  }
};

const loadStoredVisible = (key: string, fallback: string[]) => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(`${key}:visible`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : fallback;
  } catch {
    return fallback;
  }
};

export function MwlDataTable<T>({
  storageKey,
  columns,
  rows,
  loading = false,
  emptyMessage,
  searchValue,
  searchPlaceholder = "Search data...",
  onSearchChange,
  toolbar,
  onRowDoubleClick,
  getRowKey,
  enablePagination = false,
  initialPageSize = 25,
  pageSizeOptions = [25, 50, 100],
}: MwlDataTableProps<T>) {
  const defaultOrder = useMemo(() => columns.map(column => column.key), [columns]);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => loadStoredOrder(storageKey, defaultOrder));
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => loadStoredVisible(storageKey, defaultOrder));
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(0);
  const deferredSearchValue = useDeferredValue(searchValue);
  const paginationEnabled = enablePagination || rows.length > 250;

  useEffect(() => {
    const validKeys = new Set(columns.map(column => column.key));
    setColumnOrder(prev => {
      const filtered = prev.filter(key => validKeys.has(key));
      const missing = columns.map(column => column.key).filter(key => !filtered.includes(key));
      return [...filtered, ...missing];
    });
    setVisibleColumns(prev => {
      const filtered = prev.filter(key => validKeys.has(key));
      return filtered.length ? filtered : columns.map(column => column.key);
    });
  }, [columns]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`${storageKey}:order`, JSON.stringify(columnOrder));
    }
  }, [columnOrder, storageKey]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`${storageKey}:visible`, JSON.stringify(visibleColumns));
    }
  }, [visibleColumns, storageKey]);

  const columnMap = useMemo(() => new Map(columns.map(column => [column.key, column])), [columns]);
  const orderedColumns = useMemo(
    () => columnOrder.map(key => columnMap.get(key)).filter(Boolean) as MwlTableColumn<T>[],
    [columnMap, columnOrder]
  );
  const activeColumns = useMemo(
    () => orderedColumns.filter(column => visibleColumns.includes(column.key)),
    [orderedColumns, visibleColumns]
  );

  const filteredRows = useMemo(() => {
    const query = deferredSearchValue.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(row =>
      columns.some(column => {
        const raw = column.value ? column.value(row) : column.render(row);
        return String(raw ?? "")
          .toLowerCase()
          .includes(query);
      })
    );
  }, [columns, rows, deferredSearchValue]);

  useEffect(() => {
    setPage(0);
  }, [rows, deferredSearchValue, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

  useEffect(() => {
    if (page >= totalPages) {
      setPage(Math.max(0, totalPages - 1));
    }
  }, [page, totalPages]);

  const visibleRows = useMemo(() => {
    if (!paginationEnabled) return filteredRows;
    const start = page * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [paginationEnabled, filteredRows, page, pageSize]);

  const moveColumn = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setColumnOrder(prev => {
      const next = [...prev];
      const fromIndex = next.indexOf(fromKey);
      const toIndex = next.indexOf(toKey);
      if (fromIndex === -1 || toIndex === -1) return prev;
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, fromKey);
      return next;
    });
  };

  return (
    <div className="technologist-worklist-shell space-y-4">
      <div className="technologist-worklist-toolbar flex flex-wrap items-center justify-between gap-3">
        <Input
          value={searchValue}
          onChange={event => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="w-full max-w-sm rounded-xl"
        />
        <div className="flex items-center gap-2">
          {toolbar}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="rounded-xl">
                <Columns3 className="mr-2 h-4 w-4" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 overflow-y-auto">
              {orderedColumns.map(column => (
                <DropdownMenuCheckboxItem
                  key={column.key}
                  checked={visibleColumns.includes(column.key)}
                  onCheckedChange={checked => {
                    setVisibleColumns(prev =>
                      checked ? [...prev, column.key] : prev.filter(key => key !== column.key)
                    );
                  }}
                >
                  {column.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="overflow-hidden border-0 bg-transparent">
        <div className="w-full overflow-x-auto">
          <Table className="min-w-max select-text">
            <TableHeader className="radiology-tech-table-header">
              <TableRow>
                {activeColumns.map(column => (
                  <TableHead
                    key={column.key}
                    draggable
                    onDragStart={() => setDraggingKey(column.key)}
                    onDragOver={event => event.preventDefault()}
                    onDrop={() => {
                      if (draggingKey) moveColumn(draggingKey, column.key);
                      setDraggingKey(null);
                    }}
                    className="select-none whitespace-nowrap"
                    style={column.width ? { width: column.width, minWidth: column.width } : undefined}
                  >
                    <div className="flex items-center gap-2">
                      <GripVertical className="h-4 w-4 text-muted-foreground" />
                      <span>{column.label}</span>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={Math.max(activeColumns.length, 1)} className="h-24 text-center">
                    Loading data...
                  </TableCell>
                </TableRow>
              ) : filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={Math.max(activeColumns.length, 1)} className="h-24 text-center">
                    {emptyMessage}
                  </TableCell>
                </TableRow>
              ) : (
                visibleRows.map(row => (
                  <TableRow
                    key={getRowKey(row)}
                    className={cn(onRowDoubleClick && "cursor-pointer")}
                    onDoubleClick={() => onRowDoubleClick?.(row)}
                  >
                    {activeColumns.map(column => (
                      <TableCell key={column.key} className="align-top">
                        <div className="whitespace-nowrap">
                        {column.render(row)}
                        </div>
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {paginationEnabled && (
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div>{filteredRows.length} total</div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <div className="flex items-center gap-2">
              <span>Rows</span>
              <Select value={String(pageSize)} onValueChange={value => setPageSize(Number(value))}>
                <SelectTrigger className="h-9 w-[92px] rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {pageSizeOptions.map(option => (
                    <SelectItem key={option} value={String(option)}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <span>
                Page {Math.min(page + 1, totalPages)} / {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 rounded-xl"
                  onClick={() => setPage(prev => Math.max(0, prev - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 rounded-xl"
                  onClick={() => setPage(prev => Math.min(totalPages - 1, prev + 1))}
                  disabled={page >= totalPages - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
