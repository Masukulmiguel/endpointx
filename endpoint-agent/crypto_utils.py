"""Security utilities for EndpointX agent."""

import hashlib
import hmac
import json
import uuid
import platform
import os
from typing import Optional


def generate_device_key() -> str:
    """Generate a unique device key based on hardware identifiers.

    Combines platform-specific hardware info to create a stable device fingerprint.
    Returns a hex string that remains consistent across reboots on the same hardware.
    """
    components: list[str] = []

    system = platform.system()
    if system == "Windows":
        import subprocess

        try:
            result = subprocess.run(
                ["wmic", "csproduct", "get", "UUID"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            )
            lines = [line.strip() for line in result.stdout.strip().split("\n") if line.strip() and line.strip() != "UUID"]
            if lines:
                components.append(lines[0])
        except Exception:
            pass

        try:
            result = subprocess.run(
                ["wmic", "diskdrive", "get", "SerialNumber"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            )
            lines = [line.strip() for line in result.stdout.strip().split("\n") if line.strip() and line.strip() != "SerialNumber"]
            if lines:
                components.append(lines[0])
        except Exception:
            pass

    elif system == "Linux":
        for path in [
            "/etc/machine-id",
            "/var/lib/dbus/machine-id",
            "/sys/class/dmi/id/product_uuid",
        ]:
            try:
                with open(path, "r") as f:
                    components.append(f.read().strip())
                    break
            except (FileNotFoundError, PermissionError):
                continue

        try:
            with open("/sys/class/net/eth0/address", "r") as f:
                components.append(f.read().strip())
        except (FileNotFoundError, PermissionError):
            pass

    elif system == "Darwin":
        import subprocess

        try:
            result = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in result.stdout.split("\n"):
                if "IOPlatformUUID" in line:
                    uuid_str = line.split('"')[-2]
                    components.append(uuid_str)
                    break
        except Exception:
            pass

    if not components:
        components.append(str(uuid.getnode()))

    combined = "|".join(components)
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


def sign_request(data: dict, secret: str) -> str:
    """Create an HMAC-SHA256 signature for request data.

    Args:
        data: The dictionary to sign.
        secret: The shared secret key.

    Returns:
        Hex-encoded HMAC-SHA256 signature string.
    """
    payload = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hmac.new(
        secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_response(response_data: dict, signature: str, secret: str) -> bool:
    """Verify a server response signature.

    Args:
        response_data: The response dictionary to verify.
        signature: The HMAC-SHA256 signature to check against.
        secret: The shared secret key.

    Returns:
        True if the signature is valid, False otherwise.
    """
    expected = sign_request(response_data, secret)
    return hmac.compare_digest(expected, signature)
