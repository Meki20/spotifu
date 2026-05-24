def test_health(client):
    r = client.get("/health")
    assert r.json() == {"status": "ok"}


def test_health_ready_includes_db(client):
    r = client.get("/health/ready")
    assert r.status_code == 200
    b = r.json()
    assert "ready" in b
    assert b["ready"] in (True, False)
