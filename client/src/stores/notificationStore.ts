import { create } from 'zustand'

export type NotificationKind = 'info' | 'success' | 'warning' | 'error'
export type NotificationActionVariant = 'red' | 'green' | 'neutral'

export interface NotificationAction {
  text: string
  variant: NotificationActionVariant
  onClick?: () => void
  dismiss?: boolean
}

export interface NotificationItem {
  id: string
  kind: NotificationKind
  title: string
  description?: string
  actions?: NotificationAction[]
  createdAt: number
  dismissAfterMs: number
}

interface NotificationState {
  items: NotificationItem[]
  push: (n: Omit<NotificationItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) => string
  dismiss: (id: string) => void
  clear: () => void
}

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  items: [],
  push: (n) => {
    const id = n.id ?? uid()
    const createdAt = n.createdAt ?? Date.now()
    const actions = (n.actions ?? []).slice(0, 3)
    set((s) => ({
      items: [
        { ...n, id, createdAt, actions },
        ...s.items,
      ].slice(0, 5),
    }))
    return id
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
  clear: () => set({ items: [] }),
}))

export function notify(input: {
  kind: NotificationKind
  title: string
  description?: string
  actions?: NotificationAction[]
  dismissAfterMs?: number
}): string {
  return useNotificationStore.getState().push({
    kind: input.kind,
    title: input.title,
    description: input.description,
    actions: input.actions,
    dismissAfterMs: input.dismissAfterMs ?? 3000,
  })
}

