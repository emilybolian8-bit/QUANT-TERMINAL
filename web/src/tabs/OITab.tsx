import React, { useState, useEffect } from 'react'

interface OITabProps {
  venues: string[]
}

export function OITab({ venues }: OITabProps) {
  const [data, setData] = useState<any[]>([])
  const [mode, setMode] = useState<'pct' | 'usd' | 'both'>('pct')
  const [sort, setSort] = useState({ key: 'total', dir: -1 })
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [])

  const fetchData = async () => {
    try {
      const res = await fetch('/api/v1/table/oi')
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
        <span>Open interest · rolling windows ending now · click a row for venue breakdown</span>
        <div className="flex-1"></div>
        <span>Cells</span>
        <div className="flex bg-s1 border border-bd rounded-[9px] p-0.5">
          <button onClick={() => setMode('pct')} className={`px-3 py-1 rounded-[7px] ${mode === 'pct' ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu'}`}>%</button>
          <button onClick={() => setMode('usd')} className={`px-3 py-1 rounded-[7px] ${mode === 'usd' ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu'}`}>USD Δ</button>
          <button onClick={() => setMode('both')} className={`px-3 py-1 rounded-[7px] ${mode === 'both' ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu'}`}>Both</button>
        </div>
      </div>
      <div className="overflow-auto border border-bd rounded-xl bg-s1 max-h-[calc(100vh-290px)]">
        <table className="border-collapse w-full min-w-[980px]">
          <thead>
            <tr>
              <th className="sticky top-0 z-[4] left-0 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-left px-2.5 py-2.25 border-b border-bd">Symbol</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">Price</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">Open Interest</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd cursor-pointer">5m</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd cursor-pointer">15m</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd cursor-pointer">1h</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd cursor-pointer">4h</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd cursor-pointer">24h</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">Venue split</th>
              <th className="sticky top-0 z-3 bg-s2 text-mu font-medium text-[11px] uppercase tracking-wider text-right px-2.5 py-2.25 border-b border-bd">24h trend</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row: any) => (
              <React.Fragment key={row.base}>
                <tr className="cursor-pointer hover:bg-s2" onClick={() => {
                  const newSet = new Set(openRows)
                  if (newSet.has(row.base)) newSet.delete(row.base)
                  else newSet.add(row.base)
                  setOpenRows(newSet)
                }}>
                  <td className="sticky left-0 bg-s1 px-2.5 h-[38px] border-b border-bd/60">
                    <div className="flex items-center gap-2.25 font-semibold">
                      <span className="w-[22px] h-[22px] rounded-full grid place-items-center text-[10px] font-bold text-white" style={{background: 'hsl(200 55% 45%)'}}>{row.base[0]}</span>
                      {row.base}
                      <em className="not-italic font-normal text-mu text-[11px]">{row.venues?.length || 0}/4</em>
                    </div>
                  </td>
                  <td className="text-right px-2.5 h-[38px] border-b border-bd/60">{row.price ? (row.price < 1 ? row.price.toFixed(4) : row.price.toLocaleString()) : '-'}</td>
                  <td className="text-right px-2.5 h-[38px] border-b border-bd/60 font-semibold">${formatUSD(row.oi?.total_usd || 0)}</td>
                  {['5m', '15m', '1h', '4h', '24h'].map(tf => {
                    const tfData = row.oi?.tf?.[tf]
                    if (!tfData || tfData.pct === null) return <td key={tf} className="text-right px-2.5 h-[38px] border-b border-bd/60 text-mu">–</td>
                    const pct = tfData.pct
                    const usd = tfData.usd
                    return (
                      <td key={tf} className={`text-right px-2.5 h-[38px] border-b border-bd/60 font-medium ${pct >= 0 ? 'text-up' : 'text-dn'}`} style={{background: `rgba(${pct >= 0 ? '46,204,143' : '255,92,108'}, ${Math.min(Math.abs(pct)/0.2, 1)*0.4})`}}>
                        <span className="block leading-tight">
                          {mode === 'usd' ? (usd >= 0 ? '+' : '') + '$' + formatUSD(Math.abs(usd)) : 
                           mode === 'both' ? (pct >= 0 ? '+' : '') + (pct*100).toFixed(2) + '%' : 
                           (pct >= 0 ? '+' : '') + (pct*100).toFixed(2) + '%'}
                        </span>
                        {mode === 'both' && <small className="block text-[10.5px] opacity-75 leading-tight">{(usd >= 0 ? '+' : '') + '$' + formatUSD(Math.abs(usd))}</small>}
                      </td>
                    )
                  })}
                  <td className="text-right px-2.5 h-[38px] border-b border-bd/60">
                    <span className="inline-flex w-[90px] h-[7px] rounded overflow-hidden bg-bd align-middle">
                      {row.venues?.map((v: string, i: number) => (
                        <i key={v} className="block h-full" style={{backgroundColor: v === 'binance' ? '#f0b90b' : v === 'bybit' ? '#f7a600' : v === 'okx' ? '#9aa4b8' : '#4be3c1', width: `${100/row.venues.length}%`}}></i>
                      ))}
                    </span>
                  </td>
                  <td className="text-right px-2.5 h-[38px] border-b border-bd/60">
                    <svg width="80" height="22">
                      <polyline points="0,15 20,12 40,10 60,8 80,5" fill="none" stroke="var(--up)" strokeWidth="1.5"/>
                    </svg>
                  </td>
                </tr>
                {openRows.has(row.base) && (
                  <tr className="bg-s2">
                    <td colSpan={10} className="p-2.5 px-3.5">
                      <div className="grid grid-cols-4 gap-2.5">
                        {row.venues?.map((v: string) => (
                          <div key={v} className="border border-bd rounded-[9px] p-2 px-2.5 text-left">
                            <b className="flex items-center gap-1.5">
                              <i className="w-2 h-2 rounded-full" style={{backgroundColor: v === 'binance' ? '#f0b90b' : v === 'bybit' ? '#f7a600' : v === 'okx' ? '#9aa4b8' : '#4be3c1'}}></i>
                              {v} · ${formatUSD(row.oi?.venues?.[v] || 0)}
                            </b>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
