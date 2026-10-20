package xyz.kangnasi.web2termback.controller;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import xyz.kangnasi.web2termback.feignclient.UserServiceClient;
import xyz.kangnasi.web2termback.mapper.UserDeviceMapper;
import xyz.kangnasi.web2termback.websocket.AgentWebSocketHandler;

import java.util.List;

/**
 * 当前用户设备查询与名称管理接口。
 */
@RestController
@RequestMapping("/api/user/devices")
public class UserDeviceController {

    private final UserServiceClient userServiceClient;
    private final UserDeviceMapper userDeviceMapper;
    private final AgentWebSocketHandler agentWebSocketHandler;
    private final ObjectMapper objectMapper;

    public UserDeviceController(UserServiceClient userServiceClient,
                                UserDeviceMapper userDeviceMapper,
                                AgentWebSocketHandler agentWebSocketHandler,
                                ObjectMapper objectMapper) {
        this.userServiceClient = userServiceClient;
        this.userDeviceMapper = userDeviceMapper;
        this.agentWebSocketHandler = agentWebSocketHandler;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public List<UserDeviceMapper.UserDeviceRecord> listDevices(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        ResponseEntity<String> authResponse = userServiceClient.introspect(authorization);
        long userId = extractUserId(authResponse.getBody());
        return userDeviceMapper.findByUserId(userId).stream()
                .map(device -> {
                    int onlineStatus = agentWebSocketHandler.getSession(device.deviceId()) != null ? 1 : 0;
                    return new UserDeviceMapper.UserDeviceRecord(
                                device.deviceId(),
                                device.deviceName(),
                                device.enabled(),
                                onlineStatus,
                                device.lastConnectedAt(),
                                device.lastHeartbeatAt(),
                                device.lastDisconnectedAt(),
                                device.terminalConnectionStatus(),
                                device.terminalSessionId(),
                                device.desktopClientId(),
                                device.terminalRequestedAt(),
                                device.terminalConnectedAt(),
                                device.terminalDisconnectedAt(),
                                device.terminalError(),
                                device.createdAt(),
                                device.updatedAt());
                })
                .toList();
    }

    @PatchMapping("/{deviceId}")
    public ResponseEntity<Void> renameDevice(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable("deviceId") String deviceId,
            @RequestBody RenameDeviceRequest request) {
        ResponseEntity<String> authResponse = userServiceClient.introspect(authorization);
        long userId = extractUserId(authResponse.getBody());
        if (deviceId == null || !deviceId.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid device id");
        }
        String deviceName = request == null || request.deviceName() == null ? "" : request.deviceName().strip();
        if (deviceName.isEmpty() || deviceName.length() > 100 || deviceName.codePoints().anyMatch(Character::isISOControl)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid device name");
        }
        // The authenticated account is part of the UPDATE predicate, including offline/disabled devices.
        if (userDeviceMapper.renameForUser(userId, deviceId.toLowerCase(java.util.Locale.ROOT), deviceName) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "device not found");
        }
        return ResponseEntity.noContent().build();
    }

    public record RenameDeviceRequest(String deviceName) {
    }

    /**
     * userId 只信任 user-service 的 introspect 返回值，不接受客户端直接传入用户 ID。
     */
    private long extractUserId(String body) {
        try {
            JsonNode json = body == null ? null : objectMapper.readTree(body);
            long userId = json == null ? 0 : json.path("userId").asLong(0);
            if (userId <= 0) {
                throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "invalid user identity");
            }
            return userId;
        } catch (ResponseStatusException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "invalid auth response", exception);
        }
    }
}
