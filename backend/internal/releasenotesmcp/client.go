package releasenotesmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const adminPath = "/api/v1/admin/release-notes"
const maxResponseBytes = 8 * 1024 * 1024

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewClient(cfg Config) (*Client, error) {
	cfg, err := normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Client{
		baseURL: cfg.BaseURL, token: cfg.AdminToken,
		http: &http.Client{
			Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second,
			// Never forward the Authorization header to a redirected endpoint.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

// Wire types deliberately do not import store: the MCP binary needs no SQLite.
type wireNote struct {
	ID          int64  `json:"id"`
	Version     string `json:"version"`
	Title       string `json:"title"`
	ContentHTML string `json:"contentHtml"`
	Status      int    `json:"status"`
	PublishedAt *int64 `json:"publishedAt"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type noteBody struct {
	Version     string `json:"version"`
	Title       string `json:"title"`
	ContentHTML string `json:"contentHtml"`
	Status      int    `json:"status"`
	PublishedAt *int64 `json:"publishedAt"`
}

// Note uses string IDs to preserve SQLite int64 identifiers in MCP clients.
type Note struct {
	ID          string `json:"id"`
	Version     string `json:"version"`
	Title       string `json:"title"`
	ContentHTML string `json:"contentHtml,omitempty"`
	Status      int    `json:"status"`
	PublishedAt *int64 `json:"publishedAt"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type Page struct {
	Items  []Note `json:"items"`
	Total  int    `json:"total"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
}

func (c *Client) output(n wireNote) Note {
	redact := func(s string) string { return strings.ReplaceAll(s, c.token, "[REDACTED]") }
	return Note{
		ID: strconv.FormatInt(n.ID, 10), Version: redact(n.Version), Title: redact(n.Title),
		ContentHTML: redact(n.ContentHTML), Status: n.Status, PublishedAt: n.PublishedAt,
		CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt,
	}
}

func (n wireNote) body() noteBody {
	return noteBody{n.Version, n.Title, n.ContentHTML, n.Status, n.PublishedAt}
}

func notePath(id string) (string, error) {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != id {
		return "", errors.New("INVALID_ID: id 必须为正整数的十进制字符串")
	}
	return adminPath + "/" + id, nil
}

func (c *Client) get(ctx context.Context, id string) (wireNote, error) {
	var n wireNote
	path, err := notePath(id)
	if err == nil {
		err = c.request(ctx, http.MethodGet, path, nil, http.StatusOK, &n)
	}
	if err == nil {
		err = validateNoteResponse(n, id)
	}
	return n, err
}

func (c *Client) put(ctx context.Context, id string, body noteBody) (wireNote, error) {
	var n wireNote
	path, err := notePath(id)
	if err == nil {
		err = validateBody(body)
	}
	if err == nil {
		err = c.request(ctx, http.MethodPut, path, body, http.StatusOK, &n)
	}
	if err == nil {
		err = validateNoteResponse(n, id)
	}
	return n, err
}

func validateNoteResponse(n wireNote, expectedID string) error {
	if n.ID < 1 || (expectedID != "" && strconv.FormatInt(n.ID, 10) != expectedID) || n.Version == "" ||
		n.Title == "" || n.Status < 0 || n.Status > 2 || len(n.ContentHTML) > 1024*1024 {
		return errors.New("INVALID_RESPONSE: 后端返回的更新说明结构异常；写操作请先查询结果再重试")
	}
	return nil
}

func (c *Client) request(ctx context.Context, method, path string, body any, expected int, out any) error {
	var input io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return errors.New("INVALID_REQUEST: 无法编码请求")
		}
		input = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, input)
	if err != nil {
		return errors.New("INVALID_REQUEST: 无法创建请求")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		// Transport errors can contain URLs/headers; never return the raw error.
		return errors.New("BACKEND_UNREACHABLE: 后端请求失败或超时，请检查地址和服务状态；写操作请先查询结果再重试")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(raw) > maxResponseBytes {
		return errors.New("INVALID_RESPONSE: 后端响应读取失败或超过 8 MiB；写操作请先查询结果再重试")
	}
	if resp.StatusCode != expected {
		return apiError(resp.StatusCode, raw)
	}
	if out != nil && json.Unmarshal(raw, out) != nil {
		return errors.New("INVALID_RESPONSE: 后端没有返回预期的 JSON；写操作请先查询结果再重试")
	}
	return nil
}

func apiError(status int, raw []byte) error {
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	// Use only known codes and fixed messages, never the upstream message/body.
	messages := map[string]string{
		"UNAUTHORIZED":           "管理令牌无效，请检查私密配置与服务器的 RELEASE_NOTES_ADMIN_TOKEN",
		"ADMIN_DISABLED":         "后端尚未启用更新说明管理接口",
		"NOT_FOUND":              "更新说明不存在，或服务器尚未部署更新说明模块",
		"VERSION_EXISTS":         "该版本号已经存在，请先查询现有记录",
		"INVALID_REQUEST":        "字段校验失败，请检查版本、标题、正文和状态",
		"INVALID_ID":             "更新说明 ID 无效",
		"INVALID_PAGINATION":     "分页参数无效",
		"INVALID_JSON":           "请求 JSON 无效",
		"UNSUPPORTED_MEDIA_TYPE": "后端拒绝了请求内容类型",
		"BODY_TOO_LARGE":         "请求正文过大",
		"DATABASE_BUSY":          "数据库繁忙，请稍后重试",
		"REQUEST_TIMEOUT":        "后端处理超时，写操作请先查询结果再重试",
		"INTERNAL_ERROR":         "后端处理失败，写操作请先查询结果再重试",
	}
	if message, ok := messages[body.Error.Code]; ok {
		return fmt.Errorf("%s (HTTP %d): %s", body.Error.Code, status, message)
	}
	return fmt.Errorf("BACKEND_ERROR (HTTP %d): 后端返回异常状态，请检查部署和服务日志", status)
}
