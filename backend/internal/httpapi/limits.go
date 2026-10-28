package httpapi

import (
	"net"
	"sync"
	"time"
)

type loginWindow struct {
	until time.Time
	count int
}
type loginLimits struct {
	mu      sync.Mutex
	windows map[string]loginWindow
}

func newLoginLimits() *loginLimits { return &loginLimits{windows: make(map[string]loginWindow)} }

// Do not trust a caller-supplied X-Forwarded-For header. A reverse proxy may
// therefore share this quota until explicit trusted-proxy support is configured.
func (l *loginLimits) allow(remote, kind string, maximum int) bool {
	ip, _, err := net.SplitHostPort(remote)
	if err != nil {
		ip = remote
	}
	key, now := kind+":"+ip, time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	w := l.windows[key]
	if !now.Before(w.until) {
		if len(l.windows) >= 4096 {
			for k, v := range l.windows {
				if !now.Before(v.until) {
					delete(l.windows, k)
				}
			}
			if len(l.windows) >= 4096 {
				return false
			}
		}
		w = loginWindow{until: now.Add(10 * time.Minute)}
	}
	if w.count >= maximum {
		return false
	}
	w.count++
	l.windows[key] = w
	return true
}
