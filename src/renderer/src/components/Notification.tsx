import { useCallback } from 'react'
import type { JSX, ReactNode } from 'react'
import { Toast } from '@base-ui/react/toast'
import './Notification.css'

interface NotificationOptions {
  title: string
  description?: string
  type: 'success' | 'error'
}

export function useNotification(): (options: NotificationOptions) => void {
  const { add } = Toast.useToastManager()
  return useCallback((options: NotificationOptions) => {
    add({ ...options, timeout: options.type === 'error' ? 10000 : 5000,
      priority: options.type === 'error' ? 'high' : 'low' })
  }, [add])
}

// Keep the viewport inside its panel so native web content cannot cover the notifications.
export function NotificationRegion({ children }: { children: ReactNode }): JSX.Element {
  return <Toast.Provider limit={3}>
    <div className="notification-region">
      {children}
      <NotificationList />
    </div>
  </Toast.Provider>
}

function NotificationList(): JSX.Element {
  const { toasts } = Toast.useToastManager()
  return <Toast.Viewport className="notification-viewport" aria-label="通知">
    {toasts.map(toast => <Toast.Root key={toast.id} toast={toast} swipeDirection={[]} className="notification">
      <Toast.Content className="notification__content">
        <span className="notification__icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            {toast.type === 'error' ? <path d="M12 7v6m0 4h.01" /> : <path d="m8 12 3 3 5-6" />}
          </svg>
        </span>
        <div className="notification__text">
          <Toast.Title className="notification__title" />
          <Toast.Description className="notification__description" data-base-ui-swipe-ignore />
        </div>
        <Toast.Close className="notification__close" aria-label="关闭通知" title="关闭通知">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>)}
  </Toast.Viewport>
}
