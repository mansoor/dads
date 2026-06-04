// Dependency-free inline sparkline. Renders a small filled line chart from a
// numeric series. Used on env cards for Phase 6d metrics history.
export default function Sparkline({ values, width = 90, height = 22, stroke = '#22d3ee', fill = true }) {
  const pts = (values || []).filter(v => typeof v === 'number' && !isNaN(v))
  if (pts.length < 2) {
    return <div style={{ width, height }} className="flex items-center justify-center text-[10px] text-gray-600">—</div>
  }
  const max = Math.max(...pts)
  const min = Math.min(...pts)
  const range = max - min || 1
  const stepX = width / (pts.length - 1)
  const coords = pts.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 2) - 1])
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`
  return (
    <svg width={width} height={height} className="block overflow-visible">
      {fill && <polygon points={area} fill={stroke} opacity="0.12" />}
      <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
