'use client'
import { useEffect, useState } from 'react'
import { api } from '../lib'

interface HistoryPage<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

export function useAccountHistory<T>(
  kind: 'orders' | 'ledger',
  enabled: boolean,
  search = '',
  status = 'all',
) {
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const query = new URLSearchParams({
    kind,
    page: String(page),
    search: search.trim(),
    status,
  }).toString()
  const [result, setResult] = useState<{
    query: string
    data?: HistoryPage<T>
    error?: string
  } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    setResult(null)
    const timer = setTimeout(
      () => {
        void api<HistoryPage<T>>(`/account/history?${query}`).then(
          (data) => {
            if (active) setResult({ query, data })
          },
          (error: Error) => {
            if (active) setResult({ query, error: error.message })
          },
        )
      },
      search.trim() ? 200 : 0,
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [enabled, query, revision, search])
  const current = result?.query === query ? result : null
  return {
    rows: current?.data?.rows ?? [],
    total: current?.data?.total ?? 0,
    page: current?.data?.page ?? page,
    loading: enabled && !current,
    error: current?.error,
    setPage,
    retry: () => setRevision((value) => value + 1),
  }
}
