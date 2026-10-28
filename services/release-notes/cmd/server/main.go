package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"web2term/release-notes/internal/httpapi"
	"web2term/release-notes/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("service stopped", "error", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func run(logger *slog.Logger) error {
	addr := flag.String("addr", envOr("RELEASE_NOTES_ADDR", "127.0.0.1:8091"), "HTTP listen address")
	path := flag.String("db", envOr("RELEASE_NOTES_DB", "./data/release-notes.db"), "SQLite file path")
	flag.Parse()
	adminToken := os.Getenv("RELEASE_NOTES_ADMIN_TOKEN")
	if strings.TrimSpace(adminToken) != adminToken {
		return errors.New("RELEASE_NOTES_ADMIN_TOKEN must not contain leading or trailing whitespace")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	database, err := store.Open(ctx, *path)
	if err != nil {
		return err
	}
	defer database.Close()
	server := &http.Server{
		Addr: *addr, Handler: httpapi.New(database, adminToken, logger),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	logger.Info("release notes service listening", "addr", listener.Addr().String(), "adminEnabled", adminToken != "")
	serveError := make(chan error, 1)
	go func() { serveError <- server.Serve(listener) }()
	select {
	case err := <-serveError:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			return fmt.Errorf("shutdown: %w", err)
		}
		if err := <-serveError; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		logger.Info("release notes service stopped")
		return nil
	}
}
