"""Shared rate limiter for SpotiFU. Uses client IP as key."""
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
