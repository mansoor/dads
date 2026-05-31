import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchCompose, putCompose } from '../lib/api'

export default function ComposeEditor({ name, env, onClose }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['compose', name, env],
    queryFn: () => fetchCompose(name, env),
  })
  const [content, setContent] = useState(null) // null = not yet edited

  const mutation = useMutation({
    mutationFn: (text) => putCompose(name, env, text),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['compose', name, env] }),
  })

  const current = content ?? data?.content ?? ''

  function handleSave() {
    mutation.mutate(current)
  }

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
            <h3 className="font-semibold text-white">docker-compose.yml</h3>
            <p className="text-xs text-gray-400">{name} / {env}</p>
          </div>
          <div className="flex items-center gap-3">
            {mutation.isSuccess && <span className="text-green-400 text-sm">Saved ✓</span>}
            {mutation.isError  && <span className="text-red-400 text-sm">Save failed</span>}
            <button
              onClick={handleSave}
              disabled={mutation.isPending || content === null}
              className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none ml-1">×</button>
          </div>
        </div>

        {/* Editor area */}
        <div className="flex-1 overflow-hidden">
          {isLoading && <p className="p-6 text-gray-400 text-sm">Loading…</p>}
          {error   && <p className="p-6 text-red-400 text-sm">{error.message}</p>}
          {!isLoading && !error && (
            <textarea
              value={current}
              onChange={e => setContent(e.target.value)}
              spellCheck={false}
              className="w-full h-full bg-gray-950 text-gray-100 font-mono text-sm p-5 resize-none focus:outline-none leading-relaxed"
              style={{ minHeight: '500px' }}
            />
          )}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-2.5 border-t border-gray-800 bg-gray-900/80 shrink-0">
          <p className="text-xs text-gray-500">
            After saving, run <span className="font-mono text-gray-400">Refresh</span> to regenerate from config.json, or <span className="font-mono text-gray-400">Deploy</span> to apply changes directly.
          </p>
        </div>
      </div>
    </div>
  )
}
