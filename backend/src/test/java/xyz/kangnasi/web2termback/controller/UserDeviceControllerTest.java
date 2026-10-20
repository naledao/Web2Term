package xyz.kangnasi.web2termback.controller;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;
import xyz.kangnasi.web2termback.feignclient.UserServiceClient;
import xyz.kangnasi.web2termback.mapper.UserDeviceMapper;
import xyz.kangnasi.web2termback.websocket.AgentWebSocketHandler;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

/** Offline unit tests; no Spring context, database, Nacos or real user-service calls. */
class UserDeviceControllerTest {
    private static final String DEVICE_ID = "aabbccdd-1234-5678-9abc-0123456789ab";
    private final UserServiceClient users = mock(UserServiceClient.class);
    private final UserDeviceMapper devices = mock(UserDeviceMapper.class);
    private final UserDeviceController controller = new UserDeviceController(
            users, devices, mock(AgentWebSocketHandler.class), new ObjectMapper());

    private void signedIn() {
        when(users.introspect("Bearer test")).thenReturn(ResponseEntity.ok("{\"userId\":42}"));
    }

    @Test
    void renamesUsingAuthenticatedOwnerAndNormalizedName() {
        signedIn();
        when(devices.renameForUser(42, DEVICE_ID, "我的设备")).thenReturn(1);
        var response = controller.renameDevice("Bearer test", DEVICE_ID.toUpperCase(java.util.Locale.ROOT),
                new UserDeviceController.RenameDeviceRequest("  我的设备  "));
        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode());
        verify(devices).renameForUser(42, DEVICE_ID, "我的设备");
        verifyNoMoreInteractions(devices);
    }

    @Test
    void anotherAccountsDeviceAndMissingDeviceReturnNotFound() {
        signedIn();
        when(devices.renameForUser(42, DEVICE_ID, "name")).thenReturn(0);
        var error = assertThrows(ResponseStatusException.class, () -> controller.renameDevice(
                "Bearer test", DEVICE_ID, new UserDeviceController.RenameDeviceRequest("name")));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatusCode());
    }

    @Test
    void rejectsInvalidNamesAndDeviceIdBeforeDatabaseUpdate() {
        signedIn();
        for (String name : new String[]{" ", "x".repeat(101), "first\nsecond", "name\u0000"}) {
            var error = assertThrows(ResponseStatusException.class, () -> controller.renameDevice(
                    "Bearer test", DEVICE_ID, new UserDeviceController.RenameDeviceRequest(name)));
            assertEquals(HttpStatus.BAD_REQUEST, error.getStatusCode());
        }
        var error = assertThrows(ResponseStatusException.class, () -> controller.renameDevice(
                "Bearer test", "../other", new UserDeviceController.RenameDeviceRequest("name")));
        assertEquals(HttpStatus.BAD_REQUEST, error.getStatusCode());
        verifyNoInteractions(devices);
    }

    @Test
    void rejectsMissingIdentityBeforeDatabaseUpdate() {
        when(users.introspect("Bearer test")).thenReturn(ResponseEntity.ok("{}"));
        var error = assertThrows(ResponseStatusException.class, () -> controller.renameDevice(
                "Bearer test", DEVICE_ID, new UserDeviceController.RenameDeviceRequest("name")));
        assertEquals(HttpStatus.UNAUTHORIZED, error.getStatusCode());
        verifyNoInteractions(devices);
    }
}
