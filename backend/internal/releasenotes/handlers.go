package releasenotes

import (
	"net/http"
	"strconv"

	"web2term/backend/internal/store"
)

func (a *API) list(w http.ResponseWriter, r *http.Request) {
	machine, ok := machineID(w, r.URL.Query().Get("machineId"))
	if !ok {
		return
	}
	limit, offset, ok := pagination(w, r)
	if !ok {
		return
	}
	page, err := a.store.ListReleaseNotes(r.Context(), machine, a.now().UnixMilli(), limit, offset)
	if err != nil {
		a.failure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (a *API) detail(w http.ResponseWriter, r *http.Request) {
	id, ok := noteID(w, r)
	if !ok {
		return
	}
	machine, ok := machineID(w, r.URL.Query().Get("machineId"))
	if !ok {
		return
	}
	note, err := a.store.GetReleaseNote(r.Context(), id, machine, a.now().UnixMilli())
	if err != nil {
		a.failure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (a *API) markRead(w http.ResponseWriter, r *http.Request) {
	id, ok := noteID(w, r)
	if !ok {
		return
	}
	var input struct {
		MachineID string `json:"machineId"`
	}
	if !decodeJSON(w, r, 1024, &input) {
		return
	}
	machine, ok := machineID(w, input.MachineID)
	if !ok {
		return
	}
	readAt, err := a.store.MarkReleaseNoteRead(r.Context(), id, machine, a.now().UnixMilli())
	if err != nil {
		a.failure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "machineId": machine, "isRead": true, "readAt": readAt})
}

func (a *API) adminList(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := pagination(w, r)
	if !ok {
		return
	}
	page, err := a.store.ListAdminReleaseNotes(r.Context(), limit, offset)
	if err != nil {
		a.failure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (a *API) adminDetail(w http.ResponseWriter, r *http.Request) {
	id, ok := noteID(w, r)
	if !ok {
		return
	}
	note, err := a.store.GetAdminReleaseNote(r.Context(), id)
	if err != nil {
		a.failure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (a *API) adminCreate(w http.ResponseWriter, r *http.Request) {
	var input store.NoteInput
	if !decodeJSON(w, r, 8*1024*1024, &input) {
		return
	}
	note, err := a.store.CreateReleaseNote(r.Context(), input, a.now().UnixMilli())
	if err != nil {
		a.failure(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/v1/admin/release-notes/"+strconv.FormatInt(note.ID, 10))
	writeJSON(w, http.StatusCreated, note)
}

func (a *API) adminUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := noteID(w, r)
	if !ok {
		return
	}
	var input store.NoteInput
	if !decodeJSON(w, r, 8*1024*1024, &input) {
		return
	}
	note, err := a.store.UpdateReleaseNote(r.Context(), id, input, a.now().UnixMilli())
	if err != nil {
		a.failure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (a *API) adminDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := noteID(w, r)
	if !ok {
		return
	}
	if err := a.store.DeleteReleaseNote(r.Context(), id); err != nil {
		a.failure(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
