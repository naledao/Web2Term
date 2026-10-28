package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"web2term/backend/internal/auth"
	"web2term/backend/internal/config"
	"web2term/backend/internal/httpapi"
	"web2term/backend/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("backend stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	initCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	db, err := store.Open(initCtx, cfg.DBPath)
	cancel()
	if err != nil {
		return err
	}
	defer db.Close()
	listener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return errors.New("cannot listen on WEB2TERM_ADDR")
	}
	defer listener.Close()
	accounts, err := auth.New(db, auth.SMTPMailer{Config: cfg.SMTP}, cfg.JWTSecret)
	if err != nil {
		return err
	}
	api := httpapi.New(db, accounts, log, httpapi.WithReleaseNotes(db, cfg.ReleaseNotesAdminToken))
	server := &http.Server{
		Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 32 << 10,
	}
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()
	log.Info("backend listening", "address", listener.Addr().String(), "database", cfg.DBPath)
	select {
	case <-ctx.Done():
	case err = <-result:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Error("HTTP listener stopped")
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// Shutdown does not close hijacked WebSockets, so the registry closes and
	// drains them separately before the database is closed.
	httpDone := make(chan error, 1)
	go func() { httpDone <- server.Shutdown(shutdownCtx) }()
	api.Shutdown()
	if shutdownErr := <-httpDone; shutdownErr != nil {
		_ = server.Close()
		return errors.New("HTTP shutdown timed out")
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return errors.New("HTTP listener failed")
	}
	log.Info("backend stopped cleanly")
	return nil
}
