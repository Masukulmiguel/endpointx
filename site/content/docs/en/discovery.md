---
title: Network Discovery
lead: CIDR ranges, node review and installation requests.
description: How to run a network discovery, validate CIDR ranges, review the nodes you find and turn them into consented installation requests.
---

## What Network Discovery is

Network Discovery uses an authorized agent in the `online` state to map out your network: MAC address (with vendor OUI), IP, resolved hostname and estimated operating system.

The scan **runs on the endpoint, not on the server**: the panel issues the `network_discovery` command and the agent performs the sweep using the neighbour (ARP) table, a budgeted ping sweep and reverse DNS. Results land in `network_nodes` — initial `review_status` of `new`, deduplicated by MAC (by IP when there is no MAC) — and hosts with no linked agent stay `node_type = UNKNOWN` and raise a HERMES `identify_device` recommendation so someone can identify them.

Panel areas: **Network** (`/network`) for the map and **Discovered Devices** (`/network/discovery`) for runs and the review queue. List nodes with `GET /api/netsentinel/discovery/nodes` (requires `network.view`).

## Allowed CIDR ranges

Two levels of validation:

- **Server** — the `cidr` field must be a private RFC1918 network with a prefix between /8 and /30 (e.g. `192.168.1.0/24`, `10.0.0.0/24`); otherwise you get `Invalid cidr: use a private RFC1918 CIDR like 192.168.1.0/24`.
- **Agent** — it only sweeps the endpoint's own RFC1918 subnets (at most 4 subnets; networks larger than /22 are truncated to the first /22 block, never expanded). A requested `cidr` must be contained in one of those subnets and cannot exceed the /22 ceiling (1024 hosts).

Sweep safety limits: a 60-second budget and at most 64 concurrent pings. With no `cidr`, the agent scans its own subnets.

> **Note:** leave the field empty to discover only the subnet where the agent is installed; pass an explicit `cidr` to widen it within the same segment.

## Run a discovery

```http
POST /api/netsentinel/discovery/run
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json

{
  "device_id": "…",
  "cidr": "192.168.1.0/24"
}
```

Response `201`:

```json
{ "run_id": "…", "command_id": "…", "device_id": "…" }
```

- Requires the `network.view` permission and an `online` agent; with no agent available you get `No online agent available to run discovery`, and a stale device returns `Device is offline or not an agent`.
- Each agent can only run one discovery at a time (`409` if one is already in progress).
- Results land in the review queue; runs are listed under `GET /api/netsentinel/discovery`.

## Review queue

Every new node stays `new` until you decide. Per node (`POST /api/netsentinel/discovery/nodes/:id/...`, `network.view`, except `enroll-request`):

- **`mark-known`** — the device belongs to your network and is already known.
- **`ignore`** — drops it out of the review flow (routers, printers, and so on).
- **`identify`** — records a name/note for the node.
- **`enroll-request`** (requires `devices.manage`) — opens an installation request and moves the node to `enrollment_requested`.

`GET /api/netsentinel/discovery/nodes/:id` returns the node's detail, including the run history where it was seen.

## From node to installation request

1. **Create** — `POST /api/netsentinel/discovery/install-requests` with `node_ids` (batches up to 100) and `devices.manage`. Each request stores `invite_token`, `install_jti` and `os_hint`, valid for **7 days** (`REQUEST_TTL_DAYS`), and generates the right commands for the node's OS (`buildInstallCommands`).
2. **Deliver** — the consent link is `https://endpointx.onrender.com/api/enroll/invite/<TOKEN>` (`buildInviteUrl`); the request becomes `delivered` when the recipient opens it.
3. **Decide** — on the web page (or in the installer's native dialog) the user authorizes or refuses: `authorized` moves on to installation (script with the install token embedded), `refused` closes the request and the node returns to `new`.
4. **Complete** — `installing` → `installed` → `integrated`, as the agent registers and is approved; `GET /api/netsentinel/discovery/install-requests` lists the requests.
5. **Manage** — `POST /api/netsentinel/discovery/install-requests/:id/cancel` cancels a request, `.../retry` issues a new token and reopens it. Expired or cancelled requests cannot be reused and the node returns to `new` — there is only one active request per node.

## NetSentinel/NAC (in development)

EndpointX's Zero Trust layer (NetSentinel) is **in development** in this version 1.3.0, like the rest of the product. The foundations are already there: NAC policies (`GET/POST /api/netsentinel/nac/policies`), evaluation (`POST /api/netsentinel/nac/evaluate`), trust decisions (`GET /api/netsentinel/nac/decisions`, `GET /api/netsentinel/devices/:id/trust`) and incidents (`/api/netsentinel/incidents`) — but the policy engine and automatic access enforcement are still being built, so treat them as a preview rather than final behaviour.
