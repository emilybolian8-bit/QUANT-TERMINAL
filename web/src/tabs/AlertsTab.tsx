import React, { useState } from 'react'

export function AlertsTab() {
  const [rules, setRules] = useState([
    {id: 1, name: 'Volume surge 80% / 15m', metric: 'volume', tf: '15m', condition: 'up', threshold_pct: 80, enabled: true}
  ])
  const [form, setForm] = useState({
    name: '', metric: 'volume', tf: '15m', condition: 'up', threshold_pct: 80, minVol: 1, cooldown: 900
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const newRule = { ...form, id: Date.now(), enabled: true }
    setRules([...rules, newRule])
    setForm({ name: '', metric: 'volume', tf: '15m', condition: 'up', threshold_pct: 80, minVol: 1, cooldown: 900 })
  }

  return (
    <div className="grid grid-cols-[340px_1fr] gap-3.5 max-md:grid-cols-1">
      <div className="bg-s1 border border-bd rounded-xl p-3.5">
        <b className="text-base">Create alert rule</b>
        <form onSubmit={handleSubmit} className="mt-3">
          <label className="block text-mu text-[11px] mt-2.5 mb-0.75 uppercase tracking-wider">Name</label>
          <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full bg-s1 border border-bd rounded-lg px-2.5 py-1.5 outline-none focus:border-ac" placeholder="e.g. Volume surge" />
          <label className="block text-mu text-[11px] mt-2.5 mb-0.75 uppercase tracking-wider">Metric</label>
          <select value={form.metric} onChange={e => setForm({...form, metric: e.target.value})} className="w-full bg-s1 border border-bd rounded-lg px-2.5 py-1.5 outline-none focus:border-ac">
            <option value="volume">Volume</option>
            <option value="oi">Open interest</option>
          </select>
          <label className="block text-mu text-[11px] mt-2.5 mb-0.75 uppercase tracking-wider">Timeframe</label>
          <select value={form.tf} onChange={e => setForm({...form, tf: e.target.value})} className="w-full bg-s1 border border-bd rounded-lg px-2.5 py-1.5 outline-none focus:border-ac">
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
            <option value="24h">24h</option>
          </select>
          <label className="block text-mu text-[11px] mt-2.5 mb-0.75 uppercase tracking-wider">Condition</label>
          <select value={form.condition} onChange={e => setForm({...form, condition: e.target.value})} className="w-full bg-s1 border border-bd rounded-lg px-2.5 py-1.5 outline-none focus:border-ac">
            <option value="up">Increases by ≥</option>
            <option value="down">Decreases by ≥</option>
            <option value="abs">Moves ±</option>
          </select>
          <label className="block text-mu text-[11px] mt-2.5 mb-0.75 uppercase tracking-wider">Threshold (%)</label>
          <input type="number" value={form.threshold_pct} onChange={e => setForm({...form, threshold_pct: +e.target.value})} className="w-full bg-s1 border border-bd rounded-lg px-2.5 py-1.5 outline-none focus:border-ac" />
          <label className="block text-mu text-[11px] mt-2.5 mb-0.75 uppercase tracking-wider">Min 24h volume (USD M)</label>
          <input type="number" value={form.minVol} onChange={e => setForm({...form, minVol: +e.target.value})} className="w-full bg-s1 border border-bd rounded-lg px-2.5 py-1.5 outline-none focus:border-ac" />
          <label className="block text-mu text-[11px] mt-2.5 mb-0.75 uppercase tracking-wider">Cooldown per coin (s)</label>
          <input type="number" value={form.cooldown} onChange={e => setForm({...form, cooldown: +e.target.value})} className="w-full bg-s1 border border-bd rounded-lg px-2.5 py-1.5 outline-none focus:border-ac" />
          <button type="submit" className="w-full bg-ac text-white rounded-lg px-3.5 py-2 font-semibold mt-3.5">Add rule</button>
        </form>
      </div>
      <div>
        <div className="bg-s1 border border-bd rounded-xl p-3.5 mb-3.5">
          <b className="text-base">My rules</b>
          <div className="mt-2">
            {rules.map(rule => (
              <div key={rule.id} className="flex items-center gap-2.5 py-2.25 border-b border-bd last:border-0">
                <button className={`w-[34px] h-[19px] rounded-[10px] relative border-0 p-0 ${rule.enabled ? 'bg-up' : 'bg-bd'}`}>
                  <span className={`absolute top-0.5 w-[15px] h-[15px] rounded-full bg-white transition-all ${rule.enabled ? 'left-[17px]' : 'left-0.5'}`}></span>
                </button>
                <div className="flex-1">
                  <b>{rule.name}</b>
                  <small className="block text-mu">{rule.metric} {rule.condition === 'up' ? 'increases by ≥' : 'decreases by ≥'} {rule.threshold_pct}% in {rule.tf} · cooldown {form.cooldown}s</small>
                </div>
                <button className="bg-none border-0 text-mu hover:text-dn">✕</button>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-s1 border border-bd rounded-xl p-3.5">
          <b className="text-base">Fired history</b>
          <div className="text-center text-mu py-5">Nothing fired yet — alerts will appear here when triggered.</div>
        </div>
      </div>
    </div>
  )
}
