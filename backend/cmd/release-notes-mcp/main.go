// release-notes-mcp is a local stdio MCP server. stdout is exclusively MCP JSON-RPC.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"web2term/backend/internal/releasenotesmcp"
)

func main() {
	flags := flag.NewFlagSet("web2term-release-notes-mcp", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "私密 JSON 配置文件的绝对路径")
	if err := flags.Parse(os.Args[1:]); err != nil {
		if err == flag.ErrHelp {
			return
		}
		os.Exit(2)
	}
	if *configPath == "" || flags.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "用法：web2term-release-notes-mcp --config <私密 JSON 配置文件>")
		os.Exit(2)
	}
	cfg, err := releasenotesmcp.LoadConfig(*configPath)
	if err != nil {
		fail(err.Error())
	}
	client, err := releasenotesmcp.NewClient(cfg)
	if err != nil {
		fail(err.Error())
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := releasenotesmcp.NewServer(client).Run(ctx, &mcp.StdioTransport{}); err != nil && ctx.Err() == nil {
		// SDK/protocol errors could contain input data; do not echo them.
		fail("MCP 会话结束时发生错误，请检查客户端的协议日志")
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
