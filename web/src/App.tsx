import React, { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom'
import { OITab } from './tabs/OITab'
import { VolumeTab } from './tabs/VolumeTab'
import { AlertsTab } from './tabs/AlertsTab'
import { ToastContainer } from './components/ToastContainer'
import { useStore } from './store/useStore'

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [venues, setVenues] = useState(['binance', 'bybit', 'okx', 'hyperliquid'])
  const { unseenAlerts, setUnseenAlerts } = useStore()

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const toggleVenue = (venue: string) => {
    if (venues.includes(venue) && venues.length > 1) {
      setVenues(venues.filter(v => v !== venue))
    } else if (!venues.includes(venue)) {
      setVenues([...venues, venue])
    }
  }

  const venueConfig = {
    binance: { name: 'Binance', color: '#f0b90b' },
    bybit: { name: 'Bybit', color: '#f7a600' },
    okx: { name: 'OKX', color: '#9aa4b8' },
    hyperliquid: { name: 'Hyperliquid', color: '#4be3c1' }
  }

  return (
    <Router>
      <div className="min-h-screen">
        <header className="sticky top-0 z-20 flex items-center gap-3 px-5 py-2.5 bg-bg/82 backdrop-blur-[14px] border-b border-bd flex-wrap">
          <div className="font-bold tracking-wide text-[15px]">◆ Flow<span className="text-ac">Desk</span></div>
          <nav className="flex gap-0.5 bg-s1 border border-bd rounded-[10px] p-[3px]">
            <NavLink to="/" className={({isActive}) => `px-3.5 py-1.5 rounded-[7px] ${isActive ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu hover:text-tx'}`}>
              Open Interest
            </NavLink>
            <NavLink to="/volume" className={({isActive}) => `px-3.5 py-1.5 rounded-[7px] ${isActive ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu hover:text-tx'}`}>
              Volume
            </NavLink>
            <NavLink to="/alerts" className={({isActive}) => `px-3.5 py-1.5 rounded-[7px] relative ${isActive ? 'bg-s2 text-tx shadow-[0_0_0_1px_var(--bd)]' : 'text-mu hover:text-tx'}`}>
              Alerts
              {unseenAlerts > 0 && <span className="absolute -top-1 -right-1 bg-dn text-white rounded-full text-[10px] px-1.5 min-w-[16px] text-center">{unseenAlerts}</span>}
            </NavLink>
          </nav>
          <div className="flex-1"></div>
          <input className="w-[180px] bg-s1 border border-bd rounded-lg px-2.5 py-1.5 outline-none focus:border-ac" placeholder="Search symbol  ( / )" />
          <div className="flex gap-1.5">
            {Object.entries(venueConfig).map(([id, cfg]) => (
              <button 
                key={id}
                onClick={() => toggleVenue(id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 border rounded-full text-xs transition-colors ${venues.includes(id) ? 'bg-s1 border-bd text-tx' : 'bg-s1/50 border-bd/50 text-mu'}`}
              >
                <i className="w-1.5 h-1.5 rounded-full" style={{backgroundColor: cfg.color, opacity: venues.includes(id) ? 1 : 0.35}}></i>
                {cfg.name}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-mu text-xs"><i className="w-1.5 h-1.5 rounded-full bg-up shadow-[0_0_8px_var(--up)] animate-pulse"></i><span>Live · updated 3s ago</span></div>
          <button className="bg-s1 border border-bd rounded-lg px-2.5 py-1 relative">🔔</button>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="bg-s1 border border-bd rounded-lg px-2.5 py-1">◐</button>
        </header>
        <main className="max-w-[1500px] mx-auto px-5 py-[18px] pb-[60px]">
          <Routes>
            <Route path="/" element={<OITab venues={venues} />} />
            <Route path="/volume" element={<VolumeTab venues={venues} />} />
            <Route path="/alerts" element={<AlertsTab />} />
          </Routes>
        </main>
        <ToastContainer />
      </div>
    </Router>
  )
}

export default App
