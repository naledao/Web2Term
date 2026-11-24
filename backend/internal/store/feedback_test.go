package store

import (
	"errors"
	"testing"
)

func feedbackUser(t *testing.T, s *Store, email string, now int64) User {
	t.Helper()
	if err := s.ReserveCode(t.Context(), email, []byte("hash-"+email), now); err != nil {
		t.Fatal(err)
	}
	user, err := s.LoginWithCode(t.Context(), email, []byte("hash-"+email), now+1, "usr_"+email)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func TestFeedbackIsScopedToUserAndFallsBackToLoginEmail(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	owner := feedbackUser(t, s, "owner@example.invalid", 1000)
	other := feedbackUser(t, s, "other@example.invalid", 1000)

	first, err := s.CreateFeedback(ctx, owner.ID, FeedbackInput{MachineID: machineA, Category: "bug", Content: "崩溃了", AppVersion: "0.1.242", Platform: "win32-x64"}, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if first.Email != owner.Email || first.Status != FeedbackPending || first.CreatedAt != 2000 || first.UpdatedAt != 2000 {
		t.Fatalf("unexpected first feedback: %+v", first)
	}
	second, err := s.CreateFeedback(ctx, owner.ID, FeedbackInput{Category: "feature", Content: "想要导出", Email: "contact@example.invalid"}, 3000)
	if err != nil || second.Email != "contact@example.invalid" {
		t.Fatalf("explicit contact email: %+v %v", second, err)
	}
	if _, err := s.CreateFeedback(ctx, other.ID, FeedbackInput{Category: "other", Content: "别人的"}, 2500); err != nil {
		t.Fatal(err)
	}

	items, total, err := s.ListFeedback(ctx, owner.ID, 20, 0)
	if err != nil || total != 2 || len(items) != 2 || items[0].ID != second.ID || items[1].ID != first.ID {
		t.Fatalf("owner list: %+v total=%d %v", items, total, err)
	}
	page, total, err := s.ListFeedback(ctx, owner.ID, 1, 1)
	if err != nil || total != 2 || len(page) != 1 || page[0].ID != first.ID {
		t.Fatalf("owner second page: %+v total=%d %v", page, total, err)
	}
	var machine *string
	if err := s.db.QueryRow("SELECT machine_id FROM app_feedback WHERE id = ?", second.ID).Scan(&machine); err != nil || machine != nil {
		t.Fatalf("empty machine id should be NULL: %v %v", machine, err)
	}
}

func TestFeedbackDailyQuotaAndDisabledUser(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	user := feedbackUser(t, s, "quota@example.invalid", 1000)
	const day = 24 * 60 * 60 * 1000
	start := int64(10 * day)
	for i := 0; i < FeedbackDailyLimit; i++ {
		if _, err := s.CreateFeedback(ctx, user.ID, FeedbackInput{Category: "bug", Content: "x"}, start+int64(i)); err != nil {
			t.Fatalf("feedback %d: %v", i, err)
		}
	}
	if _, err := s.CreateFeedback(ctx, user.ID, FeedbackInput{Category: "bug", Content: "x"}, start+100); !errors.Is(err, ErrFeedbackQuota) {
		t.Fatalf("quota not enforced: %v", err)
	}
	if _, err := s.CreateFeedback(ctx, user.ID, FeedbackInput{Category: "bug", Content: "x"}, start+day); err != nil {
		t.Fatalf("quota should roll after 24 hours: %v", err)
	}
	if _, err := s.db.Exec("UPDATE user_account SET enabled = 0 WHERE id = ?", user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateFeedback(ctx, user.ID, FeedbackInput{Category: "bug", Content: "x"}, start+2*day); !errors.Is(err, ErrUserDisabled) {
		t.Fatalf("disabled user accepted: %v", err)
	}
}

func TestFeedbackSchemaRejectsInvalidRows(t *testing.T) {
	s := openTestStore(t)
	user := feedbackUser(t, s, "schema@example.invalid", 1000)
	for _, input := range []FeedbackInput{
		{Category: "praise", Content: "x"},
		{Category: "bug", Content: "   "},
		{Category: "bug", Content: "x", Email: "no-at-sign"},
		{Category: "bug", Content: "x", MachineID: "short"},
	} {
		if _, err := s.CreateFeedback(t.Context(), user.ID, input, 2000); err == nil {
			t.Fatalf("schema accepted %+v", input)
		}
	}
}
