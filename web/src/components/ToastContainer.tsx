import React, { useEffect } from 'react'
import { useStore } from '../store/useStore'

export function ToastContainer() {
  const { toasts, removeToast } = useStore()

  return (
    <div id="toasts" className="fixed top-[68px] right-4 z-[100] w-[330px] max-h-[calc(100vh-90px)] overflow-y-auto flex flex-col gap-2.5 pointer-events-none p-1" style={{
      scrollbarWidth: 'none',
      WebkitMaskImage: 'linear-gradient(#000 calc(100% - 22px), transparent)',
      maskImage: 'linear-gradient(#000 calc(100% - 22px), transparent)'
    }}>
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

function ToastCard({ toast, onClose }: { toast: any, onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 10000)
    return () => clearTimeout(timer)
  }, [onClose])

  return (
    <div className={`pointer-events-auto relative flex-none rounded-[20px] p-3 px-3.5 pb-3.5 overflow-hidden text-white cursor-pointer animate-[in_0.32s_cubic-bezier(0.2,1.1,0.3,1)_both]`}
         style={{
           background: 'linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.05))',
           backdropFilter: 'blur(24px) saturate(180%) brightness(1.05)',
           WebkitBackdropFilter: 'blur(24px) saturate(180%) brightness(1.05)',
           border: '1px solid rgba(255,255,255,0.2)',
           boxShadow: toast.type === 'up' 
             ? '0 12px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(46,204,143,0.35), 0 0 28px rgba(46,204,143,0.15)'
             : '0 12px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(255,92,108,0.4), 0 0 28px rgba(255,92,108,0.15)',
           textShadow: '0 1px 2px rgba(0,0,0,0.3)'
         }}>
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(120% 80% at 0 0, rgba(255,255,255,0.25), transparent 55%)',
        mixBlendMode: 'soft-light'
      }}></div>
      <div className="relative z-10">
        <div className="flex items-center gap-1.5">
          <b className="flex items-center gap-1.5 flex-1 text-sm">
            <span className="w-[22px] h-[22px] rounded-full grid place-items-center text-[10px] font-bold text-white" style={{background: 'hsl(200 55% 45%)'}}>{toast.base[0]}</span>
            {toast.base}
          </b>
          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/18 font-semibold">{toast.metric}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/18 font-semibold">{toast.tf}</span>
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="bg-none border-0 opacity-70 text-sm">✕</button>
        </div>
        <div className={`text-[30px] font-bold mt-1 -tracking-[0.5px] ${toast.type === 'up' ? 'text-[#5df2b0]' : 'text-[#ff8b97]'}`}>
          {toast.pct >= 0 ? '+' : ''}{(toast.pct * 100).toFixed(2)}%
        </div>
        <div className="text-xs opacity-90">{toast.detail}</div>
        <div className="flex justify-between items-center text-[11px] opacity-75 mt-1.5">
          <span>{toast.ruleName} · {new Date().toLocaleTimeString()}</span>
        </div>
      </div>
      <div className="absolute left-0 bottom-0 h-[3px] w-full bg-gradient-to-r from-white/80 to-white/40 origin-left animate-[sh_10s_linear_forwards]" style={{animationPlayState: 'running'}} onMouseEnter={(e) => e.currentTarget.style.animationPlayState = 'paused'} onMouseLeave={(e) => e.currentTarget.style.animationPlayState = 'running'}></div>
    </div>
  )
}
