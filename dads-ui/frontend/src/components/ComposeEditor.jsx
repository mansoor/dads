import { useQuery } from '@tanstack/react-query'
import { fetchCompose } from '../lib/api'

// ── Compose Viewer (read-only) ────────────────────────────────────────────────
// docker-compose.yml is a generated artefact derived from config.json.
// Editing it directly is not supported — use Edit Workspace to modify
// config.json, then Refresh (Deploy ▾ → Refresh) to regenerate.

export default function ComposeEditor({ name, env, onClose, onRefresh }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['compose', name, env],
    queryFn:  () => fetchCompose(name, env),
  })

  const content = data?.content ?? ''

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mt-16 mx-auto w-full max-w-4xl flex flex-col bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden shadow-2xl"
        style={{ maxHeight: 'calc(100vh - 80px)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-white">docker-compose.yml</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400">read-only</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{name} / {env}</p>
          </div>
          <div className="flex items-center gap-2">
            {onRefresh && (
              <button
                onClick={() => { onRefresh(); onClose() }}
                className="text-sm font-medium px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white transition-colors"
                title="Regenerate docker-compose.yml from config.json and deploy"
              >
                Refresh
              </button>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none ml-1">×</button>
          </div>
        </div>

        {/* Read-only content */}
        <div className="flex-1 overflow-auto min-h-0">
          {isLoading && <p className="p-6 text-gray-400 text-sm">Loading…</p>}
          {error     && <p className="p-6 text-red-400 text-sm">{error.message}</p>}
          {!isLoading && !error && (
            <pre className="p-5 font-mono text-sm text-gray-200 leading-relaxed whitespace-pre bg-gray-950 min-h-full">
              {content}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-gray-800 bg-gray-900/80 shrink-0">
          <p className="text-xs text-gray-500">
            Generated from <code className="font-mono text-gray-400">config.json</code>.
            Use <strong className="text-gray-400">Edit Workspace</strong> to change configuration,
            then <strong className="text-gray-400">Deploy ▾ → Refresh</strong> to regenerate.
          </p>
        </div>
      </div>
    </div>
  )
}
