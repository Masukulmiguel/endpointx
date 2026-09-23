# HERMES Scanning

## Non-destructive TCP connect scan

1. Load policy ports (or ranges).
2. Filter excluded ports/hosts and allowed CIDRs.
3. Probe with bounded concurrency and inter-batch delay (rate limit).
4. States: `open`, `closed`, `filtered`, `unknown`.
5. Optional banner grab for common ports (HTTP GET or passive read).
6. Service identification via port map + banner → product/version/confidence.

## Persistence

Upsert into `hermes_ports` on `(asset_id, port, protocol)`.

## Baselines / anomaly detection

After open ports are stored, HERMES updates `hermes_baselines` (`baseline_type = ports`).

- First snapshot becomes baseline.
- New port vs baseline → finding `NEW OPEN PORT` + alert + baseline update.

## Endpoint data

Agent inventory (`device_software`, `device_services`) is correlated for application CVEs.  
HERMES does **not** collect passwords, cookies, documents, keystrokes, or private messages.

## Failure handling

Scan runner catches errors, sets `status = failed` with `error_message`.  
Emergency stop aborts mid-loop and marks scan `stopped`.
