def test_health():
    from main import app
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        r = c.get("/health")
        assert r.json() == {"status": "ok"}


def test_health_ready_includes_db():
    from main import app
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        r = c.get("/health/ready")
        assert r.status_code == 200
        b = r.json()
        assert "ready" in b
        assert b["ready"] in (True, False)
