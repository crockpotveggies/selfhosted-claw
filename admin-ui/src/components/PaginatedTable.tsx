import { useState } from 'react';
import {
  CFormSelect,
  CPagination,
  CPaginationItem,
} from '@coreui/react';

interface PaginatedTableProps<T> {
  items: T[];
  defaultPageSize?: number;
  pageSizeOptions?: number[];
  renderTable: (pageItems: T[]) => React.ReactNode;
}

export function PaginatedTable<T>({
  items,
  defaultPageSize = 50,
  pageSizeOptions = [10, 25, 50, 100],
  renderTable,
}: PaginatedTableProps<T>) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(0);
  };

  // Build page number range (show max 5 pages around current)
  const pageNumbers: number[] = [];
  const maxVisible = 5;
  let rangeStart = Math.max(0, safePage - Math.floor(maxVisible / 2));
  const rangeEnd = Math.min(totalPages, rangeStart + maxVisible);
  if (rangeEnd - rangeStart < maxVisible) {
    rangeStart = Math.max(0, rangeEnd - maxVisible);
  }
  for (let i = rangeStart; i < rangeEnd; i++) {
    pageNumbers.push(i);
  }

  return (
    <div>
      {renderTable(pageItems)}

      {items.length > pageSizeOptions[0] && (
        <div className="d-flex justify-content-between align-items-center px-3 py-2 border-top">
          <div className="d-flex align-items-center gap-2">
            <span className="small text-body-secondary">Show</span>
            <CFormSelect
              size="sm"
              style={{ width: 75 }}
              value={pageSize}
              onChange={(e) =>
                handlePageSizeChange(Number(e.target.value))
              }
            >
              {pageSizeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </CFormSelect>
            <span className="small text-body-secondary">
              of {items.length} total
            </span>
          </div>

          {totalPages > 1 && (
            <CPagination size="sm" className="mb-0">
              <CPaginationItem
                disabled={safePage === 0}
                onClick={() => setPage(0)}
                aria-label="First"
              >
                &laquo;
              </CPaginationItem>
              <CPaginationItem
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
                aria-label="Previous"
              >
                &lsaquo;
              </CPaginationItem>
              {pageNumbers.map((p) => (
                <CPaginationItem
                  key={p}
                  active={p === safePage}
                  onClick={() => setPage(p)}
                >
                  {p + 1}
                </CPaginationItem>
              ))}
              <CPaginationItem
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage(safePage + 1)}
                aria-label="Next"
              >
                &rsaquo;
              </CPaginationItem>
              <CPaginationItem
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage(totalPages - 1)}
                aria-label="Last"
              >
                &raquo;
              </CPaginationItem>
            </CPagination>
          )}
        </div>
      )}
    </div>
  );
}
