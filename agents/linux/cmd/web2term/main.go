package main

import (
	"fmt"
	"os"

	"web2term/agent/internal/cli"
)

func main() {
	if err := cli.Run(os.Args[1:], os.Stdin, os.Stdout, ""); err != nil {
		fmt.Fprintln(os.Stderr, "错误：", err)
		// Recoverable network failures already retry in the agent loop. Returned
		// service errors require intervention (e.g. expired login), not restart loops.
		if len(os.Args) == 3 && os.Args[1] == "__service" {
			os.Exit(78)
		}
		os.Exit(1)
	}
}
