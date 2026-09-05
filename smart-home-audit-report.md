# Smart Home Deep Audit Report

## Executive Summary

After a comprehensive audit of the entire Apollo repository, **there are NO implemented Smart Home integrations**. The Apollo agent does not currently control any external smart home devices (lights, switches, plugs, thermostats, etc.).

The only "device control" tools exist and they control the Apollo device itself, not external hardware.

---

## 1. Search Methodology

I searched the entire repository including:
- All `*.ts` files in `apps/agent/src/`
- All `*.ts` files in `apps/console/src/`
- All documentation `.md` files
- Test files (`*.spec.ts`)
- Git submodule `apps/firmware/apollo-firmware` (though firmware submodule not locally available)

Search patterns included:
- Google Home, Google Assistant, Smart Home, Home Assistant
- Matter, MQTT, Tuya, Philips Hue, Shelly, Nest, Chromecast, Google TV
- light, switch, plug, thermostat, device control, scene, automation
- MCP servers, MCP tools related to smart home
- web_control, http_control, rest api, device api

---

## 2. Findings: What EXISTS (Not Smart Home)

### A. Device Self-Control Tools (3 tools only)

| Tool Name | File | Function | API | Auth | Dependencies | Status |
|-----------|------|----------|-----|------|--------------|--------|
| `set_volume` | `apps/agent/src/tools/device.ts:17` | Changes Apollo's own speaker volume (0-100) | Internal device tool via MCP bridge | `DEVICE_SHARED_SECRET` (device auth) | `context.effects.callDeviceTool()` | **Functional** - controls Apollo's own volume |
| `set_brightness` | `apps/agent/src/tools/device.ts:45` | Changes Apollo's own screen brightness (0-100) | Internal device tool via MCP bridge | `DEVICE_SHARED_SECRET` (device auth) | `context.effects.callDeviceTool()` | **Functional** - controls Apollo's own brightness |
| `device_status` | `apps/agent/src/tools/device.ts:88` | Reads Apollo's own status (battery, brightness, volume, WiFi) | Internal device tool via MCP bridge | `DEVICE_SHARED_SECRET` (device auth) | `context.effects.callDeviceTool()` | **Functional** - reads Apollo's own status |

**None of these control external smart home hardware.** They all operate on the Apollo device itself.

### B. MCP Framework (Infrastructure Only)

The MCP (Multi-Command Protocol) framework exists as the pathway for future integrations:

| Component | File | Purpose | Status |
|-----------|------|---------|--------|
| `MCP Bridge` | `apps/agent/src/mcp/bridge.ts` | Routes JSON-RPC calls to firmware tools | **Implemented** - handles `self.audio_speaker.set_volume`, `self.screen.set_brightness`, `self.get_device_status` |
| `MCP Servers` | `apps/agent/src/mcp/servers.ts` | Manages installed external MCP servers | **Implemented** - owner can install/OAuth-connect external servers |
| `MCP Adapter` | `apps/agent/src/mcp/adapter.ts` | Safety filtering for discovered tools | **Implemented** - validates tool safety before model can call |
| `MCP Naming` | `apps/agent/src/mcp/naming.ts` | Namespaced tool name formatting | **Implemented** - `buildNamespacedMcpToolName()` |

**However**: No smart home tool definitions exist in the built-in catalog. The MCP framework is architected so owners *could* add external servers, but no smart home integrations are pre-configured.

### C. Console Reference Mentions (Future/Planning Only)

| Document | Line | Content | Status |
|----------|------|---------|--------|
| `documentation/console/roadmap/catalog.ts:162-163` | Lists "Home Assistant" and "Philips Hue" as brands | **Planning/Exploring** - mentioned in roadmap, not implemented |
| `documentation/console/roadmap/catalog.ts:167` | "Reach into the room: lights, music, and anything Home Assistant already controls" | **Roadmap item** - described as future feature |
| `documentation/skills/operate.md` | No specific smart home references | Not implemented |

### D. No Implementations Found

- ❌ No Google Home API integration
- ❌ No Google Assistant integration
- ❌ No Matter protocol implementation
- ❌ No MQTT broker/client
- ❌ No Tuya API integration
- ❌ No Philips Hue bridge integration
- ❌ No Shelly HTTP API integration
- ❌ No Nest API integration
- ❌ No Chromecast/Dial protocol
- ❌ No Google TV control
- ❌ No web_control or http_control for device management
- ❌ No REST API for smart home
- ❌ No scene/automation definitions
- ❌ No home assistant connector

---

## 3. Direct Answer: Can Apollo Control a Light Switch?

### **SMART HOME = NOT IMPLEMENTED**

**The Apollo original cannot control a light smart home device.**

