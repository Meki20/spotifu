"""mDNS service registration for LAN discovery (_spotifu._tcp.local)."""

from __future__ import annotations

import logging
import os
import socket
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from zeroconf import ServiceInfo, Zeroconf

logger = logging.getLogger(__name__)

_service: ServiceInfo | None = None
_zeroconf: Zeroconf | None = None


def _is_docker() -> bool:
    return os.path.exists("/.dockerenv")


def _mdns_enabled() -> bool:
    val = os.environ.get("MDNS_ENABLED", "").strip().lower()
    if val in ("0", "false", "no", "off"):
        return False
    if val in ("1", "true", "yes", "on"):
        return True
    return not _is_docker()


def _get_local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def start_mdns() -> None:
    global _service, _zeroconf

    if not _mdns_enabled():
        logger.info("mDNS registration disabled")
        return

    try:
        from zeroconf import ServiceInfo, Zeroconf
    except ImportError:
        logger.warning("zeroconf not installed; mDNS disabled")
        return

    hostname = os.environ.get("MDNS_HOSTNAME", "spotifu").strip() or "spotifu"
    port = int(os.environ.get("MDNS_PORT", "1985"))
    local_ip = _get_local_ip()

    properties = {
        "version": "1",
        "api_path": "/",
    }

    try:
        _zeroconf = Zeroconf()
        _service = ServiceInfo(
            "_spotifu._tcp.local.",
            f"{hostname}._spotifu._tcp.local.",
            addresses=[socket.inet_aton(local_ip)],
            port=port,
            properties={k: str(v).encode("utf-8") for k, v in properties.items()},
            server=f"{hostname}.local.",
        )
        _zeroconf.register_service(_service)
        logger.info(
            "Registered mDNS service %s._spotifu._tcp.local. at %s:%s",
            hostname,
            local_ip,
            port,
        )
    except Exception:
        logger.exception("Failed to register mDNS service")
        stop_mdns()


def stop_mdns() -> None:
    global _service, _zeroconf

    if _zeroconf is not None and _service is not None:
        try:
            _zeroconf.unregister_service(_service)
        except Exception as e:
            logger.warning("mDNS unregister failed: %s", e)
    if _zeroconf is not None:
        try:
            _zeroconf.close()
        except Exception as e:
            logger.warning("mDNS close failed: %s", e)
    _service = None
    _zeroconf = None
