import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import App from './App'
import { CatalogPage } from '#catalog/CatalogPage'
import { ErrorBoundary } from '#components/ErrorBoundary'
import './index.css'

// Queries are refreshed by explicit invalidation after the writes that
// change them, so React Query never refetches on its own.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: Infinity,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        {/* `?catalog` shows the component catalog instead of the app. */}
        {new URLSearchParams(window.location.search).has('catalog') ? <CatalogPage /> : <App />}
      </ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
)
