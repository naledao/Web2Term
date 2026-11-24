// Package feedbacknotify emails enabled administrators when a user submits feedback.
package feedbacknotify

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"web2term/backend/internal/store"
)

type Store interface {
	UserByID(context.Context, int64) (store.User, error)
	AdminEmails(context.Context) ([]string, error)
}

type Sender interface {
	Send(ctx context.Context, to, subject, body string) error
}

type Notifier struct {
	store  Store
	sender Sender
}

func New(database Store, sender Sender) *Notifier {
	return &Notifier{store: database, sender: sender}
}

var categoryLabels = map[string]string{"bug": "Bug / 问题", "feature": "新功能建议", "improvement": "体验优化", "other": "其他"}

// Feedback times are shown in China Standard Time; a fixed zone needs no tzdata on the server.
var displayZone = time.FixedZone("UTC+8", 8*60*60)

// Notify sends one message per administrator so recipients do not see each other.
// It returns how many administrators were addressed and every delivery error, joined.
func (n *Notifier) Notify(ctx context.Context, userID int64, item store.Feedback) (int, error) {
	admins, err := n.store.AdminEmails(ctx)
	if err != nil || len(admins) == 0 {
		return 0, err
	}
	account, accountEmail := "", ""
	if user, err := n.store.UserByID(ctx, userID); err == nil {
		account, accountEmail = user.Email, user.Email
		if user.Nickname != "" && user.Nickname != user.Email {
			account += "（" + user.Nickname + "）"
		}
	}
	subject, body := message(item, account, accountEmail)
	var failures []error
	for _, to := range admins {
		if err := n.sender.Send(ctx, to, subject, body); err != nil {
			failures = append(failures, err)
		}
	}
	return len(admins), errors.Join(failures...)
}

func message(item store.Feedback, account, accountEmail string) (string, string) {
	label := categoryLabels[item.Category]
	if label == "" {
		label = item.Category
	}
	subject := fmt.Sprintf("Web2Term 新反馈 #%d：%s", item.ID, label)
	var b strings.Builder
	b.WriteString("收到一条新的用户反馈。\n\n")
	fmt.Fprintf(&b, "编号：#%d\n类型：%s\n", item.ID, label)
	if account != "" {
		fmt.Fprintf(&b, "提交账号：%s\n", account)
	}
	if item.Email != "" && !strings.EqualFold(item.Email, accountEmail) {
		fmt.Fprintf(&b, "联系邮箱：%s\n", item.Email)
	}
	client := strings.TrimSpace(strings.Join([]string{versionText(item.AppVersion), item.Platform}, " · "))
	if client = strings.Trim(client, " ·"); client != "" {
		fmt.Fprintf(&b, "客户端：%s\n", client)
	}
	fmt.Fprintf(&b, "提交时间：%s（UTC+8）\n", time.UnixMilli(item.CreatedAt).In(displayZone).Format("2006-01-02 15:04:05"))
	b.WriteString("\n---------- 反馈内容 ----------\n")
	b.WriteString(item.Content)
	b.WriteString("\n------------------------------\n\n请在 Web2Term 管理后台的「反馈」中查看和处理。\n")
	return subject, b.String()
}

func versionText(version string) string {
	if version == "" {
		return ""
	}
	return "v" + strings.TrimPrefix(version, "v")
}
