import { create } from 'zustand'

interface Toast {
  id: string
  type: 'up' | 'dn'
  base: string
  metric: string
  tf: string
  pct: number
  ruleName: string
  detail: string
}

interface Store {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
  unseenAlerts: number
  setUnseenAlerts: (n: number) => void
}

export const useStore = create<Store>((set) => ({
  toasts: [],
  addToast: (toast) => set((state) => ({
    toasts: [...state.toasts, { ...toast, id: Date.now().toString() + Math.random() }]
  })),
  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter(t => t.id !== id)
  })),
  unseenAlerts: 0,
  setUnseenAlerts: (n) => set({ unseenAlerts: n })
}))