There is **zero** code in the repository that:
- Sends commands to external light bulbs or switches
- Connects to any smart home hub or protocol (MQTT, Zigbee, Z-Wave, WiFi LAN control)
- Uses any smart home API (Philips Hue, Tuya, Home Assistant, etc.)
- Implements any device control beyond Apollo's own volume/brightness

---

## 4. Detailed Analysis

### A. Why "Not Implemented"

1. **Tool catalog has no smart home definitions**: The `listBuiltinToolDefinitionList()` in `catalog.ts` contains 26 tools, none related to light control, switch operation, plug management, or thermostat control.

2. **No external API credentials or endpoints**: There are no environment variables, API keys, or endpoint URLs for any smart home service.

3. **No device-type schemas**: No Zod schemas for light states, switch positions, thermostat temperatures, etc.

4. **No discovery or onboarding flow**: No wizard steps for adding smart home accounts, no credential storage patterns for smart home services.

5. **No scene or automation support**: No tools for creating, activating, or managing home automation scenes.

6. **MCP framework is generic**: The MCP bridge handles `self.*` device tools, not external home device protocols. There's no `smartthings`, `homeassistant`, `philips_hue`, or `tuya` method in the bridge.

### B. What WOULD Be Needed (For Future Reference)

If Apollo were to add Smart Home support, the following would be required (but are NOT currently present):

| Requirement | Purpose |
|-------------|---------|
| New tool definitions under `src/tools/` | e.g., `light_on`, `light_off`, `set_brightness`, `set_color`, `set_temperature` |
| Zod schemas with `safety: 'unsafe'` for most | Most smart home actions need confirmation |
| MCP server integration or direct HTTP clients | To communicate with hub bridges (Hubitat, Home Assistant, etc.) |
| Authentication flows | OAuth or token-based auth for each service |
| Console UI pages | To discover, add, and manage smart home connections |
| Wizard setup steps | To guide owners through account linking |
| Scene and automation tools | `create_scene`, `activate_automation`, etc. |

### C. MCP + Smart Home Architecture (Conceptual Only)

The existing MCP framework COULD support smart home integrations in the future:

1. Owner installs an MCP server that implements smart home protocols
2. Server exposes tools like `lights/turn_on`, `lights/turn_off`
3. Agent's tool catalog includes these as enabled tools
4. Model can call them with proper confirmations (since most are `unsafe`)
5. Console shows connected servers and their capabilities

**But**: This is entirely conceptual. No such servers, tools, or integrations exist in the current codebase.

---

## 5. Final Determination Table

| Integration | Implemented? | File/Location | Status |
|-------------|-------------|---------------|--------|
| **Google Home** | ❌ No | N/A | Not implemented |
| **Google Assistant** | ❌ No | N/A | Not implemented |
| **Home Assistant** | ❌ No | Roadmap catalog mentions it | Exploring only |
| **Philips Hue** | ❌ No | Roadmap catalog mentions it | Exploring only |
| **Matter protocol** | ❌ No | N/A | Not implemented |
| **MQTT** | ❌ No | N/A | Not implemented |
| **Tuya** | ❌ No | N/A | Not implemented |
| **Shelly** | ❌ No | N/A | Not implemented |
| **Nest** | ❌ No | N/A | Not implemented |
| **Chromecast** | ❌ No | N/A | Not implemented |
| **Google TV** | ❌ No | N/A | Not implemented |
| **Light control** | ❌ No | N/A | Not implemented |
| **Switch control** | ❌ No | N/A | Not implemented |
| **Plug/Outlet control** | ❌ No | N/A | Not implemented |
| **Thermostat control** | ❌ No | N/A | Not implemented |
| **Scene management** | ❌ No | N/A | Not implemented |
| **Automation triggers** | ❌ No | N/A | Not implemented |
| **Device status read** | ✅ Yes | `device_status` tool | Reads Apollo's own status only |
| **Volume control** | ✅ Yes | `set_volume` tool | Controls Apollo's own volume |
| **Brightness control** | ✅ Yes | `set_brightness` tool | Controls Apollo's own brightness |

---

## 6. Conclusion

**The Apollo repository has NO Smart Home functionality implemented.**

The only device control capabilities are:
- `set_volume` - Apollo's own speaker volume
- `set_brightness` - Apollo's own screen brightness  
- `device_status` - Apollo's own telemetry

All other smart home integrations (Google Home, Philips Hue, Home Assistant, Matter, MQTT, etc.) are **not implemented**. They are mentioned only in roadmap planning documents as future items with "exploring" status.

The MCP framework provides the architectural pathway for adding such integrations later, but no smart home tools, servers, or protocols are currently coded or functional.

**SMART HOME = NOT IMPLEMENTED** in the Apollo codebase as it currently exists.