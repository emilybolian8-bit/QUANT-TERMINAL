import React, { useState, useEffect } from 'react'

interface VolumeTabProps {
  venues: string[]
}

export function VolumeTab({ venues }: VolumeTabProps) {
  const [data, setData] = useState<any[]>([])
  const [mode, setMode] = useState<'pct' | 'vol' | 'both'>('both')

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [])

  const fetchData = async () => {
    try {
      const res = await fetch('/api/v1/table/volume')
      const json = await res.json()
      setData(json.rows || [])
    } catch (e) {
      console.error(e)
    }
  }

  const formatUSD = (n: number) => {
    if (!n) return '$0'
    const abs = Math.abs(n)
    if (abs >= 1e9) return (n/1e9).toFixed(2) + 'B'
    if (abs >= 1e6) return (n/1e6).toFixed(1) + 'M'
    if (abs >= 1e3) return (n/1e3).toFixed(0) + 'K'
    return n.toFixed(0)
  }

  const formatPct = (n: number | null) => {
    if (n === null || n === undefined) return '–'
    return (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%'
  }

  return (
    <div>
      <div className="flex items-center gap-2.5 mb-2.5 text-mu">
        <span>Volume · rolling windows ending now</span>
        <div className="flex-1"></div>
        <span>Cells</span>
        <div className="flex bg-s1 border border-bd rounded-[9px] p-0.5">
          <button onClick={() => setMode('pct')} className={`px-3 py-1 rounded-[7px] ${mode === 'pct' ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu'}`}>%</button>
          <button onClick={() => setMode('vol')} className={`px-3 py-1 rounded-[7px] ${mode === 'vol' ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu'}`}>Volume</button>
          <button onClick={() => setMode('both')} className={`px-3 py-1 rounded-[7px] ${mode === 'both' ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu'}`}>Both</button>
        </div>
      </div>
      <div className="overflow-auto border border-bd rounded-xl bg-s1 max-h-[calc(100vh-290px)]">
        <table className="border-collapse w-full min-w-[980px]">
          <thead>
            <tr>
              <th className="sticky top-0 z-[4] left-0 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-left px-2.5 py-2.25 border-b border-bd">Symbol</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">Price</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">24h Volume</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">5m</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">15m</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">1h</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">4h</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">24h</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">Venue split</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">Trend</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row: any) => (
              <tr key={row.base} className="hover:bg-s2">
                <td className="sticky left-0 bg-s1 px-2.5 h-[38px] border-b border-bd/60">
                  <div className="flex items-center gap-2.25 font-semibold">
                    <span className="w-[22px] h-[22px] rounded-full grid place-items-center text-[10px] font-bold text-white" style={{background: 'hsl(200 55% 45%)'}}>{row.base[0]}</span>
                    {row.base}
                  </div>
                </td>
                <td className="text-right px-2.5 h-[38px] border-b border-bd/60">{row.price ? row.price.toLocaleString() : '-'}</td>
                <td className="text-right px-2.5 h-[38px] border-b border-bd/60 font-semibold">${formatUSD(row.volume?.total_usd_24h || 0)}</td>
                {['5m', '15m', '1h', '4h', '24h'].map(tf => (
                  <td key={tf} className="text-right px-2.5 h-[38px] border-b border-bd/60 text-mu">–</td>
                ))}
                <td className="text-right px-2.5 h-[38px] border-b border-bd/60">
                  <span className="inline-flex w-[90px] h-[7px] rounded overflow-hidden bg-bd align-middle"></span>
                </td>
                <td className="text-right px-2.5 h-[38px] border-b border-bd/60">
                  <svg width="80" height="22"><polyline points="0,18 20,15 40,12 60,10 80,8" fill="none" stroke="var(--up)" strokeWidth="1.5"/></svg>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
